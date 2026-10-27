/**
 * 持续推流：设备端 `screenrecord --output-format=h264` 出流，主进程用 ffmpeg 把裸流
 * 重排成分片 MP4（fMP4），浏览器用 MediaSource 边收边放。
 *
 * 和「定时抓 JPEG」相比，这条路的延迟只等于「屏幕变化 → 硬件编码 → 管道」，
 * 静止时几乎不产流量，也不需要客户端轮询；抓帧那 600~700 ms 的编码开销不存在了。
 *
 * 屏幕旋转或分辨率变化会让编码器重启，那时会换一段新的初始化段（moov），
 * 推给浏览器的帧头部会带上类型，让前端重建 MediaSource。
 */

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 帧类型：0 文本元信息，1 初始化段，2 媒体分片，3 一条流结束（前端应重连）。 */
export const FRAME_META = 0
export const FRAME_INIT = 1
export const FRAME_MEDIA = 2
export const FRAME_END = 3

/** screenrecord 单个进程最长 180 s，留出余量后自动续。 */
const RECORD_LIMIT = 175

/**
 * 把一条消息封成 `[类型 1 B][长度 4 B BE][负载]`，前端照这个切包。
 * @param {number} type - 帧类型。
 * @param {Buffer} payload - 负载。
 * @returns {Buffer} 可写进响应体的缓冲。
 */
export function packFrame(type, payload) {
  const head = Buffer.allocUnsafe(5)
  head.writeUInt8(type, 0)
  head.writeUInt32BE(payload.length, 1)
  return Buffer.concat([head, payload], 5 + payload.length)
}

/**
 * 读无符号指数哥伦布码。
 * @param {number[]} bits - 比特数组。
 * @param {{pos: number}} cursor - 游标。
 * @returns {number} 值。
 */
function ue(bits, cursor) {
  let zeros = 0
  while (cursor.pos < bits.length && bits[cursor.pos] === 0) {
    zeros += 1
    cursor.pos += 1
  }
  cursor.pos += 1
  let value = 0
  for (let i = 0; i < zeros; i += 1) {
    value = value * 2 + (bits[cursor.pos] ?? 0)
    cursor.pos += 1
  }
  return 2 ** zeros - 1 + value
}

/**
 * 有符号指数哥伦布码。
 * @param {number[]} bits - 比特数组。
 * @param {{pos: number}} cursor - 游标。
 * @returns {number} 值。
 */
function se(bits, cursor) {
  const value = ue(bits, cursor)
  return value % 2 === 1 ? (value + 1) / 2 : -value / 2
}

/**
 * 从 H.264 裸流里找第一段 SPS/PPS，解出可直接喂 `addSourceBuffer` 的编码串。
 * @param {Buffer} raw - 任意位置的裸流（含 start code）。
 * @returns {{codec: string, width: number, height: number} | null} 解析结果。
 */
