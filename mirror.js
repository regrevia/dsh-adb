/**
 * dsh-adb · 实时镜像：把设备画面低帧率镜像到右侧栏，人手能直接点，
 * 也能画个圈把「这段」连同坐标推回聊天。
 *
 * 数据通路（全部在本机，不经过任何外部服务）：
 *   截图续帧：3 张 exec-out screencap -p 并发 → 一条常驻 ffmpeg 转 JPEG
 *     └─ MJPEG → 侧栏 <img> 直播（实测 4–6 帧/秒，转码 16ms/帧）
 *   分段录制：设备上 10s 一段 mp4 → 拉回本机，只留最近 18 段（约 3 分钟）
 *
 * 屏幕静止时 MIUI 的 screenrecord 几乎不出帧（实测 8s 只出 1 帧），所以直播
 * 由截图续帧，录制走分段文件；要看逐像素外观仍然走 adb_shot。
 * 没人看的时候一张都不抓，侧栏关掉就完全不动。
 *
 * @module dsh-adb/mirror
 */

import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { LiveStream, packFrame } from './stream.js?v=137'

/** 客户端与宿主共用的路由前缀。 */
export const ROUTE = '/dsh-adb'

/** 最近一次标注里动效拼图的字节数，0 表示没凑够帧。 */
let lastStripBytes = 0

const diag = []
const clients = new Map()

let wantSession = ''
let wantAt = 0
let wantTitle = ''

/** 对外报的直播帧率：实测 4–5 帧/秒，够看清操作反馈。 */
const LIVE_FPS = 3
/** 往外送帧的节奏：并发截图是一股一股完成的，按固定节拍取最新一帧才顺。 */
const PUSH_TICK_MS = 200
/** 同时在飞的截图数：单张约 0.65s，3 张并发实测 4 帧/秒以上。 */
const CAPTURE_PARALLEL = 2

/** 环形缓冲：10 秒一段，留 18 段 ≈ 3 分钟，超出的由 ffmpeg 自己覆盖。 */
const SEGMENT_SECONDS = 10
const SEGMENT_KEEP = 18

/** 一次注入最多带的图：PNG 原图 base64 后可能很大，超过就不注入。 */
const MAX_INJECT_BYTES = 8 * 1024 * 1024

/** 找 ffmpeg：DSH 进程的 PATH 未必带 Homebrew。 */
function pickFfmpeg(name = 'ffmpeg') {
  const env = name === 'ffmpeg' ? process.env.FFMPEG : process.env.FFPROBE
  if (env) return env
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
    const candidate = `${dir}/${name}`
    if (existsSync(candidate)) return candidate
  }
  return name
}

/** 开发探针（/dev/mse、/sessions）只在明确打开时挂上，发布版不暴露。 */
const DEV = process.env.DSH_ADB_DEV === '1'

const FFMPEG = pickFfmpeg()
const FFPROBE = pickFfmpeg('ffprobe')

/** 问 ffprobe 一段 mp4 有多长。 @param {string} file - 本地路径。 @returns {Promise<number>} 秒；读不到时 0。 */
function probeDuration(file) {
  return new Promise((resolve) => {
    const child = spawn(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(0))
    child.on('close', () => resolve(Number(out.trim()) || 0))
  })
}

/** 抽某一时刻的一帧 JPEG（宽 300），拼图用。 @returns {Promise<Buffer | null>} */
function grabFrameAt(file, at) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, ['-v', 'error', '-ss', at.toFixed(3), '-i', file, '-frames:v', '1',
      '-vf', 'scale=-2:300', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'])
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.on('error', () => resolve(null))
    child.on('close', () => resolve(chunks.length > 0 ? Buffer.concat(chunks) : null))
  })
}

/** 问视频画面的原始宽高（像素）。 @returns {Promise<{ w: number, h: number } | null>} */
function probeVideoSize(file) {
  return new Promise((resolve) => {
    const child = spawn(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const [w, h] = out.trim().split(',').map((each) => Number(each))
      resolve(Number(w) > 0 && Number(h) > 0 ? { w: Number(w), h: Number(h) } : null)
    })
  })
}

/**
 * 按固定帧率把一段录像的末尾抽成灰度帧：动效量化要比对像素，不看 JPEG。
 * @param {string} file - 本地 mp4。
 * @param {number} seconds - 取末尾多少秒。
 * @param {number} fps - 抽帧帧率。
 * @param {{ x: number, y: number, w: number, h: number } | null} region - 只看这一块（原始像素坐标）。
 * @returns {Promise<{ w: number, h: number, bytes: Buffer[] } | null>} 抽不到时 null。
 */
async function grayFrames(file, seconds, fps, region) {
  const size = await probeVideoSize(file)
  if (size === null) return null
  const width = Math.min(320, Math.max(120, Math.round(size.w / 4)))
  const scaled = Math.max(2, Math.round((width * size.h) / size.w / 2) * 2)
  const filters = []
  if (region !== null && region.w > 0 && region.h > 0) filters.push('crop=' + region.w + ':' + region.h + ':' + region.x + ':' + region.y)
  filters.push('fps=' + fps)
  filters.push('scale=' + width + ':' + scaled)
  const frames = await new Promise((resolve) => {
    const child = spawn(FFMPEG, ['-v', 'error', '-sseof', '-' + Math.max(1, seconds).toFixed(2), '-i', file,
      '-vf', filters.join(','), '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'])
    const chunks = []
    let total = 0
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk)
      total += chunk.length
      if (total > 64 * 1024 * 1024) child.kill('SIGKILL')
    })
    child.on('error', () => resolve(null))
    child.on('close', () => resolve(chunks.length > 0 ? Buffer.concat(chunks) : null))
  })
  if (frames === null) return null
  const frameBytes = width * scaled
  if (frameBytes <= 0) return null
  const count = Math.floor(frames.length / frameBytes)
  if (count < 2) return null
  const picked = []
  for (let index = 0; index < count; index += 1) picked.push(frames.subarray(index * frameBytes, (index + 1) * frameBytes))
  return { w: width, h: scaled, bytes: picked }
}

/** 6 帧 JPEG 拼成 3×2 的 PNG。 @returns {Promise<Buffer | null>} */
function tileFrames(picks) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, ['-v', 'error', '-f', 'image2pipe', '-framerate', '1', '-c:v', 'mjpeg', '-i', 'pipe:0',
      '-vf', 'scale=-2:300,tile=3x2:padding=6:color=0x222222', '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'])
    const chunks = []
    let settled = false
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.on('error', () => { if (!settled) { settled = true; resolve(null) } })
    child.on('close', () => { if (!settled) { settled = true; resolve(chunks.length > 0 ? Buffer.concat(chunks) : null) } })
    for (const jpeg of picks.slice(0, 6)) child.stdin.write(jpeg)
    child.stdin.end()
  })
}

/** 环形缓冲落盘位置：本机私有目录，不随工作区进版本库。 */
const ROOT = join(homedir(), '.dsh', 'adb-mirror')

/**
 * 从 JPEG 头里读出宽高：SOFn 段里 高 2 字节 + 宽 2 字节。
 * @param {Buffer} jpeg - 一帧。
 * @returns {{ w: number, h: number } | null} 宽高，读不出时 null。
 */
