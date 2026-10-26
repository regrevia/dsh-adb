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
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** 客户端与宿主共用的路由前缀。 */
export const ROUTE = '/dsh-adb'

/** 最近一次标注里动效拼图的字节数，0 表示没凑够帧。 */
let lastStripBytes = 0

const diag = []
const clients = new Map()

let wantSession = ''
let wantAt = 0

/** 对外报的直播帧率：实测 4–5 帧/秒，够看清操作反馈。 */
const LIVE_FPS = 4
/** 往外送帧的节奏：并发截图是一股一股完成的，按固定节拍取最新一帧才顺。 */
const PUSH_TICK_MS = 200
/** 同时在飞的截图数：单张约 0.65s，3 张并发实测 4 帧/秒以上。 */
const CAPTURE_PARALLEL = 3

/** 环形缓冲：10 秒一段，留 18 段 ≈ 3 分钟，超出的由 ffmpeg 自己覆盖。 */
const SEGMENT_SECONDS = 10
const SEGMENT_KEEP = 18

/** 一次注入最多带的图：PNG 原图 base64 后可能很大，超过就不注入。 */
const MAX_INJECT_BYTES = 8 * 1024 * 1024

/** 找 ffmpeg：DSH 进程的 PATH 未必带 Homebrew。 */
function pickFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG
  for (const candidate of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    if (existsSync(candidate)) return candidate
  }
  return 'ffmpeg'
}

const FFMPEG = pickFfmpeg()

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

/**
 * 一张 PNG 转成 JPEG：/live 走 MJPEG，帧只能是 JPEG。
 * @param {Buffer} png - PNG 数据。
 * @returns {Promise<Buffer | null>} JPEG，失败时 null。
 */
function pngToJpeg(png) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      '-f', 'png_pipe', '-i', 'pipe:0',
      '-vf', 'scale=1024:-2:flags=fast_bilinear', '-q:v', '7', '-f', 'mjpeg', 'pipe:1',
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
    this.timer = setInterval(() => this.pump(), 150)
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
    if (this.watchers.size === 0) {
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
  }

  /**
   * 把最近几秒的画面抽成一张 3×2 拼图：动效问题（桌宠变大变小、位移）单帧看不出来，
   * 序列帧一眼就能看出哪一帧比例不对。
   * @param {number} seconds - 回看多少秒。
   * @returns {Promise<Buffer | null>} PNG；不够帧时 null。
   */
  async recentStrip(seconds = 6) {
    if (this.recent.length < 3) return null
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
    const frame = await pngToJpeg(raw.subarray(png))
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
        '--bit-rate', '4000000', '--size', '720x1280', remote,
      ], { timeout: (SEGMENT_SECONDS + 20) * 1000 })
      if (this.stopping) break
      if (!recorded.ok) {
        this.error = recorded.err.trim().slice(0, 200) || '录制失败'
        await new Promise((resolve) => setTimeout(resolve, 1500))
        continue
      }
      const pulled = await this.adb(['-s', this.serial, 'exec-out', 'cat', remote], { timeout: 60_000 })
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
    if (this.watchers.size === 0 || this.latest === null) return
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

  /**
   * 拿一台设备的镜像，没有就建。
   * @param {string} serial - 序列号。
   * @returns {Mirror} 镜像。
   */
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
    const session = String(input.session ?? '')
    const base64 = String(input.png ?? '')
    if (session === '') return { ok: false, reason: '缺少会话', bytes: 0 }
    if (base64 === '') return { ok: false, reason: '缺少画面', bytes: 0 }
    const png = Buffer.from(base64, 'base64')
    if (png.length === 0) return { ok: false, reason: '画面为空', bytes: 0 }
    if (png.length > MAX_INJECT_BYTES) return { ok: false, reason: `画面超过 ${MAX_INJECT_BYTES / 1024 / 1024}MB`, bytes: png.length }
    await mkdir(join(ROOT, 'annotations'), { recursive: true })
    const file = join(ROOT, 'annotations', `adb-${Date.now()}.png`)
    await writeFile(file, png)
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
    if (lines.length === 0) lines.push('标注了一张设备画面。')
    const content = [
      { type: 'text', text: lines.join('\n') },
      { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'device-annotated.png' },
    ]
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
    return { ok: true, bytes: png.length, strip: strip?.length ?? 0 }
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

      if (path === '/frame' && req.method === 'GET') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        const mirror = mirrorFor(serial)
        void mirror.start()
        let frame = await mirror.firstFrame(4000)
        if (frame !== null && Date.now() - mirror.latestAt > 1200) {
          frame = (await mirror.snapshot()) ?? frame
        }
        if (frame === null) return json({ error: '画面还没起来' }, 503)
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
        return res.end(frame)
      }

      if (path === '/state' && req.method === 'GET') {
        const serial = url.searchParams.get('serial') || await tools.resolveSerial()
        const mirror = mirrorFor(serial)
        void mirror.start()
        const segments = await mirror.segments()
        return json({
          serial,
          started: mirror.startedAt,
          frames: mirror.frames,
          fps: mirror.measuredFps(),
          live: mirror.latest !== null,
          watchers: mirror.watchers.size,
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
        return json(await input(String(body.serial ?? ''), ['tap', String(Math.round(body.x)), String(Math.round(body.y))]))
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

      if (path === '/key' && req.method === 'POST') {
        const body = await readJson(req)
        return json(await input(String(body.serial ?? ''), ['keyevent', String(body.key ?? 'BACK')]))
      }

      if (path === '/want' && req.method === 'GET') {
        return json({ session: wantSession, at: wantAt, pages: events.size })
      }

      if (path === '/diag' && req.method === 'POST') {
        const body = await readJson(req)
        diag.push({ at: Date.now(), body })
        if (diag.length > 20) diag.shift()
        if (typeof body?.pid === 'string') clients.set(body.pid, { at: Date.now(), ...body })
        return json({ ok: true })
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