export function parseAvcConfig(raw) {
  const spsList = []
  const ppsList = []
  let i = 0
  while (i + 4 < raw.length) {
    let start = -1
    if (raw[i] === 0 && raw[i + 1] === 0 && raw[i + 2] === 1) start = i + 3
    else if (raw[i] === 0 && raw[i + 1] === 0 && raw[i + 2] === 0 && raw[i + 3] === 1) start = i + 4
    if (start < 0) {
      i += 1
      continue
    }
    const type = raw[start] & 0x1f
    let end = raw.length
    for (let j = start + 1; j + 2 < raw.length; j += 1) {
      if (raw[j] === 0 && raw[j + 1] === 0 && (raw[j + 2] === 1 || (raw[j + 2] === 0 && raw[j + 3] === 1))) {
        end = j
        break
      }
    }
    if (type === 7) spsList.push(raw.subarray(start, end))
    else if (type === 8) ppsList.push(raw.subarray(start, end))
    i = end
    if (spsList.length > 0 && ppsList.length > 0) break
  }
  if (spsList.length === 0 || ppsList.length === 0) return null
  const sps = spsList[0]
  if (sps.length < 4) return null
  const profile = sps[1]
  const compat = sps[2]
  const level = sps[3]
  const bits = []
  for (let k = 4; k < sps.length; k += 1) {
    for (let b = 7; b >= 0; b -= 1) bits.push((sps[k] >> b) & 1)
  }
  const cursor = { pos: 0 }
  try {
    ue(bits, cursor) // seq_parameter_set_id
    const profileIdc = profile
    let chromaFormat = 1
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      chromaFormat = ue(bits, cursor)
      if (chromaFormat === 3) cursor.pos += 1
      ue(bits, cursor) // bit_depth_luma_minus8
      ue(bits, cursor) // bit_depth_chroma_minus8
      cursor.pos += 1 // qpprime_y_zero_transform_bypass_flag
      if (bits[cursor.pos] === 1) {
        cursor.pos += 1
        const count = chromaFormat === 3 ? 12 : 8
        for (let k = 0; k < count; k += 1) {
          if (bits[cursor.pos] === 0) cursor.pos += 1
          else return null
        }
      } else cursor.pos += 1
    }
    ue(bits, cursor) // log2_max_frame_num_minus4
    const pocType = ue(bits, cursor)
    if (pocType === 0) ue(bits, cursor)
    else if (pocType === 1) {
      cursor.pos += 1
      se(bits, cursor)
      se(bits, cursor)
      const count = ue(bits, cursor)
      for (let k = 0; k < count; k += 1) se(bits, cursor)
    }
    ue(bits, cursor) // max_num_ref_frames
    cursor.pos += 1 // gaps_in_frame_num_value_allowed_flag
    const widthMbs = ue(bits, cursor) + 1
    const heightMapUnits = ue(bits, cursor) + 1
    const frameMbsOnly = bits[cursor.pos]
    cursor.pos += 1
    if (frameMbsOnly === 0) cursor.pos += 1
    cursor.pos += 1 // direct_8x8_inference_flag
    let cropLeft = 0
    let cropRight = 0
    let cropTop = 0
    let cropBottom = 0
    if (bits[cursor.pos] === 1) {
      cursor.pos += 1
      cropLeft = ue(bits, cursor)
      cropRight = ue(bits, cursor)
      cropTop = ue(bits, cursor)
      cropBottom = ue(bits, cursor)
    }
    const chromaArray = chromaFormat === 0 ? 1 : chromaFormat
    const cropUnitX = chromaArray === 3 ? 1 : 2
    const cropUnitY = (chromaArray === 1 ? 2 : 1) * (2 - frameMbsOnly)
    const width = widthMbs * 16 - cropUnitX * (cropLeft + cropRight)
    const height = (2 - frameMbsOnly) * heightMapUnits * 16 - cropUnitY * (cropTop + cropBottom)
    return { codec: `avc1.${hex2(profile)}${hex2(compat)}${hex2(level)}`, width, height }
  } catch {
    return null
  }
}

/**
 * 两位十六进制。
 * @param {number} value - 0..255。
 * @returns {string} 小写两位。
 */
function hex2(value) {
  return value.toString(16).padStart(2, '0')
}

/**
 * 一路设备画面：录屏进程 + ffmpeg 重排 + 断线自动续。
 */
/**
 * 分片里有没有 IDR（H.264 NAL type 5）。新观众必须从关键帧起步。
 * @param {Buffer} chunk - moof + mdat。
 * @returns {boolean} 含关键帧就为真。
 */