/** 从 JPEG 头里读宽高，工具层复用侧栏帧时要用。 */
export function frameSize(jpeg) {
  let at = 2
  while (at + 9 < jpeg.length) {
    if (jpeg[at] !== 0xff) return null
    const marker = jpeg[at + 1]
    const length = jpeg.readUInt16BE(at + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: jpeg.readUInt16BE(at + 5), w: jpeg.readUInt16BE(at + 7) }
    }
    at += 2 + length
  }
  return null
}

/**
 * 一台设备的镜像：屏幕录制 + 转码 + 观看者。
 */
/** PNG 文件头。 */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** JPEG 文件头。 */
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff])

/** 设备端截图落点：同一台设备只留一份，覆盖写。 */
const LIVE_SHOT = '/data/local/tmp/.dsh-adb-live.jpg'

/* 页面代码的版本号：写在 client.rev 里。页面拿 /state 的 build 和自己带的对一下，
   不一致就自己重载，省掉「改一次客户端就要人按一次刷新」。 */
const CLIENT_BUILD = (() => {
  try {
    return String(readFileSync(new URL('./client.rev', import.meta.url), 'utf8')).trim()
  } catch {
    return ''
  }
})()

/**
 * 一张 PNG 转成 JPEG：/live 走 MJPEG，帧只能是 JPEG。
 * @param {Buffer} png - PNG 数据。
 * @returns {Promise<Buffer | null>} JPEG，失败时 null。
 */
function pngToJpeg(png) {
  /* 输入可能是 PNG 也可能是设备端直出的 JPEG（`screencap -j`）：按头判断，别写死。 */
  const isJpeg = png.subarray(0, 3).equals(JPEG_SIG)
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', isJpeg ? 'mjpeg' : 'png_pipe', '-i', 'pipe:0',
      '-vf', 'scale=1024:-2:flags=fast_bilinear', '-q:v', '8', '-f', 'mjpeg', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'ignore'] })
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.on('error', () => resolve(null))
    child.on('close', () => {
      const out = Buffer.concat(chunks)
      resolve(out.length > 1000 ? out : null)
    })
    child.stdin.on('error', () => {})
    child.stdin.end(png)
  })
}

/**
 * 往一个 MJPEG 连接写一帧。
 * @param {import('node:http').ServerResponse} res - 连接。
 * @param {Buffer} frame - JPEG。
 * @param {() => void} drop - 断开时摘掉。
 * @returns {void}
 */
function writeFrame(res, frame, drop) {
  try {
    res.write(`--frame\r\ncontent-type: image/jpeg\r\ncontent-length: ${frame.length}\r\n\r\n`)
    res.write(frame)
    res.write('\r\n')
  } catch {
    drop()
  }
}

export class Mirror {
  /**
   * @param {string} serial - 设备序列号。
   * @param {(args: string[], options?: object) => Promise<{ ok: boolean, out: Buffer, err: string }>} adb - adb 调用器。
   */
  constructor(serial, adb) {
    this.serial = serial
    this.adb = adb
    this.frames = 0
    this.latest = null
    this.latestAt = 0
    this.width = 0
    this.height = 0
    this.watchers = new Set()
    this.lastWatchAt = 0
    this.dropped = 0
    this.seq = 0
    this.waiters = []
    this.grabMs = 0
    this.recording = false
    this.stopping = false
    this.startedAt = 0
    this.error = ''
    this.dir = join(ROOT, serial.replace(/[^\w.-]/g, '_'))
    this.lastPushAt = 0
    this.timer = null
    this.pushTimer = null
    this.sentAt = 0
    this.pushed = 0
    this.inflight = 0
    this.idleSince = 0
    this.snapping = false
    this.seen = []
    this.recent = []
    this.screen = { w: 0, h: 0 }
    this.physical = { w: 0, h: 0 }
    this.frameSize = { w: 0, h: 0 }
  }

  /** 起抓帧泵与分段录制；重复调用无副作用。 @returns {Promise<void>} 起好了。 */
  /**
   * 有没有人在看：常连的 MJPEG 观看者，或 6 秒内来拉过单帧的面板。
   * @returns {boolean} 有观看者（或刚有人来看）为真。
   */
  anyoneWatching() {
    return this.watchers.size > 0 || Date.now() - this.lastWatchAt < 6000
  }

  async start() {
    if (this.timer !== null || this.stopping) return
    await mkdir(this.dir, { recursive: true })
    this.startedAt = Date.now()
    this.error = ''
    const size = await this.adb(['-s', this.serial, 'shell', 'wm', 'size'], { timeout: 6000 })
    const found = /(\d+)x(\d+)/.exec(String(size.out ?? ''))
    if (found !== null) this.physical = { w: Number(found[1]), h: Number(found[2]) }
    await this.snapshot()
    this.alignScreen()
    this.timer = setInterval(() => this.pump(), 200)
    this.timer.unref?.()
    this.pushTimer = setInterval(() => this.push(), PUSH_TICK_MS)
    this.pushTimer.unref?.()
    void this.startRecorder()
  }

  /**
   * `wm size` 报的是竖屏的物理尺寸（2136x3200），实际画面是横屏 3200x2136；
   * 标注/点按都按 screen 换算，方向错了就会整体偏到左上角。按真实画面的横竖对齐一次。
   * @returns {void}
   */
  alignScreen() {
    const raw = this.physical
    const frame = this.frameSize
    if (raw.w < 1 || raw.h < 1 || frame.w < 1 || frame.h < 1) return
    const short = Math.min(raw.w, raw.h)
    const long = Math.max(raw.w, raw.h)
    const landscape = frame.w > frame.h
    this.screen = landscape ? { w: long, h: short } : { w: short, h: long }
  }

  /** 有人在看才抓帧；没人看就空转并顺手关掉转码进程。 @returns {void} */
  pump() {
    if (this.stopping) return
    if (!this.anyoneWatching()) {
      if (this.inflight === 0) {
        if (this.idleSince === 0) this.idleSince = Date.now()
      }
      return
    }
    this.idleSince = 0
    /* 每个节拍最多补一张，让 3 张在飞时错开完成，画面才匀。 */
    if (this.inflight < CAPTURE_PARALLEL) {
      this.inflight += 1
      void this.grab().finally(() => { this.inflight -= 1 })
    }
  }

  /**
   * 转出一帧：记最新帧、实测帧率，推给观看者。
   * @param {Buffer} frame - JPEG。
   * @returns {void}
   */
  accept(frame) {
    const dims = frameSize(frame)
    if (dims !== null) this.frameSize = dims
    const at = Date.now()
    this.latest = frame
    this.latestAt = at
    this.alignScreen()
    this.frames += 1
    this.seen.push(at)
    if (this.seen.length > 40) this.seen.shift()
    this.recent.push({ at, jpeg: frame })
    if (this.recent.length > 40) this.recent.shift()
    this.seq += 1
    if (this.waiters.length > 0) {
      const pending = this.waiters
      this.waiters = []
      for (const wake of pending) wake()
    }
  }