function containsIdr(chunk) {
  const mdat = chunk.indexOf(Buffer.from('mdat'))
  if (mdat < 0) return false
  let i = mdat + 4
  while (i + 5 <= chunk.length) {
    /* fMP4 的 mdat 是长度前缀的 NAL，不是起始码；两种写法都认一下。 */
    if (chunk[i] === 0 && chunk[i + 1] === 0 && chunk[i + 2] === 1) {
      if ((chunk[i + 3] & 0x1f) === 5) return true
      i += 3
      continue
    }
    if (chunk[i] === 0 && chunk[i + 1] === 0 && chunk[i + 2] === 0 && chunk[i + 3] === 1) {
      if ((chunk[i + 4] & 0x1f) === 5) return true
      i += 4
      continue
    }
    const len = chunk.readUInt32BE(i)
    if (len === 0 || i + 4 + len > chunk.length) return false
    if ((chunk[i + 4] & 0x1f) === 5) return true
    i += 4 + len
  }
  return false
}

export class LiveStream {
  /**
   * @param {{serial: string, adb: string, width?: number, height?: number, bitrate?: number}} options - 设备与画质。
   */
  constructor(options) {
    this.serial = options.serial
    this.adbPath = options.adb
    this.width = options.width ?? 960
    this.height = options.height ?? 640
    this.bitrate = options.bitrate ?? 4_000_000
    this.recorder = null
    this.remuxer = null
    this.stopping = false
    this.restartTimer = null
    this.clients = new Set()
    this.init = null
    this.pending = Buffer.alloc(0)
    /** 待拼的 box 字节。 @type {Buffer} */
    this.buffer = Buffer.alloc(0)
    /** moov 之前的 box（ftyp/moov）。 @type {Buffer} */
    this.initPending = Buffer.alloc(0)
    /** 正在攒的 moof+mdat。 @type {Buffer} */
    this.frag = Buffer.alloc(0)
    this.prelude = Buffer.alloc(0)
    this.lastKeyChunks = []
    /** 等关键帧的新观众。 @type {Set<(bytes: Buffer) => void>} */
    this.waiting = new Set()
    this.total = 0
    this.startedAt = 0
    this.sessions = 0
    this.config = null
    this.error = ''
    this.intentional = false
    this.firstFrameAt = 0
    this.bytes = 0
    this.framesSeen = 0
    this.lastAt = 0
  }

  /** 有人在看才开始录，没人看一会儿就停，省设备电和带宽。 @returns {void} */
  start() {
    if (this.stopping || this.spawning) return
    if (this.recorder !== null) {
      this.ensureRemuxer()
      return
    }
    this.startedAt = Date.now()
    this.spawning = true
    this.spawnRecorder()
    this.spawning = false
  }

  /**
   * 重开一次录屏，换一张新的 IDR：新观众进场时用，代价约半秒黑屏。
   * @returns {void}
   */
  rekey() {
    if (this.stopping) return
    this.intentional = true
    const child = this.recorder
    this.recorder = null
    this.init = null
    this.error = ''
    this.lastKeyChunks = []
    this.closeRemuxer()
    if (child !== null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退了 */
      }
    }
    /* 不在这里直接 spawn：旧进程还没退，同时起两个会撞上另一个录屏在跑。
       exit 回调里的 scheduleRestart 会在 120 ms 后换新 IDR。 */
  }

  /**
   * 设备端兜底清理：本地 adb 被杀掉后，设备上的 screenrecord 还会活到 time-limit，
   * 占着编码器让下一次录屏直接失败（another recording is running）。
   * @returns {void}
   */
  killStale() {
    try {
      const child = spawn(this.adbPath, ['-s', this.serial, 'shell', 'pkill -f screenrecord'], { stdio: 'ignore' })
      child.on('error', () => {})
      child.unref?.()
    } catch {
      /* 清理失败不影响主流程 */
    }
  }

  /** 起一次录屏。 @returns {void} */
  debug(note) {
    /* 常开：只在开/停录屏时写一行，量极小，出问题不用再复现一次。 */
    try {
      const line = JSON.stringify({ at: Date.now(), serial: this.serial, note, sessions: this.sessions, clients: this.clients.size, waiting: this.waiting.size, err: this.error }) + '\n'
      mkdirSync(join(homedir(), '.dsh', 'adb-mirror'), { recursive: true })
      mkdirSync(join(homedir(), '.dsh', 'adb-mirror'), { recursive: true })
      appendFileSync(join(homedir(), '.dsh', 'adb-mirror', 'stream-debug.log'), line)
    } catch {
      /* 调试失败不影响推流 */
    }
  }

  spawnRecorder() {
    if (this.stopping) return
    const size = `${this.width}x${this.height}`
    const args = [
      '-s', this.serial, 'exec-out', 'screenrecord',
      '--output-format=h264',
      `--time-limit=${RECORD_LIMIT}`,
      `--size=${size}`,
      `--bit-rate=${this.bitrate}`,
      '-',
    ]
    const child = spawn(this.adbPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.recorder = child
    this.sessions += 1
    this.debug('spawn')
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000)
    })
    child.stdout.on('data', (chunk) => this.feedRaw(chunk))
    child.on('error', (error) => {
      this.error = String(error?.message ?? error)
      this.recorder = null
      this.scheduleRestart()
    })
    child.on('exit', (code) => {
      if (this.recorder === child) this.recorder = null
      this.closeRemuxer()
      if (this.stopping) return
      const wasIntentional = this.intentional
      this.intentional = false
      this.debug('recorder-exit code=' + String(code) + ' intentional=' + String(wasIntentional) + ' stderr=' + stderr.trim().slice(-120))
      if (code !== 0 && stderr.trim() !== '' && !wasIntentional) {
        /* screenrecord 在一些机型上会因为「另一个录屏在跑」直接退出，记下来便于排查。 */
        const text = stderr.trim().split('\n').slice(-2).join(' ')
        if (/denied|error|failed|another/i.test(text)) this.error = text
      }
      /* 正常到时长或编码器重启都走这里：换一份 moov，前端按 INIT 帧重建 MediaSource。 */
      if (this.clients.size > 0) this.broadcast(packFrame(FRAME_END, Buffer.alloc(0)))
      if (wasIntentional && this.stopping) return
      this.scheduleRestart()
    })
  }

  /** 到点自动续上，避免中断超过半秒。 @returns {void} */
  scheduleRestart() {
    if (this.stopping || this.restartTimer !== null) return
    if (this.clients.size === 0 && this.waiting.size === 0) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopping && (this.clients.size > 0 || this.waiting.size > 0)) {
        /* 上一轮可能是被 SIGKILL 的 adb：先清掉设备端残留，再开新录屏。 */
        if (this.sessions > 0) this.killStale()
        this.spawnRecorder()
      }
    }, 120)
    this.restartTimer.unref?.()
  }

  /** 有裸流分片就交给 ffmpeg；顺手记录编码参数。 @param {Buffer} chunk - 裸 H.264。 @returns {void} */
  feedRaw(chunk) {
    this.bytes += chunk.length
    this.lastAt = Date.now()
    if (this.firstFrameAt === 0) this.firstFrameAt = this.lastAt
    if (this.config === null) {
      /* SPS 可能被切在两个分片之间，攒一段再解析。 */
      this.prelude = Buffer.concat([this.prelude, chunk]).subarray(-262144)
      const config = parseAvcConfig(this.prelude)
      if (config !== null) {
        this.config = config
        this.broadcast(packFrame(FRAME_META, Buffer.from(JSON.stringify({ codec: config.codec, width: config.width, height: config.height }))))
      }
    }
    this.ensureRemuxer()
    const remuxer = this.remuxer
    if (remuxer === null) return
    try {
      remuxer.stdin.write(chunk)
    } catch {
      this.closeRemuxer()
    }
  }

  /**
   * 起 ffmpeg：裸流重排成分片 MP4。
   * @returns {void}
   */
  ensureRemuxer() {
    if (this.remuxer !== null) return
    this.error = ''
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      /* 千万不要加 -fflags nobuffer：它会让裸流输入一帧都进不来（实测 ffmpeg 只吐 moov）。
         40 ms 一片，画面一变就有一片推出去，静止时不产生流量。 */
      '-flags', 'low_delay',
      /* 裸 H.264 没有时间戳，默认会按 1200000fps 编时间轴，一片只有几毫秒、播起来像定格；
         用到达时间当时间戳，静止不动就不涨、动起来才走，正好对上真实节奏。 */
      '-use_wallclock_as_timestamps', '1',
      '-f', 'h264', '-i', 'pipe:0',
      /* 绝对时间戳太大，挪回从 0 起，前端才不用跟着跳到几小时的刻度上。 */
      '-copyts', '-start_at_zero',
      '-c', 'copy', '-frag_duration', '40000',
      '-movflags', 'empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.remuxer = child
    child.stdout.on('data', (chunk) => this.feedMp4(chunk))
    child.stderr.on('data', (buf) => {
      const text = String(buf).trim()
      if (text !== '') this.error = text.slice(-300)
    })
    child.on('error', (error) => {
      if (this.remuxer === child) this.remuxer = null
      this.error = `ffmpeg 起不来：${String(error?.message ?? error)}`
    })
    child.on('exit', (code) => {
      if (this.remuxer === child) this.remuxer = null
      /* 我们主动 kill 时 code 是 null，不是故障。 */
    this.debug('ffmpeg-exit code=' + String(code) + ' stopping=' + String(this.stopping) + ' intentional=' + String(this.intentional))
    /* code=null 表示被信号杀掉，是我们自己的 kill，不是故障。 */
    if (code !== 0 && code !== null && this.error === '' && !this.stopping && !this.intentional) this.error = `ffmpeg 退出码 ${String(code)}`
    })
  }

  /** 关掉 ffmpeg，等下一次录屏重开。 @returns {void} */
  closeRemuxer() {
    const child = this.remuxer
    this.remuxer = null
    this.init = null
    this.pending = Buffer.alloc(0)
    this.buffer = Buffer.alloc(0)
    this.initPending = Buffer.alloc(0)
    this.frag = Buffer.alloc(0)
    this.lastKeyChunks = []
    if (child === null) return
    try {
      child.stdin.end()
      child.kill('SIGKILL')
    } catch {
      /* 已经退了 */
    }
  }

  /**
   * ffmpeg 的 fMP4 输出：第一段含 moov，后面按 moof 切；keyframe 之前的分片留一份给新观众。
   * @param {Buffer} chunk - 输出字节。
   * @returns {void}
   */
  feedMp4(chunk) {
    this.total += chunk.length
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    /* 按 ISO BMFF 的 box 边界切，不能靠搜 "moof" 字符串：mdat 里撞上这四个字节就会切歪。 */
    for (;;) {
      if (this.buffer.length < 8) return
      const size = this.buffer.readUInt32BE(0)
      const type = this.buffer.toString('latin1', 4, 8)
      if (size < 8) {
        /* size 0/1 的怪 box，丢掉前 8 字节免得卡死。 */
        this.buffer = this.buffer.subarray(8)
        continue
      }
      if (this.buffer.length < size) return
      const box = this.buffer.subarray(0, size)
      this.buffer = this.buffer.subarray(size)
      if (type === 'moof') {
        if (this.init === null) {
          this.init = this.initPending.length > 0 ? this.initPending : Buffer.alloc(0)
          this.initPending = Buffer.alloc(0)
          /* 观众可能比 moov 先到，初始化段一到就补发，不然画面永远起不来。 */
          if (this.init.length > 0) this.broadcast(packFrame(FRAME_INIT, this.init))
        } else if (this.frag.length > 0) {
          this.emitMedia(this.frag)
        }
        this.frag = box
      } else if (this.frag.length > 0) {
        this.frag = Buffer.concat([this.frag, box])
      } else {
        this.initPending = Buffer.concat([this.initPending, box]).subarray(-8388608)
      }
    }
  }

  /**
   * 把分片推给观众，同时按 keyframe 维护一份缓存。
   * @param {Buffer} chunk - 分片字节。
   * @returns {void}
   */
  emitMedia(chunk) {
    this.framesSeen += 1
    this.lastAt = Date.now()
    const key = containsIdr(chunk)
    if (key) this.lastKeyChunks = [chunk]
    else {
      this.lastKeyChunks.push(chunk)
      if (this.lastKeyChunks.length > 240) this.lastKeyChunks.shift()
    }
    /* 还在等关键帧的观众，这一张到了就能开播。 */
    if (key && this.waiting.size > 0) {
      for (const sink of this.waiting) {
        this.sendPrelude(sink)
        sink(packFrame(FRAME_MEDIA, chunk))
        this.clients.add(sink)
      }
      this.waiting.clear()
    }
    this.broadcast(packFrame(FRAME_MEDIA, chunk))
  }

  /**
   * 推给所有观众，慢的直接丢掉（宁可掉帧也不堆内存）。
   * @param {Buffer} bytes - 已封包字节。
   * @returns {void}
   */
  broadcast(bytes) {
    for (const client of this.clients) {
      try {
        client(bytes)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  /**
   * 新观众入场：先给初始化段 + 最近一个 keyframe 起的分片，再进直播。
   * @param {(bytes: Buffer) => void} sink - 写响应的函数。
   * @returns {() => void} 退订函数。
   */
  subscribe(sink) {
    this.start()
    if (this.init !== null && this.lastKeyChunks.length > 0) {
      this.sendPrelude(sink)
      this.clients.add(sink)
    } else {
      /* 手上没有能解码的起点，先挂着，下一张 IDR 到了再补，避免解码器起不来。 */
      this.waiting.add(sink)
      /* 设备只在开录时给一张 IDR，等下一张可能是几十秒；直接重开一次录屏换新 IDR。 */
      /* 刚起的录屏还没吐第一张 IDR 就别杀掉重开：等它自己出图。 */
      if (this.recorder !== null && this.restartTimer === null && Date.now() - this.startedAt > 700) this.rekey()
      this.sendPrelude(sink)
    }
    return () => {
      this.clients.delete(sink)
      this.waiting.delete(sink)
      if (this.clients.size === 0 && this.waiting.size === 0) this.stop()
    }
  }

  /**
   * 补一份初始化段和关键帧起点给某个观众。
   * @param {(bytes: Buffer) => void} sink - 写响应的函数。
   * @returns {void}
   */
  sendPrelude(sink) {
    if (this.config !== null) {
      sink(packFrame(FRAME_META, Buffer.from(JSON.stringify({ codec: this.config.codec, width: this.config.width, height: this.config.height }))))
    }
    if (this.init === null) return
    sink(packFrame(FRAME_INIT, this.init))
    for (const chunk of this.lastKeyChunks) sink(packFrame(FRAME_MEDIA, chunk))
  }

  /** 没人看了就停，别占着设备编码器。 @returns {void} */
  stop() {
    this.stopping = true
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.closeRemuxer()
    const child = this.recorder
    this.recorder = null
    if (child !== null) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退了 */
      }
    }
    this.intentional = true
    this.stopping = false
    /* 本地杀进程不等于设备端停了：显式收掉，否则下一次开流会撞上另一个录屏在跑。 */
    if (this.sessions > 0) this.killStale()
    this.init = null
    this.lastKeyChunks = []
    this.waiting.clear()
    this.config = null
    this.firstFrameAt = 0
  }

  /** 给 /state 用的快照。 @returns {any} 状态。 */
  info() {
    return {
      serial: this.serial,
      clients: this.clients.size,
      codec: this.config?.codec ?? '',
      width: this.config?.width ?? 0,
      height: this.config?.height ?? 0,
      bytes: this.bytes,
      mp4Bytes: this.total,
      frames: this.framesSeen,
      started: this.startedAt,
      sessions: this.sessions,
      lastAt: this.lastAt,
      firstFrameAt: this.firstFrameAt,
      error: this.error,
    }
  }
}