  /**
   * 等到比 `since` 更新的一帧：画面一动就回，最多等 `ms`。
   * 客户端拿它做长轮询，省掉固定间隔的空转，延迟只剩「抓一帧」的时间。
   * @param {number} since - 客户端已有的帧序号。
   * @param {number} ms - 最长等待毫秒。
   * @returns {Promise<Buffer | null>} JPEG，没等到时 null。
   */
  nextFrame(since, ms) {
    if (this.seq > since && this.latest !== null) return Promise.resolve(this.latest)
    return new Promise((resolve) => {
      let done = false
      const finish = (frame) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.waiters = this.waiters.filter((each) => each !== wake)
        resolve(frame)
      }
      const wake = () => finish(this.latest)
      const timer = setTimeout(() => finish(null), ms)
      this.waiters.push(wake)
    })
  }

  /**
   * 把最近几秒的画面抽成一张 3×2 拼图：动效问题（桌宠变大变小、位移）单帧看不出来，
   * 序列帧一眼就能看出哪一帧比例不对。
   * @param {number} seconds - 回看多少秒。
   * @returns {Promise<Buffer | null>} PNG；不够帧时 null。
   */
  async recentStrip(seconds = 6) {
    if (this.recent.length < 3) return this.recentStripFromDisk(seconds)
    const newest = this.recent[this.recent.length - 1].at
    const picks = []
    for (let index = 5; index >= 0; index -= 1) {
      const target = newest - (index * seconds * 1000) / 6
      let best = null
      for (const item of this.recent) {
        if (item.at <= target + 350) best = item
      }
      if (best !== null && (picks.length === 0 || picks[picks.length - 1] !== best.jpeg)) picks.push(best.jpeg)
    }
    if (picks.length < 3) return null
    while (picks.length < 6) picks.push(picks[picks.length - 1])
    const strip = await new Promise((resolve) => {
      const child = spawn(FFMPEG, ['-v', 'error', '-f', 'image2pipe', '-framerate', '1', '-c:v', 'mjpeg', '-i', 'pipe:0',
        '-vf', 'scale=-2:300,tile=3x2:padding=6:color=0x222222', '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'])
      const chunks = []
      let settled = false
      child.stdout.on('data', (chunk) => chunks.push(chunk))
      child.on('error', () => { if (!settled) { settled = true; resolve(null) } })
      child.on('close', () => { if (!settled) { settled = true; resolve(chunks.length > 0 ? Buffer.concat(chunks) : null) } })
      for (const jpeg of picks.slice(0, 6)) child.stdin.write(jpeg)
      child.stdin.end()
    })
    return strip
  }

  /**
   * 没人看直播时内存里没有帧，但本地环形录像一直在跑：直接从最近一段录像里抽帧拼图。
   * 「刚才我点了两下，桌宠变大不对劲」这种事后回看走这条路。
   * @param {number} seconds - 回看多少秒。
   * @returns {Promise<Buffer | null>} PNG 拼图；抽不到时 null。
   */
  /**
   * 从最近一段磁盘录像里抽帧拼图（没人看直播时的兜底）。
   * @param {number} seconds - 回看多少秒。
   * @returns {Promise<Buffer | null>} PNG 拼图；抽不到时 null。
   */
  async recentStripFromDisk(seconds = 6) {
    const list = await this.segments()
    if (list.length === 0) return null
    for (const item of list.slice(-2).reverse()) {
      const strip = await this.stripFromFile(join(this.dir, item.segment), seconds)
      if (strip !== null) return strip
    }
    return null
  }

  /**
   * 从一段录像的末尾抽帧拼成 3×2 PNG。
   * @param {string} file - 本地 mp4。
   * @param {number} seconds - 取末尾多少秒。
   * @returns {Promise<Buffer | null>} PNG；抽不到时 null。
   */
  async stripFromFile(file, seconds = 6) {
    /* 段是 screenrecord 产物：末尾那段可能还在写，先问时长再定窗口。 */
    const duration = await probeDuration(file)
    if (!(duration > 0.6)) return null
    const window = Math.min(seconds, duration)
    const step = window / 6
    const picks = []
    for (let index = 0; index < 6; index += 1) {
      const at = Math.max(0, duration - window + (index * step))
      const jpeg = await grabFrameAt(file, at)
      if (jpeg === null) break
      picks.push(jpeg)
    }
    if (picks.length < 3) return null
    while (picks.length < 6) picks.push(picks[picks.length - 1])
    return tileFrames(picks)
  }

  /**
   * 磁盘上最近一段录像有多旧：超过宽限就不能再拿它充「近几秒」。
   * @returns {Promise<number>} 毫秒；一段都没有时 Infinity。
   */
  async segmentAge() {
    const list = await this.segments()
    if (list.length === 0) return Number.POSITIVE_INFINITY
    return Math.max(0, Date.now() - list[list.length - 1].at)
  }

  /**
   * 现场录一小段再拉回本机：绕开大文件、秒级出结果，代价是这条命令本身要跑满时长。
   * @param {number} seconds - 录几秒（2–12）。
   * @returns {Promise<string | null>} 本地 mp4 路径；起不来时 null（例如直播正占着编码器）。
   */
  async captureBurst(seconds = 4) {
    const span = Math.min(12, Math.max(2, Math.round(seconds)))
    const remote = `/sdcard/dsh-burst-${this.serial.replace(/[^\w.-]/g, '_')}.mp4`
    const began = Date.now()
    const t0 = Date.now()
    const recorded = await this.adb([
      '-s', this.serial, 'shell', 'screenrecord',
      '--time-limit', String(span), '--bit-rate', '2000000', '--size', '960x640', remote,
    ], { timeout: (span + 15) * 1000, direct: true }).catch(() => null)
    if (!recorded || !recorded.ok) return null
    const t1 = Date.now()
    const pulled = await this.adb(['-s', this.serial, 'exec-out', 'cat', remote], { timeout: 60_000, direct: true }).catch(() => null)
    const t2 = Date.now()
    await this.adb(['-s', this.serial, 'shell', 'rm', '-f', remote], { timeout: 8000 }).catch(() => {})
    if (!pulled || !pulled.ok || !Buffer.isBuffer(pulled.raw) || pulled.raw.length < 4096) return null
    const file = join(this.dir, `burst-${began}.mp4`)
    await writeFile(file, pulled.raw).catch(() => null)
    this.lastBurstTiming = { record_ms: t1 - t0, pull_ms: t2 - t1 }
    return existsSync(file) ? file : null
  }

  /**
   * 取一段「刚刚」的录像文件给逐像素分析用：磁盘段够新就白用，不够新就现场录。
   * @param {number} seconds - 需要多长。
   * @returns {Promise<{ file: string, source: 'disk' | 'burst', ageMs: number, temp: boolean } | null>}
   */
  async recentClip(seconds = 4, force = false) {
    const list = await this.segments()
    if (list.length > 0 && !force) {
      const last = list[list.length - 1]
      const age = Math.max(0, Date.now() - last.at)
      const file = join(this.dir, last.segment)
      const duration = await probeDuration(file)
      if (age < 15_000 && duration >= Math.min(seconds, 1)) return { file, source: 'disk', ageMs: age, temp: false }
    }
    const burst = await this.captureBurst(seconds + 1)
    if (burst !== null) return { file: burst, source: 'burst', ageMs: 0, temp: true }
    if (list.length === 0) return null
    const last = list[list.length - 1]
    return { file: join(this.dir, last.segment), source: 'disk', ageMs: Math.max(0, Date.now() - last.at), temp: false }
  }

  /**
   * 逐像素动效时间线：每帧相对上一帧变了多大、变在哪、抖了几下、多久稳住。
   * 桌宠、悬浮窗、自绘动画在控件树里看不见，只能这样量。
   * @param {object} options - seconds / fps / region / threshold。
   * @returns {Promise<object | null>} 指标与逐帧序列。
   */
  async motionTimeline(options = {}) {
    const seconds = Math.min(12, Math.max(2, Number(options.seconds ?? 4)))
    const fps = Math.min(10, Math.max(2, Number(options.fps ?? 8)))
    const threshold = Math.min(64, Math.max(2, Number(options.threshold ?? 12)))
    const region = options.region ?? null
    const clip = await this.recentClip(seconds, options.force === true)
    if (clip === null) return null
    try {
      const gray = await grayFrames(clip.file, seconds, fps, region)
      if (gray === null) return null
      const scale = region !== null && region.w > 0 ? region.w / gray.w : null
      const size = await probeVideoSize(clip.file)
      const factor = scale ?? (size === null ? 1 : size.w / gray.w)
      const frames = []
      const series = []
      for (let index = 1; index < gray.bytes.length; index += 1) {
        const before = gray.bytes[index - 1]
        const after = gray.bytes[index]
        let changed = 0
        let minX = gray.w
        let minY = gray.h
        let maxX = -1
        let maxY = -1
        for (let at = 0; at < after.length; at += 1) {
          if (Math.abs(after[at] - before[at]) <= threshold) continue
          changed += 1
          const x = at % gray.w
          const y = (at - x) / gray.w
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
        const boxed = maxX >= minX && maxY >= minY
        const box = boxed
          ? { x: Math.round(minX * factor), y: Math.round(minY * factor), w: Math.round((maxX - minX + 1) * factor), h: Math.round((maxY - minY + 1) * factor) }
          : { x: 0, y: 0, w: 0, h: 0 }
        const frame = {
          t: Math.round((index / fps) * 1000),
          changed_pct: Number(((changed / after.length) * 100).toFixed(2)),
          box,
        }
        frames.push(frame)
        series.push(box.w === 0 && box.h === 0 ? 0 : Math.round(Math.sqrt((box.w * box.w) + (box.h * box.h))))
      }
      const peak = Math.max(...series, 0)
      const tail = series.length > 0 ? series[series.length - 1] : 0
      let jitter = 0
      let previousSign = 0
      let biggestStep = 0
      let biggestStepAt = 0
      for (let index = 1; index < series.length; index += 1) {
        const delta = series[index] - series[index - 1]
        if (Math.abs(delta) >= Math.max(2, peak * 0.08)) {
          const sign = Math.sign(delta)
          if (previousSign !== 0 && sign !== previousSign) jitter += 1
          previousSign = sign
        }
        if (Math.abs(delta) > biggestStep) { biggestStep = Math.abs(delta); biggestStepAt = index }
      }
      let settleMs = 0
      if (peak > 0) {
        const calmAt = series.findIndex((value, index) => index > 1 && Math.abs(value - tail) <= Math.max(2, peak * 0.06))
        settleMs = calmAt > 0 ? Math.round(((calmAt - biggestStepAt) / fps) * 1000) : 0
        if (settleMs < 0) settleMs = 0
      }
      return {
        source: clip.source,
        age_ms: clip.ageMs,
        record_ms: this.lastBurstTiming?.record_ms ?? 0,
        pull_ms: this.lastBurstTiming?.pull_ms ?? 0,
        fps,
        frames: frames.length,
        device: size === null ? null : { w: size.w, h: size.h },
        peak_size_px: peak,
        tail_size_px: tail,
        overshoot_pct: tail > 0 ? Number((((peak - tail) / tail) * 100).toFixed(1)) : 0,
        biggest_step_px: biggestStep,
        biggest_step_at_ms: Math.round(((biggestStepAt + 1) / fps) * 1000),
        jitter,
        settle_ms: settleMs,
        series,
        timeline: frames,
      }
    } finally {
      if (clip.temp) await rm(clip.file, { force: true }).catch(() => {})
    }
  }

  /**
   * 「刚才那几秒」：优先真近的帧，并如实交代来源——内存直播帧 / 近 25 秒的磁盘段 / 现场现录。
   * 之前它可能拿几分钟前的旧段拼图，看着像回看其实是旧的，这里把这件事钉死。
   * @param {number} seconds - 回看多少秒。
   * @returns {Promise<{ png: Buffer, source: 'live' | 'burst' | 'disk', ageMs: number } | null>}
   */
  async recentStripWithSource(seconds = 6) {
    const newest = this.recent.length > 0 ? this.recent[this.recent.length - 1].at : 0
    if (newest > 0 && Date.now() - newest < 8000) {
      const png = await this.recentStrip(seconds)
      if (png !== null) return { png, source: 'live', ageMs: 0 }
    }
    const age = await this.segmentAge()
    if (!Number.isFinite(age) || age > 25_000) {
      const file = await this.captureBurst(seconds)
      if (file !== null) {
        const png = await this.stripFromFile(file, seconds + 0.5)
        await rm(file, { force: true }).catch(() => {})
        if (png !== null) return { png, source: 'burst', ageMs: 0 }
      }
    }
    const png = await this.recentStripFromDisk(seconds)
    return png === null ? null : { png, source: 'disk', ageMs: age }
  }

  /**
   * 抓一张当前画面当最新帧：屏幕静止时编码器不出帧，靠它兜底。
   * @returns {Promise<Buffer | null>} JPEG，抓不到时 null。
   */
  async snapshot() {
    if (this.snapping) return null
    this.snapping = true
    try {
      return await this.grab()
    } finally {
      this.snapping = false
    }
  }

  /**
   * 抓一张并写进最新帧。
   * @returns {Promise<Buffer | null>} JPEG，抓不到时 null。
   */
  async grab() {
    const began = Date.now()
    const frame0 = await this.grabOnce()
    this.grabMs = Date.now() - began
    return frame0
  }

  /**
   * 抓一张原始实现，`grab` 只在外层记耗时。
   * @returns {Promise<Buffer | null>} JPEG。
   */
  async grabOnce() {
    /* 设备端直出 JPEG 再 cat：0.36 s / 3.5 MB，比 `exec-out screencap -p`（3 s / 8.5 MB）
       快一个量级。两件事塞进一次 exec-out，省一个 adb 往返。 */
    let image = null
    try {
      /* JPEG 直接写 stdout：不再落临时文件，也就没有两张并发抢同一个文件、cat 到半截
         图像（画面突然一大块颜色就是这么来的）。一次 adb 往返，3.5 MB。 */
      const shot = await this.adb(['-s', this.serial, 'exec-out', 'sh', '-c',
        'screencap -j /dev/stdout 2>/dev/null'], { timeout: 6_000 })
      const raw = shot?.raw
      if (Buffer.isBuffer(raw) && raw.length > 2_000) {
        const at = raw.indexOf(JPEG_SIG)
        if (at >= 0) {
          const jpeg = raw.subarray(at)
          /* 只收完整帧：结尾缺 EOI 就是被截断的图，画上去就是色块。 */
          if (jpeg.length > 2_000 && jpeg.subarray(-2).equals(Buffer.from([0xff, 0xd9]))) image = jpeg
          else this.dropped += 1
        }
      }
    } catch { /* 老系统没有 screencap -j，走下面的 PNG 回退 */ }
    if (image === null) {
      let shot
      try {
        shot = await this.adb(['-s', this.serial, 'exec-out', 'screencap', '-p'], { timeout: 12_000 })
      } catch {
        return null
      }
      const raw = shot?.raw
      if (!Buffer.isBuffer(raw) || raw.length < 1000) return null
      const png = raw.indexOf(PNG_SIG)
      if (png < 0) return null
      image = raw.subarray(png)
    }
    const frame = await pngToJpeg(image)
    if (frame === null) return null
    this.accept(frame)
    return frame
  }

  /**
   * 循环分段录制：设备上录 10s 一段，拉回本机，只留最近 18 段。
   * @returns {Promise<void>} 停了才返回。
   */
  async startRecorder() {
    if (this.recording || this.stopping) return
    this.recording = true
    const remote = `/sdcard/dsh-${this.serial.replace(/[^\w.-]/g, '_')}.mp4`
    while (!this.stopping) {
      const started = Date.now()
      const recorded = await this.adb([
        '-s', this.serial, 'shell', 'screenrecord',
        '--time-limit', String(SEGMENT_SECONDS),
        '--bit-rate', '2000000', '--size', '960x640', remote,
      ], { timeout: (SEGMENT_SECONDS + 20) * 1000, direct: true })
      if (this.stopping) break
      if (!recorded.ok) {
        this.error = recorded.err.trim().slice(0, 200) || '录制失败'
        await new Promise((resolve) => setTimeout(resolve, 1500))
        continue
      }
      const pulled = await this.adb(['-s', this.serial, 'exec-out', 'cat', remote], { timeout: 60_000, direct: true })
      await this.adb(['-s', this.serial, 'shell', 'rm', '-f', remote], { timeout: 8000 })
      const bytes = pulled.raw
      if (pulled.ok && Buffer.isBuffer(bytes) && bytes.length > 2048) {
        const name = `seg-${started}.mp4`
        await writeFile(join(this.dir, name), bytes).catch(() => {})
        this.error = ''
        void this.rotate()
      } else {
        this.error = '这一段没录到画面'
      }
      const spent = Date.now() - started
      if (spent < SEGMENT_SECONDS * 1000) await new Promise((resolve) => setTimeout(resolve, Math.max(0, 400 - spent)))
    }
    this.recording = false
  }

  /** 本机只留最近 18 段（约 3 分钟）。 @returns {Promise<void>} 删完。 */
  async rotate() {
    try {
      const names = (await readdir(this.dir)).filter((name) => name.startsWith('seg-') && name.endsWith('.mp4')).sort()
      const extra = names.slice(0, Math.max(0, names.length - SEGMENT_KEEP))
      for (const name of extra) await rm(join(this.dir, name), { force: true }).catch(() => {})
    } catch {
      /* 目录还没建好 */
    }
  }

  /** @returns {number} 最近几秒的实测帧率，一位小数。 */
  measuredFps() {
    if (this.seen.length < 2) return 0
    const span = this.seen[this.seen.length - 1] - this.seen[0]
    if (span <= 0) return 0
    return Math.round(((this.seen.length - 1) / span) * 1000 * 10) / 10
  }

  /**
   * 按固定节拍把最新一帧写给所有观看者。截图是一股一股完成的，
   * 只在有新帧时才送会把画面卡成 1–2 帧/秒，所以按节拍原样重发。
   * @returns {void}
   */
  push() {
    if (!this.anyoneWatching() || this.latest === null) return
    this.sentAt = this.latestAt
    this.pushed += 1
    const frame = this.latest
    for (const res of this.watchers) writeFrame(res, frame, () => this.watchers.delete(res))
  }

  /**
   * 等第一帧出现。
   * @param {number} ms - 上限。
   * @returns {Promise<Buffer | null>} 帧，或 null。
   */
  async firstFrame(ms = 4000) {
    const deadline = Date.now() + ms
    while (this.latest === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    return this.latest
  }

  /** 停掉两条子进程并断开观看者。 @returns {void} */
  stop() {
    this.stopping = true
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    if (this.pushTimer !== null) clearInterval(this.pushTimer)
    this.pushTimer = null
    for (const res of this.watchers) {
      try { res.end() } catch { /* 已经断了 */ }
    }
    this.watchers.clear()
    void this.adb(['-s', this.serial, 'shell', 'rm', '-f', `/sdcard/dsh-${this.serial.replace(/[^\w.-]/g, '_')}.mp4`], { timeout: 8000 }).catch(() => {})
  }

  /** @returns {Promise<{ segment: string, bytes: number, at: number }[]>} 环形缓冲里的片段。 */
  async segments() {
    try {
      const names = (await readdir(this.dir)).filter((name) => name.endsWith('.mp4')).sort()
      const out = []
      for (const name of names) {
        const info = await stat(join(this.dir, name))
        out.push({ segment: name, bytes: info.size, at: info.mtimeMs })
      }
      return out
    } catch {
      return []
    }
  }
}

/**
 * 装好镜像能力：HTTP 路由、直播、录制、标注回传。
 * @param {any} ctx - Cordis 上下文。
 * @param {{ adb: any, resolveSerial: () => Promise<string>, uiInRect?: (serial: string, rect: any) => Promise<string[]> }} tools - 宿主已有的能力。
 * @returns {{ open: () => number, status: (serial?: string) => Promise<object>, stopAll: () => void }} 给工具层用的入口。
 */
export function setupMirror(ctx, tools) {
  const mirrors = new Map()
  const events = new Set()
  /** 每台设备的 H.264 推流。 @type {Map<string, LiveStream>} */
  const streams = new Map()

  /**
   * 拿一台设备的镜像，没有就建。
   * @param {string} serial - 序列号。
   * @returns {Mirror} 镜像。
   */
  /**
   * 拿一台设备的持续推流，没有就建。和抓帧的 Mirror 并行，互不影响。
   * @param {string} serial - 序列号。
   * @returns {LiveStream} 推流。
   */
  function streamFor(serial) {
    let stream = streams.get(serial)
    if (stream === undefined) {
      stream = new LiveStream({ serial, adb: tools.adb.path })
      streams.set(serial, stream)
    }
    return stream
  }

  function mirrorFor(serial) {
    let mirror = mirrors.get(serial)
    if (mirror === undefined) {
      mirror = new Mirror(serial, tools.adb)
      mirrors.set(serial, mirror)
    }
    return mirror
  }

  /** 通知所有页面：打开「实时ADB」这一栏。 @returns {number} 通知到几个页面。 */
  function open(sessionId) {
    wantSession = String(sessionId ?? '')
    wantAt = Date.now()
    wantTitle = ''
    /* 标题只用来兜底认窗口：有些窗口是多栏的，mounted 报的是另一栏的会话。 */
    try {
      const listed = ctx.get?.('sessionController')?.list?.()
      void Promise.resolve(listed).then((value) => {
        const bare = wantSession.replace(/^session-/, '')
        const hit = (value?.items ?? []).find((item) => {
          const full = String(item.sessionId)
          return full === wantSession || full.replace(/^session-/, '') === bare || full.endsWith(bare)
        })
        const title = hit?.projections?.values?.title
        if (typeof title === 'string' && title !== '') wantTitle = title
      }).catch(() => {})
    } catch { /* 列不出来就只认 mounted */ }
    let sent = 0
    for (const res of events) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'open', sessionId: sessionId ?? '', at: Date.now() })}\n\n`)
        sent += 1
      } catch {
        events.delete(res)
      }
    }
    return sent
  }

  /**
   * 把标注过的画面推进聊天：人画的圈 + 圈里的控件 + 一句话。
   * @param {{ session: string, note: string, png: string, rect: any, serial: string }} input - 客户端发来的标注。
   * @returns {Promise<{ ok: boolean, reason?: string, bytes: number }>} 结果。
   */
  async function annotate(input) {
    let session = String(input.session ?? '')
    const base64 = String(input.png ?? '')
    const wantsRecent = input.recent === true
    if (session === '') return { ok: false, reason: '缺少会话', bytes: 0 }
    if (base64 === '' && !wantsRecent) return { ok: false, reason: '缺少画面', bytes: 0 }
    const png = base64 === '' ? Buffer.alloc(0) : Buffer.from(base64, 'base64')
    if (png.length === 0 && !wantsRecent) return { ok: false, reason: '画面为空', bytes: 0 }
    if (png.length > MAX_INJECT_BYTES) return { ok: false, reason: `画面超过 ${MAX_INJECT_BYTES / 1024 / 1024}MB`, bytes: png.length }
    /* 会话 id 可能来自工具结果的短形式，宿主认的是 session-<uuid>：按登记表补全，别让一次就对不上的 id 白丢一张标注。 */
    const sessionController = ctx.get?.('sessionController')
    try {
      const items = (await sessionController.list()).items ?? []
      const bare = session.replace(/^session-/, '')
      const known = items.find((item) => String(item.sessionId) === session)
        ?? items.find((item) => String(item.sessionId).replace(/^session-/, '') === bare)
        ?? items.find((item) => String(item.sessionId).endsWith(bare))
      if (known !== undefined) session = String(known.sessionId)
    } catch { /* 列不出来就按原样试一次 */ }
    const controller = ctx.get?.('sessionController')
    const writable = controller?.prompt !== undefined
    const rect = input.rect ?? null
    const lines = []
    const note = String(input.note ?? '').trim()
    if (note !== '') lines.push(note)
    if (rect !== null && Number(rect.w) > 0) {
      lines.push(`圈选区域（设备坐标）：x=${Math.round(rect.x)} y=${Math.round(rect.y)} w=${Math.round(rect.w)} h=${Math.round(rect.h)}`)
    }
    if (tools.uiInRect !== undefined && rect !== null) {
      const inside = await tools.uiInRect(String(input.serial ?? ''), rect).catch(() => [])
      if (inside.length > 0) lines.push(`圈选区域内的控件：\n${inside.join('\n')}`)
    }
    const timeline = typeof tools.recentActions === 'function' ? tools.recentActions(90_000) : []
    if (timeline.length > 0) lines.push(`圈选前的操作（时间倒推）：\n${timeline.join('\n')}`)
    const strip = await mirrorFor(String(input.serial ?? '')).recentStrip(6).catch(() => null)
    lastStripBytes = strip?.length ?? 0
    if (strip !== null) {
      lines.push(`最近 6 秒的画面（每张间隔约 1 秒，左上→右下，看动效比例/位移是否连贯）：`)
    }
    if (!writable) return { ok: false, reason: '会话不在可写入状态', bytes: png.length, strip: strip?.length ?? 0 }
    if (lines.length === 0) lines.push(wantsRecent ? '请看一下最近几秒的画面。' : '标注了一张设备画面。')
    const content = [{ type: 'text', text: lines.join('\n') }]
    if (png.length > 0) content.push({ type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'device-annotated.png' })
    if (strip !== null) content.push({ type: 'image', mediaType: 'image/png', data: strip.toString('base64'), name: 'device-recent-frames.png' })
    try {
      await controller.prompt({
        requestId: `adb-mirror-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionId: session,
        mode: 'queue',
        content,
      }, new AbortController().signal)
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error).slice(0, 200), bytes: png.length }
    }
    if (png.length > 0) {
      /* 发成功才落盘：失败时不留一堆没人看过的标注图。 */
      await mkdir(join(ROOT, 'annotations'), { recursive: true }).catch(() => {})
      await writeFile(join(ROOT, 'annotations', `adb-${Date.now()}.png`), png).catch(() => {})
    }
    return { ok: true, bytes: png.length, strip: strip?.length ?? 0 }
  }

  /**
   * 一次性探针：宿主里会话控制器长什么样、认哪些 id。仅回环，调试用。
   * @returns {Promise<any>} 控制器方法名与已注册会话 id 样本。
   */
  async function sessionProbe() {
    const controller = ctx.get?.('sessionController')
    if (controller === undefined) return { ok: false, reason: '没有 sessionController' }
    const names = []
    let proto = Object.getPrototypeOf(controller)
    while (proto !== null && proto !== Object.prototype && names.length < 60) {
      for (const name of Object.getOwnPropertyNames(proto)) if (!names.includes(name)) names.push(name)
      proto = Object.getPrototypeOf(proto)
    }
    const own = Object.getOwnPropertyNames(controller).slice(0, 40)
    try {
      const agents = controller.agents
      const keys = agents instanceof Map ? [...agents.keys()] : Object.keys(agents ?? {})
      out.agentIds = keys.slice(0, 8)
      out.agentCount = keys.length
    } catch { /* 探不到就算了 */ }
    const out = { ok: true, names, own }
    for (const key of ['list', 'snapshot', 'sessions', 'get', 'states']) {
      try {
        const value = controller[key]
        out[`type:${key}`] = typeof value
        if (typeof value === 'function') {
          const result = await value.call(controller)
          out[`call:${key}`] = JSON.stringify(result).slice(0, 900)
        }
      } catch (error) {
        out[`call:${key}`] = `ERR ${String(error?.message ?? error).slice(0, 120)}`
      }
    }
    return out
  }

  /**
   * 读 JSON 请求体。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {number} limit - 字节上限。
   * @returns {Promise<any>} 解析后的对象。
   */
  function readJson(req, limit = 24 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('请求过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch {
          resolve({})
        }
      })
      req.on('error', reject)
    })
  }

  /**
   * 一条 adb input 命令。
   * @param {string} serial - 设备。
   * @param {string[]} args - input 之后的参数。
   * @returns {Promise<{ ok: boolean, reason?: string }>} 结果。
   */
  async function input(serial, args) {
    const result = await tools.adb(['-s', serial, 'shell', 'input', ...args], { timeout: 8000 })
    if (!result.ok) return { ok: false, reason: result.err.slice(0, 200) || 'adb 执行失败' }
    return { ok: true }
  }

  /**
   * 只认本机回环 + 同源：侧栏页面在 127.0.0.1 直连，别的网页没法借道操设备。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @returns {boolean} 是否放行。
   */
  function isLocal(req) {
    const peer = req.socket?.remoteAddress ?? ''
    if (peer !== '127.0.0.1' && peer !== '::1' && peer !== '::ffff:127.0.0.1') return false
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '')
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') return false
    if (req.method === 'GET' || req.method === 'HEAD') return true
    const origin = String(req.headers.origin ?? '')
    if (origin === '') return req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin'
    try {
      return new URL(origin).host === String(req.headers.host ?? '')
    } catch {
      return false
    }
  }

  /** @param {import('node:http').IncomingMessage} req - 请求。 @param {import('node:http').ServerResponse} res - 响应。 */
  async function handler(req, res) {
    const url = new URL(req.url ?? ROUTE, 'http://dsh.invalid')
    const path = url.pathname.slice(ROUTE.length) || '/'
    const json = (value, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (!isLocal(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }
    try {
      if (path === '/events' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write('retry: 2000\n\n')
        events.add(res)
        res.write(`data: ${JSON.stringify({ type: 'hello', at: Date.now() })}\n\n`)
        const beat = setInterval(() => {
          try { res.write(': beat\n\n') } catch { events.delete(res) }
        }, 15_000)
        beat.unref?.()
        const close = () => {
          clearInterval(beat)
          events.delete(res)
        }
        req.on('close', close)
        res.on('error', close)
        return
      }

      if (path === '/devices' && req.method === 'GET') {
        const serial = await tools.resolveSerial().catch(() => '')
        const list = await tools.adb(['devices'], { timeout: 5000 })
        const rows = String(list.out ?? '')
          .split('\n')
          .slice(1)
          .map((line) => line.trim())
          .filter((line) => line !== '' && line.endsWith('device'))
          .map((line) => line.split(/\s+/)[0])
        return json({ serial, devices: rows })
      }

      if (path === '/live' && req.method === 'GET') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        const mirror = mirrorFor(serial)
        res.writeHead(200, {
          'content-type': 'multipart/x-mixed-replace; boundary=frame',
          'cache-control': 'no-store, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.flushHeaders()
        mirror.watchers.add(res)
        const frame = mirror.latest ?? await mirror.firstFrame(4000)
        if (frame !== null) writeFrame(res, frame, () => mirror.watchers.delete(res))
        void mirror.start()
        const close = () => mirror.watchers.delete(res)
        req.on('close', close)
        res.on('error', close)
        return
      }

      if (path === '/stream' && req.method === 'GET') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        const stream = streamFor(serial)
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store, no-transform',
          'x-accel-buffering': 'no',
          connection: 'keep-alive',
        })
        res.flushHeaders()
        let closed = false
        const unsubscribe = stream.subscribe((bytes) => {
          if (closed) return
          /* 积压超过 2 MB 就断开重连：宁可重连一次，也不要让延迟越滚越大。 */
          if (res.writableLength > 2 << 20) {
            closed = true
            unsubscribe()
            res.destroy()
            return
          }
          res.write(bytes)
        })
        const close = () => {
          if (closed) return
          closed = true
          unsubscribe()
        }
        req.on('close', close)
        res.on('close', close)
        res.on('error', close)
        return
      }

      if (path === '/stream/info' && req.method === 'GET') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        return json(streamFor(serial).info())
      }

      if (path === '/dev/mse' && req.method === 'GET' && DEV === true) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(DEV_MSE_PAGE)
        return
      }
      if (path === '/watching') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        const mirror = mirrorFor(serial)
        mirror.lastWatchAt = Date.now()
        void mirror.start()
        return json({ watching: true })
      }

      if (path === '/frame' && req.method === 'GET') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        const mirror = mirrorFor(serial)
        mirror.lastWatchAt = Date.now()
        void mirror.start()
        const since = Number(url.searchParams.get('since') ?? '') || 0
        const wait = Math.min(2500, Math.max(0, Number(url.searchParams.get('wait') ?? '') || 0))
        let frame = null
        if (wait > 0) {
          if (mirror.seq === 0) frame = await mirror.firstFrame(4000)
          if (frame === null) frame = await mirror.nextFrame(since, wait)
        } else {
          frame = await mirror.firstFrame(4000)
          if (frame !== null && Date.now() - mirror.latestAt > 1200) frame = (await mirror.snapshot()) ?? frame
        }
        if (frame === null) return json({ error: '画面还没起来' }, 503)
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'cache-control': 'no-store',
          'x-adb-seq': String(mirror.seq),
          'x-adb-at': String(mirror.latestAt),
        })
        return res.end(frame)
      }

      if (path === '/state' && req.method === 'GET') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        const mirror = mirrorFor(serial)
        void mirror.start()
        const segments = await mirror.segments()
        return json({
          serial,
          build: CLIENT_BUILD,
          stream: (streams.get(serial) ?? null)?.info() ?? null,
          started: mirror.startedAt,
          frames: mirror.frames,
          fps: mirror.measuredFps(),
          live: mirror.latest !== null,
          watchers: mirror.watchers.size,
          dropped: mirror.dropped,
          grabMs: mirror.grabMs,
          pushed: mirror.pushed,
          screen: mirror.screen,
          frame: mirror.latest === null ? null : { w: mirror.frameSize.w, h: mirror.frameSize.h },
          bytes: mirror.latest?.length ?? 0,
          recent: mirror.recent.length,
          strip: lastStripBytes,
          segments: segments.length,
          bufferedSeconds: segments.length * SEGMENT_SECONDS,
          dir: mirror.dir,
          error: mirror.error,
          pages: events.size,
          want: wantSession,
          clients: [...clients.values()].map(({ pid, at, mounted, title, beat }) => ({ pid, at, mounted, title, beat })),
          diag,
        })
      }

      if (path === '/recent' && req.method === 'GET') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        const mirror = mirrorFor(serial)
        return json({ serial, segments: await mirror.segments(), dir: mirror.dir })
      }

      if (path === '/tap' && req.method === 'POST') {
        const body = await readJson(req)
        const x = String(Math.round(body.x))
        const y = String(Math.round(body.y))
        /* 长按用同点 swipe 顶住 700 ms：input 没有 longpress 子命令。 */
        const args = body.long === true ? ['swipe', x, y, x, y, '700'] : ['tap', x, y]
        return json(await input(String(body.serial ?? ''), args))
      }

      if (path === '/scroll' && req.method === 'POST') {
        const body = await readJson(req)
        const serial = String(body.serial ?? '')
        const x = Math.round(Number(body.x ?? 0))
        const y = Math.round(Number(body.y ?? 0))
        const dy = Math.max(-4000, Math.min(4000, Number(body.dy ?? 0)))
        if (serial === '' || dy === 0) return json({ ok: false, reason: '缺少参数' })
        /* 滚轮向下 = 内容上移，手指就从下往上滑。 */
        const span = Math.max(60, Math.min(900, Math.abs(dy)))
        const from = dy > 0 ? y + span / 2 : y - span / 2
        const to = dy > 0 ? y - span / 2 : y + span / 2
        const ms = String(Math.max(120, Math.min(320, Math.round(span * 0.5))))
        return json(await input(serial, ['swipe', String(x), String(Math.round(from)), String(x), String(Math.round(to)), ms]))
      }

      if (path === '/swipe' && req.method === 'POST') {
        const body = await readJson(req)
        return json(await input(String(body.serial ?? ''), [
          'swipe',
          String(Math.round(body.x1)), String(Math.round(body.y1)),
          String(Math.round(body.x2)), String(Math.round(body.y2)),
          String(Math.round(body.ms ?? 300)),
        ]))
      }

      if (path === '/text' && req.method === 'POST') {
        const body = await readJson(req)
        const serial = String(body.serial ?? '')
        const text = String(body.text ?? '').slice(0, 400)
        if (serial === '' || text === '') return json({ ok: false, reason: '缺少参数' })
        if (/[^\x20-\x7e]/.test(text)) return json({ ok: false, reason: 'adb input 只吃 ASCII：中文请在设备上输入，或复制粘贴' })
        /* adb input 的坑：空格要写成 %s，其余空格类字符一律换掉，否则整句被截断。 */
        const escaped = text.replace(/\\/g, '\\\\').replace(/ /g, '%s').replace(/\s+/g, '%s').replace(/['"]/g, '')
        return json(await input(serial, ['text', escaped]))
      }

      if (path === '/key' && req.method === 'POST') {
        const body = await readJson(req)
        return json(await input(String(body.serial ?? ''), ['keyevent', String(body.key ?? 'BACK')]))
      }

      if (path === '/want' && req.method === 'GET') {
        return json({ session: wantSession, at: wantAt, title: wantTitle, pages: events.size })
      }

      if (path === '/diag' && req.method === 'POST') {
        const body = await readJson(req)
        diag.push({ at: Date.now(), body })
        if (diag.length > 20) diag.shift()
        if (typeof body?.pid === 'string') clients.set(body.pid, { at: Date.now(), ...body })
        return json({ ok: true })
      }

      if (path === '/sessions' && DEV === true) {
        return json(await sessionProbe())
      }
      if (path === '/annotate' && req.method === 'POST') {
        return json(await annotate(await readJson(req)))
      }

      return json({ error: 'not found' }, 404)
    } catch (error) {
      return json({ error: String(error?.message ?? error).slice(0, 200) }, 500)
    }
  }

  const mount = (scope) => scope.effect(() => {
    const server = scope.get?.('webServer') ?? ctx.get?.('webServer')
    if (server?.register === undefined) return undefined
    return server.register({ kind: 'prefix', path: ROUTE, handler })
  }, 'adb: 实时镜像路由')
  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mount)
  else mount(ctx)

  /**
   * 把最新一帧存成 JPEG，给 agent 直接看图。
   * @param {string} serial - 设备。
   * @returns {Promise<{ ok: boolean, path?: string, bytes?: number, at?: number }>} 结果。
   */
  async function peek(serial) {
    const mirror = mirrorFor(serial)
    void mirror.start()
    const frame = await mirror.firstFrame(4000)
    if (frame === null) return { ok: false }
    const file = join(ROOT, `peek-${serial.replace(/[^\w.-]/g, '_')}.jpg`)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, frame)
    return { ok: true, path: file, bytes: frame.length, at: mirror.latestAt }
  }

  return {
    open,
    peek,
    /**
     * 侧栏正在直播时，内存里最新一帧可以直接当截图用：0ms，不碰设备。
     * @param {string} serial - 设备。
     * @returns {{ frame: Buffer, at: number } | null} 够新才给。
     */
    liveFrame(serial) {
      const mirror = mirrors.get(serial)
      if (mirror === undefined || mirror.latest === null) return null
      if (mirror.watchers.size === 0) return null
      if (Date.now() - mirror.latestAt > 2500) return null
      return { frame: mirror.latest, at: mirror.latestAt }
    },
    /**
     * 最近几秒的画面拼成一张 3x2 图：动效比例/位移这类问题看序列帧最快。
     * @param {string} serial - 设备。
     * @param {number} seconds - 回看秒数。
     * @returns {Promise<{ ok: boolean, path?: string, bytes?: number }>} 结果。
     */
    /**
     * 逐像素动效时间线：问「刚才那下哪里不协调」时用。
     * @param {string} serial - 设备。
     * @param {object} options - seconds / fps / region / threshold。
     * @returns {Promise<object | null>} 指标。
     */
    async motion(serial, options = {}) {
      return mirrorFor(serial).motionTimeline(options)
    },
    async recentStrip(serial, seconds = 6) {
      const mirror = mirrorFor(serial)
      const found = await mirror.recentStripWithSource(seconds)
      if (found === null) return { ok: false }
      const file = join(ROOT, `recent-${serial.replace(/[^\w.-]/g, "_")}-${Date.now()}.png`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, found.png)
      return { ok: true, path: file, bytes: found.png.length, source: found.source, ageMs: found.ageMs }
    },
    async status(serial) {
      const chosen = serial ?? await tools.resolveSerial().catch(() => '')
      const mirror = mirrors.get(chosen)
      if (mirror === undefined) return { serial: chosen, live: false, frames: 0, segments: 0 }
      const segments = await mirror.segments()
      return {
        serial: chosen,
        live: mirror.latest !== null,
        frames: mirror.frames,
        fps: mirror.measuredFps(),
        bufferedSeconds: segments.length * SEGMENT_SECONDS,
        dir: mirror.dir,
      }
    },
    async segmentList(serial) {
      const chosen = serial ?? await tools.resolveSerial().catch(() => '')
      const mirror = mirrors.get(chosen)
      return mirror === undefined ? [] : mirror.segments()
    },
    stopAll() {
      for (const mirror of mirrors.values()) mirror.stop()
      mirrors.clear()
      for (const res of events) {
        try { res.end() } catch { /* 已断 */ }
      }
      events.clear()
    },
  }
}

/** 环形缓冲根目录，工具层汇报用。 */
export const MIRROR_ROOT = ROOT

/** 段长，工具层汇报用。 */
export const SEGMENT = { seconds: SEGMENT_SECONDS, keep: SEGMENT_KEEP, fps: LIVE_FPS }

/**
 * 【内部自测页】只在开发时用来验证 MSE 链路：打开 /dsh-adb/dev/mse 就能自己订阅 /stream。
 * 产品界面走 client.js，这个页面不参与打包。
 */
const DEV_MSE_PAGE = `<!doctype html><meta charset="utf-8"><title>MSE probe</title>
<body style="margin:0;background:#111;color:#ddf;font:13px ui-monospace">
<video id="v" muted playsinline autoplay style="width:960px;height:640px;background:#000"></video>
<pre id="s">booting</pre>
<script>
const v = document.getElementById('v'), S = document.getElementById('s')
const q = new URLSearchParams(location.search)
const serial = q.get('serial') || ''
const t0 = performance.now()
let sb = null, queue = [], inits = 0, media = 0, shown = 0, first = 0, err = ''
function say() {
  const b = sb && sb.buffered.length > 0 ? sb.buffered.end(sb.buffered.length - 1) : 0
  S.textContent = ['ready', v.readyState, 't', v.currentTime.toFixed(2), 'buf', b.toFixed(2),
    'err', v.error ? v.error.code : 0,
    'init', inits, 'media', media, 'res', v.videoWidth + 'x' + v.videoHeight,
    'first', first ? Math.round(first) + 'ms' : '-', err].join(' ')
}
function reset() {
  sb = null; queue = []
  const ms = new MediaSource()
  ms.addEventListener('sourceopen', () => {
    sb = ms.addSourceBuffer('video/mp4; codecs="avc1.640020"')
    sb.mode = 'segments'
    sb.addEventListener('updateend', () => {
      if (queue.length > 0) push()
      else if (v.paused && sb.buffered.length > 0) v.play().catch(() => {})
    })
    push()
  }, { once: true })
  v.src = URL.createObjectURL(ms)
  v.play().catch(() => {})
}
function push() {
  if (sb === null || sb.updating || queue.length === 0) return
  try { sb.appendBuffer(queue.shift()) } catch (e) { err = 'append: ' + e.message }
}
v.addEventListener('loadeddata', () => { if (!shown) { shown = 1; first = performance.now() - t0 } })
async function run() {
  const res = await fetch('/dsh-adb/stream?serial=' + encodeURIComponent(serial))
  const rd = res.body.getReader()
  let buf = new Uint8Array(0)
  for (;;) {
    const { value, done } = await rd.read()
    if (done) break
    const merged = new Uint8Array(buf.length + value.length)
    merged.set(buf); merged.set(value, buf.length); buf = merged
    for (;;) {
      if (buf.length < 5) break
      const len = new DataView(buf.buffer, buf.byteOffset).getUint32(1, false)
      if (buf.length < 5 + len) break
      const type = buf[0], body = buf.slice(5, 5 + len)
      buf = buf.slice(5 + len)
      if (type === 1) { inits += 1; reset(); queue.push(body) }
      else if (type === 2) { media += 1; queue.push(body); push() }
    }
  }
}
setInterval(() => { say(); if (v.paused && v.readyState > 0) v.play().catch(() => {}) }, 400)
reset()
run().catch((e) => { err = e.message })
</script>`
