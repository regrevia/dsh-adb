/**
 * dsh-adb — 真机调试工具：用界面文本树代替截图驱动调试循环。
 *
 * 实测（小米平板 8 / 2136x3200，2026-10）：
 *   adb exec-out screencap -p         3.2s，8.9MB PNG，之后还要一次看图调用
 *   uiautomator dump /dev/tty（朴素） 0.35s，8KB XML → 压缩成 ~1KB 文本树
 * 所以「界面是什么状态」这类判断应该走文本树；截图只用于确认颜色、布局、
 * 相机/扫码画面这类只能看的东西。
 *
 * 本插件不做后台常驻进程，每个工具就是几次 adb 调用：设备拔掉、adb 重启都
 * 不会留下脏状态。界面树的 ref 缓存按设备序列号保存，`adb_tap` 的 ref 只在
 * 最近一次 `adb_ui` 之后有效（用时间戳检查，过期会明确报错而不是点错位置）。
 *
 * @module dsh-adb
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, open, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { setupMirror, frameSize as jpegSize } from './mirror.js?v=114'
import { ocrAvailable, ocrImage, stopOcr, toRects } from './ocr.js?v=114'

/** Plugin name，与 bundle patch 里的行 id 对应。 */
export const name = 'adb'

/** 只需要工具注册表；提示段落走可选获取，缺了也不影响工具。 */
export const inject = ['tools']

/** 界面上限：超过这个节点数不渲染，避免一个列表页吃掉几万 token。 */
const MAX_NODES = { default: 400, max: 1500 }

/** 文本树缓存有效期：ref 点击必须在这么近的一次 dump 之后。 */
const REF_TTL_MS = 120_000

/** 大输出上限：logcat / dumpsys 都可能很长。 */
const OUTPUT_LIMIT = 20_000

/**
 * 找到 adb。DSH 进程的 PATH 不一定带 Homebrew，所以按常见安装位置探测，
 * 最后退回裸 `adb` 让 PATH 决定。
 * @returns {string} adb 可执行文件路径。
 */
function pickAdb() {
  if (process.env.ADB) return process.env.ADB
  const candidates = [
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    join(homedir(), 'Library/Android/sdk/platform-tools/adb'),
    join(homedir(), 'Android/Sdk/platform-tools/adb'),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return 'adb'
}

const ADB = pickAdb()

/**
 * 把 Buffer 解成文本。adb 的输出可能不是合法 UTF-8（二进制截图），grep 之类
 * 的调用方只在明确要文本时使用。
 * @param {Buffer | string | undefined} value - 原始输出。
 * @returns {string} 文本。
 */
function toText(value) {
  if (value === undefined || value === null) return ''
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
}

/**
 * 跑一次 adb。
 * @param {string[]} args - adb 参数（不含 adb 自身）。
 * @param {{timeout?: number, buffer?: number}} [options] - 超时与输出上限。
 * @returns {Promise<{ok: boolean, code: number, out: string, err: string, ms: number, timedOut: boolean}>} 结果。
 */
function adb(args, options = {}) {
  const { timeout = 15_000, buffer = 64 << 20 } = options
  const started = Date.now()
  return new Promise((resolve) => {
    execFile(ADB, args, { timeout, maxBuffer: buffer, encoding: 'buffer' }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: typeof error?.code === 'number' ? error.code : error ? -1 : 0,
        out: toText(stdout),
        raw: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf8'),
        err: toText(stderr),
        ms: Date.now() - started,
        timedOut: Boolean(error?.killed),
      })
    })
  })
}

/**
 * 设备列表。`adb devices -l` 顺带给出型号，便于在错误信息里说清是哪台。
 * @returns {Promise<Array<{serial: string, state: string, model: string}>>} 设备。
 */
async function listDevices() {
  const r = await adb(['devices', '-l'], { timeout: 10_000 })
  const devices = []
  for (const line of r.out.split('\n').slice(1)) {
    const text = line.trim()
    if (!text) continue
    const [serial, state] = text.split(/\s+/)
    const model = /model:(\S+)/.exec(text)?.[1] ?? ''
    if (serial && state) devices.push({ serial, state, model })
  }
  return devices
}

/**
 * 选一台设备：config.serial → ANDROID_SERIAL → 第一台 online 设备。
 * @param {any} config - bundle patch 里的 config。
 * @returns {Promise<string>} 设备序列号。
 * @throws {Error} 没有可用设备时。
 */
async function resolveSerial(config) {
  const fixed = config?.serial || process.env.ANDROID_SERIAL
  if (fixed) return String(fixed)
  const devices = await listDevices()
  const online = devices.find((device) => device.state === 'device')
  if (!online) {
    throw new Error(
      devices.length === 0
        ? '没有检测到 Android 设备：用 USB 连上手机并打开「USB 调试」，或在模拟器启动后重试。'
        : `设备存在但不可用（${devices.map((d) => `${d.serial}=${d.state}`).join(', ')}）：先在手机上确认 USB 调试授权弹窗。`,
    )
  }
  return online.serial
}

/**
 * 包名简写：resource-id 前缀是包名，输出里只留后半段，省 token。
 * @param {string} id - 完整 resource-id。
 * @returns {string} 简写。
 */
function shortId(id) {
  const slash = id.indexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

/**
 * 类名简写。
 * @param {string} cls - 完整类名。
 * @returns {string} 简写。
 */
function shortClass(cls) {
  const dot = cls.lastIndexOf('.')
  return dot >= 0 ? cls.slice(dot + 1) : cls
}

/**
 * 把属性里的换行、连续空白压成单个空格，并截断。
 * @param {string} value - 原文。
 * @param {number} limit - 最大字符数。
 * @returns {string} 单行文本。
 */
function oneLine(value, limit) {
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/**
 * 常驻 shell 通道：每次 `adb shell xxx` 都要新起 adb 进程并握手（实测 70–90ms），
 * 常驻一条交互 shell 后提交命令只花 2–4ms，`input tap` 从 80ms 降到 35–48ms。
 * @type {Map<string, {child: any, buf: string, onChunk: ((text: string) => void) | null, dead: boolean}>}
 */
const shellChannels = new Map()

/** 每条设备上的命令串行排队，避免输出互相穿插。 @type {Map<string, Promise<any>>} */
const shellQueues = new Map()

/**
 * 杀掉一台设备的常驻 shell，下次调用自动重建。
 * @param {string} serial - 设备。
 * @returns {void}
 */
/** 系统动作 → 设备命令；全面屏手势和虚拟导航都走 keyevent，不依赖导航栏。 */
const ACTION_MAP = {
  home: 'input keyevent 3',
  back: 'input keyevent 4',
  recents: 'input keyevent 187',
  lock: 'input keyevent 223',
  wake: 'input keyevent 224; wm dismiss-keyguard',
  notifications: 'cmd statusbar expand-notifications',
  quick_settings: 'cmd statusbar expand-settings',
}

/**
 * 等待若干毫秒。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 到点返回。
 */
function dshSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** WebView 调试口转发缓存：`serial/pid` → 本机端口。 */
const webPorts = new Map()

/**
 * 找 App 的 WebView 调试口，必要时建 adb forward。
 * @param {string} device - 设备序列号。
 * @param {string} packageName - 包名。
 * @returns {Promise<{pid: string, port: number}>} 进程与端口。
 */
async function webTarget(device, packageName) {
  const pidResult = await adb(['-s', device, 'shell', 'pidof', packageName], { timeout: 6000 })
  const pid = (pidResult.out || '').trim().split(/\s+/)[0]
  if (!pid) throw new Error(`设备上没有在跑的 ${packageName} 进程：先把 App 打开。`)
  const sockets = await adb(['-s', device, 'shell', 'cat /proc/net/unix'], { timeout: 8000 })
  const names = [...new Set((sockets.out || '').match(/webview_devtools_remote_\d+/g) ?? [])]
  const socketName = names.find((name) => name.endsWith(`_${pid}`)) ?? names[0]
  if (!socketName) {
    throw new Error(`${packageName} 没有 WebView 调试口：App 没内嵌 WebView，或者没开调试（WebView.setWebContentsDebuggingEnabled(true)）。设备上现在一个 WebView 调试口都没有。`)
  }
  const socketPid = socketName.slice('webview_devtools_remote_'.length)
  const key = `${device}/${socketPid}`
  const cachedPort = webPorts.get(key)
  if (cachedPort) return { pid, port: cachedPort, socketPid }
  const forward = await adb(['-s', device, 'forward', 'tcp:0', `localabstract:${socketName}`], { timeout: 6000 })
  const port = Number((forward.out || '').trim())
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`WebView 调试口转发失败：${oneLine(forward.err || forward.out, 140)}`)
  }
  webPorts.set(key, port)
  return { pid, port, socketPid }
}

/**
 * 发一条 CDP 命令并等它回。
 * @param {string} url - 页面 WebSocket 地址。
 * @param {string} method - CDP 方法名。
 * @param {any} params - 参数。
 * @param {number} timeoutMs - 超时。
 * @returns {Promise<any>} CDP 回包。
 */
function wsCall(url, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      try {
        socket.close()
      } catch {
        /* 已经关了 */
      }
      reject(new Error('WebView 执行超时'))
    }, timeoutMs)
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method, params }))
    socket.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== 1) return
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* 已经关了 */
      }
      resolve(message)
    }
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error('CDP 连接失败'))
    }
  })
}

function killShell(serial) {
  const channel = shellChannels.get(serial)
  shellChannels.delete(serial)
  if (channel !== undefined) {
    channel.dead = true
    try {
      channel.child.kill('SIGKILL')
    } catch {
      /* 已经死了 */
    }
  }
}

/**
 * 建一条常驻 shell。
 * @param {string} serial - 设备。
 * @returns {any} 通道。
 */
function openShell(serial) {
  const child = execFile(ADB, ['-s', serial, 'shell'], { timeout: 0 })
  const channel = { child, buf: '', onChunk: null, dead: false }
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    channel.buf += chunk
    if (channel.onChunk !== null) channel.onChunk(channel.buf)
  })
  child.on('error', () => {
    channel.dead = true
    shellChannels.delete(serial)
  })
  child.on('exit', () => {
    channel.dead = true
    if (shellChannels.get(serial) === channel) shellChannels.delete(serial)
  })
  shellChannels.set(serial, channel)
  return channel
}

/**
 * 在常驻 shell 里跑一条命令。
 * @param {string} serial - 设备。
 * @param {string} cmd - shell 命令。
 * @param {number} timeout - 毫秒。
 * @returns {Promise<{ ok: boolean, out: string, ms: number }>} 结果。
 */
function shellOnce(serial, cmd, timeout) {
  return new Promise((resolve) => {
    let channel = shellChannels.get(serial)
    if (channel === undefined || channel.dead) channel = openShell(serial)
    const tag = `@S${(Math.random() * 1e9) | 0}@`
    const started = performance.now()
    let done = false
    /** 收尾：只认第一次，顺手摘掉监听。 @param {string} out - 输出。 @param {boolean} ok - 是否成功。 @returns {void} */
    const finish = (out, ok) => {
      if (done) return
      done = true
      clearTimeout(timer)
      channel.onChunk = null
      channel.child.removeListener('exit', onExit)
      resolve({ ok, out, ms: Math.round(performance.now() - started) })
    }
    /** 子进程退出：这次命令等不到了。 @returns {void} */
    const onExit = () => finish('', false)
    channel.buf = ''
    channel.onChunk = (text) => {
      const cut = text.indexOf(tag)
      if (cut < 0) return
      finish(text.slice(0, cut), true)
    }
    const timer = setTimeout(() => {
      killShell(serial)
      finish('', false)
    }, timeout)
    timer.unref?.()
    channel.child.once('exit', onExit)
    try {
      channel.child.stdin.write(`${cmd}; echo ${tag}\n`)
    } catch {
      killShell(serial)
      finish('', false)
    }
  })
}

/**
 * 跑一条 shell 命令：优先走常驻通道，失败退回一次性 `adb shell`。
 * @param {string} serial - 设备。
 * @param {string} cmd - shell 命令。
 * @param {number} timeout - 毫秒。
 * @returns {Promise<{ ok: boolean, out: string, ms: number }>} 结果。
 */
async function sh(serial, cmd, timeout = 15_000) {
  const previous = shellQueues.get(serial) ?? Promise.resolve()
  let release = () => {}
  const gate = new Promise((resolve) => {
    release = resolve
  })
  shellQueues.set(serial, previous.then(() => gate))
  await previous
  try {
    const fast = await shellOnce(serial, cmd, timeout)
    if (fast.ok) return fast
    const started = performance.now()
    const slow = await adb(['-s', serial, 'shell', cmd], { timeout })
    return { ok: slow.ok, out: slow.out, ms: Math.round(performance.now() - started) }
  } finally {
    release()
  }
}

/** 最近的操作时间线，标注回传时一起交给模型。 @type {Array<{ at: number, what: string }>} */
const lastActions = []

/**
 * 取最近一段时间内的操作。
 * @param {number} windowMs - 毫秒。
 * @returns {string[]} 形如 `-3.2s 点击 「开始」@640,1200`。
 */
function recentActions(windowMs = 60_000) {
  const now = Date.now()
  const lines = []
  for (const item of lastActions) {
    const age = now - item.at
    if (age > windowMs) continue
    lines.push(`-${(age / 1000).toFixed(1)}s ${item.what}`)
  }
  return lines.slice(-12)
}

const rootCache = new Map()

/**
 * 探测设备是否有 root：Magisk 用 `su -c`，老 su 用 `su 0`。按序列号缓存，避免每次重探。
 * @param {string} serial - 设备。
 * @returns {Promise<boolean>} 是否有 root。
 */
async function deviceRoot(serial) {
  if (!rootCache.has(serial)) {
    let found = false
    for (const probe of ['su -c id', 'su 0 id']) {
      const r = await adb(['-s', serial, 'shell', probe], { timeout: 6000 }).catch(() => null)
      if (r && /uid=0/.test(r.out)) {
        found = true
        break
      }
    }
    rootCache.set(serial, found)
  }
  return rootCache.get(serial)
}

/**
 * 解析 uiautomator 的 XML：单行输出，用正则按标签顺序走，维护深度栈。
 * 属性里可能带 `<` 之类转义，所以只在 `<node ...>` 上取属性。
 * @param {string} xml - 完整 XML。
 * @returns {Array<{depth: number, text: string, id: string, cls: string, desc: string, clickable: boolean, longClickable: boolean, scrollable: boolean, enabled: boolean, checked: boolean, selected: boolean, focused: boolean, x1: number, y1: number, x2: number, y2: number}>} 节点。
 */
function parseNodes(xml) {
  const nodes = []
  const stack = []
  const token = /<node\b([^>]*?)(\/?)>|(<\/node>)/g
  let match
  while ((match = token.exec(xml)) !== null) {
    if (match[3]) {
      stack.pop()
      continue
    }
    const attrs = match[1]
    const selfClosing = match[2] === '/'
    const read = (key) => {
      const found = new RegExp(`\\b${key}="([^"]*)"`).exec(attrs)
      return found ? found[1] : ''
    }
    const bounds = /bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/.exec(attrs)
    nodes.push({
      index: nodes.length,
      parent: stack.length > 0 ? stack[stack.length - 1] : -1,
      depth: stack.length,
      text: read('text'),
      id: read('resource-id'),
      cls: read('class'),
      desc: read('content-desc'),
      clickable: read('clickable') === 'true',
      longClickable: read('long-clickable') === 'true',
      scrollable: read('scrollable') === 'true',
      enabled: read('enabled') !== 'false',
      checked: read('checked') === 'true',
      selected: read('selected') === 'true',
      focused: read('focused') === 'true',
      x1: bounds ? Number(bounds[1]) : 0,
      y1: bounds ? Number(bounds[2]) : 0,
      x2: bounds ? Number(bounds[3]) : 0,
      y2: bounds ? Number(bounds[4]) : 0,
    })
    if (!selfClosing) stack.push(nodes.length - 1)
  }
  return nodes
}

/**
 * 从 adb 输出里截出 XML。`uiautomator dump` 有时会把
 * `UI hierchary dumped to: /dev/tty` 混在 stdout 里。
 * @param {string} raw - adb stdout。
 * @returns {string} XML，找不到时返回空串。
 */
function extractXml(raw) {
  const start = raw.indexOf('<hierarchy')
  const end = raw.lastIndexOf('</hierarchy>')
  if (start < 0 || end < 0) return ''
  return raw.slice(start, end + '</hierarchy>'.length)
}

/* ─────────────────── uiautomator2 常驻服务（快路径） ───────────────────
 * `uiautomator dump` 每条命令都要冷启动一次 uiautomator，实测 2.16–2.26s；
 * uiautomator2 把服务常驻在设备上（app_process + JSON-RPC），经 adb forward
 * 读同一份 XML 实测 54–107ms，快 20–40 倍，省掉的正是「读界面」这件事的
 * 全部固定开销。服务不在时自动推 jar、自动起；起不来就静默回退旧路径。
 */

/** 设备端 u2 服务端口（uiautomator2 默认）。 */
const U2_PORT = 9008

/** 插件自带 u2.jar / apk，不依赖本机装没装 python 包。 */
const U2_VENDOR = fileURLToPath(new URL('./vendor/', import.meta.url))

/** serial → {port, at}：已经测试过可用的 forward 端口。 */
const u2Cache = new Map()

/**
 * 一次 HTTP 往返。u2 服务只监听设备本地，必须经 adb forward。
 * @param {number} port - 本机 forward 端口。
 * @param {string} path - 路径。
 * @param {any} [body] - 有 body 就走 POST。
 * @param {number} [timeoutMs] - 超时。
 * @returns {Promise<{status: number, text: string}>} 响应。
 */
function u2Fetch(port, path, body, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method: payload ? 'POST' : 'GET',
      timeout: timeoutMs,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
        : {},
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => req.destroy(new Error(`u2 请求超时 ${timeoutMs}ms`)))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * 服务活着吗（GET /ping 回 "pong"）。
 * @param {number} port - 本机 forward 端口。
 * @returns {Promise<boolean>} 活着为 true。
 */
async function u2Alive(port) {
  try {
    const r = await u2Fetch(port, '/ping', undefined, 1200)
    return r.text.trim() === 'pong'
  } catch {
    return false
  }
}

/**
 * 在设备上把 u2 服务拉起来（jar 不在就先推）。
 * @param {string} serial - 设备。
 * @returns {Promise<void>} 无。
 */
async function u2Start(serial) {
  const jar = join(U2_VENDOR, 'u2.jar')
  const has = await adb(['-s', serial, 'shell', 'ls /data/local/tmp/u2.jar'], { timeout: 8000 })
  if (!has.out.includes('u2.jar')) {
    if (!existsSync(jar)) throw new Error('插件缺 vendor/u2.jar，无法启动 uiautomator2 服务')
    await adb(['-s', serial, 'push', jar, '/data/local/tmp/u2.jar'], { timeout: 120_000 })
  }
  await adb(['-s', serial, 'shell',
    `nohup sh -c 'CLASSPATH=/data/local/tmp/u2.jar app_process / com.wetest.uia2.Main -p ${U2_PORT}' >/dev/null 2>&1 &`],
    { timeout: 8000 })
}

/**
 * 拿到一个能用的本机端口：复用已有 forward，否则新建，再不行就起服务。
 * @param {string} serial - 设备。
 * @returns {Promise<number>} 端口。
 */
async function u2Port(serial) {
  const cached = u2Cache.get(serial)
  if (cached && Date.now() - cached.at < 120_000 && await u2Alive(cached.port)) return cached.port
  const list = await adb(['-s', serial, 'forward', '--list'], { timeout: 8000 })
  const reused = new RegExp(`tcp:(\\d+) tcp:${U2_PORT}\\b`).exec(list.out)
  if (reused && await u2Alive(Number(reused[1]))) {
    u2Cache.set(serial, { port: Number(reused[1]), at: Date.now() })
    return Number(reused[1])
  }
  /* `adb forward tcp:0` 在部分 adb 版本上直接失败（实测 37.0.1 返回非 0），
     所以自己挑几个端口试，能 ping 通即用。 */
  let lastError = ''
  for (const port of [19108, 19208, 19308]) {
    const created = await adb(['-s', serial, 'forward', `tcp:${port}`, `tcp:${U2_PORT}`], { timeout: 8000 })
    if (created.code !== 0) {
      lastError = oneLine(created.err || created.out || `adb forward 退出码 ${created.code}`, 160)
      continue
    }
    if (!await u2Alive(port)) {
      try {
        await u2Start(serial)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      let ok = false
      for (let i = 0; i < 40 && !ok; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        ok = await u2Alive(port)
      }
      if (!ok) {
        lastError = lastError || 'uiautomator2 服务没有起来'
        continue
      }
    }
    u2Cache.set(serial, { port, at: Date.now() })
    return port
  }
  throw new Error(`uiautomator2 不可用：${lastError}`)
}

/**
 * 用 u2 服务读界面 XML。参数是位置参数 `[compressed, maxDepth]`。
 * @param {string} serial - 设备。
 * @returns {Promise<string>} XML。
 */
async function u2Dump(serial) {
  const port = await u2Port(serial)
  const r = await u2Fetch(port, '/jsonrpc/0', {
    jsonrpc: '2.0',
    id: 1,
    method: 'dumpWindowHierarchy',
    params: [false, 50],
  }, 8000)
  let data
  try {
    data = JSON.parse(r.text)
  } catch {
    throw new Error(`u2 返回不是 JSON：${oneLine(r.text, 120)}`)
  }
  if (data.error) throw new Error(`u2 dump 失败：${oneLine(data.error.message, 120)}`)
  return extractXml(String(data.result ?? ''))
}

/**
 * 节点是否值得进文本树：有文字、有描述、有点击行为，或者显式要完整树。
 * @param {any} node - 节点。
 * @param {boolean} full - 是否包含结构节点。
 * @returns {boolean} 是否保留。
 */
function interesting(node, full) {
  if (node.text || node.desc || node.clickable || node.longClickable) return true
  if (full && node.id) return true
  return false
}

/**
 * 压缩文本树：去掉纯容器，合并父子重复文字，给可操作节点发 ref。
 * 输出格式（尽量短）：
 *   `#12 Button "登录" #login_btn @300,412 *`  — * 可点击
 *   `   ~ 可滚动   [x] 已勾选   [s] 选中   [f] 焦点`
 * @param {any[]} nodes - parseNodes 的结果。
 * @param {{full?: boolean, maxNodes?: number}} options - 参数。
 * @returns {{lines: string[], refs: Array<{ref: number, node: any}>, kept: number, total: number}} 结果。
 */
function compactTree(nodes, options) {
  const full = options.full === true
  const maxNodes = Math.min(Math.max(options.maxNodes ?? MAX_NODES.default, 1), MAX_NODES.max)
  const lines = []
  const refs = []
  /** 每个深度上正在打开的容器签名，用来消除父子重复文字。 */
  const ancestors = []
  let kept = 0
  for (const node of nodes) {
    const signature = `${node.text}\u0000${node.desc}\u0000${node.id}`
    ancestors.length = Math.min(ancestors.length, node.depth)
    const duplicated = (node.text || node.desc) && ancestors.includes(signature)
    if (!duplicated && interesting(node, full) && kept < maxNodes) {
      const text = oneLine(node.text, 42)
      const desc = oneLine(node.desc, 32)
      const id = node.id ? shortId(node.id) : ''
      const parts = []
      if (text) parts.push(`"${text}"`)
      if (desc && desc !== text) parts.push(text ? `~"${desc}"` : `~"${desc}"`)
      if (id) parts.push(`#${id}`)
      const cx = Math.round((node.x1 + node.x2) / 2)
      const cy = Math.round((node.y1 + node.y2) / 2)
      let tail = `@${cx},${cy}`
      if (node.clickable || node.longClickable) tail += ' *'
      if (node.scrollable) tail += ' ~'
      if (node.checked) tail += ' [x]'
      else if (node.selected) tail += ' [s]'
      if (node.focused) tail += ' [f]'
      if (node.enabled === false) tail += ' [off]'
      const ref = refs.length + 1
      refs.push({ ref, node })
      const label = `${String(ref).padStart(2, ' ')} ${shortClass(node.cls)} ${parts.join(' ')}`.trimEnd()
      lines.push(`${label} ${tail}`.replace(/\s+/g, ' ').trim())
      kept += 1
    }
    if (node.text || node.desc || node.id) ancestors[node.depth] = signature
  }
  return { lines, refs, kept, total: nodes.length }
}

/**
 * 读前台 Activity。0.07s，比 dump 快一个数量级，可以用来判断「有没有进目标页」。
 * @param {string} serial - 设备。
 * @returns {Promise<string>} 类似 `com.example.app/.MainActivity`。
 */
async function foregroundActivity(serial) {
  /* MIUI 上 `dumpsys activity activities` 的 mResumedActivity 经常是空的，
     `dumpsys window` 的 mFocusedApp 稳定（0.09–0.15s）。 */
  const r = await adb(['-s', serial, 'shell', 'dumpsys window | grep -m2 -E "mCurrentFocus|mFocusedApp"'], { timeout: 8000 })
  const raw = /([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/.exec(r.out)
  return raw ? raw[1] : ''
}

/**
 * 当前设备上最近一次文本树，用于把 ref 还原成坐标。
 * @type {Map<string, {refs: Array<{ref: number, node: any}>, at: number}>}
 */
const lastTrees = new Map()
/** 上一次 adb_ui 的行，changed_only 用来做差。 */
const lastUiLines = new Map()

/**
 * 判断 waitPredicate 是否满足。
 * @param {any} state - 一次 dump 的状态。
 * @param {{text?: string, id?: string, desc?: string, activity?: string, gone?: string}} want - 条件。
 * @returns {boolean} 是否满足。
 */
function matches(state, want) {
  const present = (needle) => {
    if (!needle) return true
    const lower = needle.toLowerCase()
    return state.nodes.some((node) => `${node.text} ${node.desc} ${node.id}`.toLowerCase().includes(lower))
  }
  const absent = (needle) => {
    if (!needle) return true
    const lower = needle.toLowerCase()
    return !state.nodes.some((node) => `${node.text} ${node.desc} ${node.id}`.toLowerCase().includes(lower))
  }
  if (want.activity && !new RegExp(want.activity, 'i').test(state.activity)) return false
  if (!present(want.text)) return false
  if (!present(want.id)) return false
  if (!present(want.desc)) return false
  if (!absent(want.gone)) return false
  return true
}

/**
 * 等待界面满足条件，替代 sleep + 截图。每 120ms 一次 dump（u2 一次约 0.12s）。
 * @param {string} serial - 设备。
 * @param {{text?: string, id?: string, desc?: string, activity?: string, gone?: string}} want - 条件。
 * @param {number} timeoutMs - 超时。
 * @returns {Promise<{matched: boolean, elapsedMs: number, state: any}>} 结果。
 */
async function waitFor(serial, want, timeoutMs) {
  const started = Date.now()
  let state = await dumpState(serial, {})
  while (!matches(state, want)) {
    if (Date.now() - started > timeoutMs) return { matched: false, elapsedMs: Date.now() - started, state }
    await new Promise((resolve) => setTimeout(resolve, 120))
    state = await dumpState(serial, {})
  }
  return { matched: true, elapsedMs: Date.now() - started, state }
}

/**
 * dump 一次并压缩。返回的 state 同时缓存 ref，供 adb_tap 使用。
 * @param {string} serial - 设备。
 * @param {{full?: boolean, maxNodes?: number}} options - 参数。
 * @returns {Promise<any>} 状态。
 */
/** PNG 头签名，screencap 的输出前面偶尔带杂字节。 */
const PNG_SIG_OCR = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const JPEG_SIG_OCR = Buffer.from([0xff, 0xd8, 0xff])
const OCR_REMOTE = '/data/local/tmp/dsh-adb-ocr.jpg'

/**
 * 拿一张给 OCR 用的截图：设备端编 JPEG 再 cat 回来，比 `exec-out screencap -p` 快一个量级
 * （3200x2136 PNG 要 8.5MB / 3s，JPEG 3.5MB / 0.36s）。
 * @param {string} serial - 设备序列号。
 * @returns {Promise<Buffer|null>} 图片字节；失败返回 null。
 */
async function ocrCapture(serial) {
  try {
    const shot = await adb(['-s', serial, 'shell', 'screencap', '-j', OCR_REMOTE], { timeout: 10_000 })
    if (shot?.code !== 0) return null
    const pulled = await adb(['-s', serial, 'exec-out', 'cat', OCR_REMOTE], { timeout: 15_000 })
    const raw = pulled?.raw
    if (!Buffer.isBuffer(raw) || raw.length < 2000) return null
    const at = raw.indexOf(JPEG_SIG_OCR)
    return at < 0 ? null : raw.subarray(at)
  } catch {
    return null
  }
}

/**
 * 文本树稀疏时用本机 Vision OCR 补一批可点候选。
 * @param {string} serial - 设备序列号。
 * @returns {Promise<{nodes: Array<object>, ms: number, note: string}>} 追加的节点。
 */
async function ocrNodes(serial) {
  const began = Date.now()
  if (!ocrAvailable()) return { nodes: [], ms: 0, note: '本机没有 OCR' }
  let image = await ocrCapture(serial)
  let ext = 'jpg'
  if (!image) {
    /* JPEG 路不通（老系统没有 `screencap -j`）再退回 PNG。 */
    const shot = await adb(['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 20_000 }).catch(() => null)
    const raw = shot?.raw
    if (!Buffer.isBuffer(raw) || raw.length < 1000) return { nodes: [], ms: 0, note: '截图失败' }
    const at = raw.indexOf(PNG_SIG_OCR)
    if (at < 0) return { nodes: [], ms: 0, note: '截图不是图片' }
    image = raw.subarray(at)
    ext = 'png'
  }
  const path = join(tmpdir(), `dsh-adb-ocr-${Date.now()}.${ext}`)
  await writeFile(path, image).catch(() => {})
  let rects
  try {
    const recognized = await ocrImage(path)
    const blocks = Array.isArray(recognized) ? recognized : recognized.blocks
    const width = recognized.width ?? (ext === 'png' ? image.readUInt32BE(16) : 0)
    const height = recognized.height ?? (ext === 'png' ? image.readUInt32BE(20) : 0)
    if (!width || !height) throw new Error('拿不到图片尺寸')
    rects = toRects(blocks, width, height)
  } catch (error) {
    return { nodes: [], ms: Date.now() - began, note: `OCR 失败：${oneLine(error.message, 60)}` }
  }
  const nodes = rects.map((rect, index) => ({
    index,
    parent: -1,
    depth: 1,
    text: rect.text,
    id: '',
    cls: 'ocr',
    desc: '',
    clickable: true,
    longClickable: false,
    scrollable: false,
    enabled: true,
    checked: false,
    selected: false,
    focused: false,
    x1: rect.x1,
    y1: rect.y1,
    x2: rect.x2,
    y2: rect.y2,
  }))
  return { nodes, ms: Date.now() - began, note: `${nodes.length} 段文字（置信度 ≥ 0.3）` }
}

async function dumpState(serial, options) {
  const started = Date.now()
  const wantActivity = options.activity !== false
  const activityPromise = wantActivity ? foregroundActivity(serial) : Promise.resolve('')
  let xml = ''
  let source = 'uiautomator2'
  try {
    xml = await u2Dump(serial)
  } catch {
    xml = ''
  }
  if (!xml) {
    source = 'uiautomator'
    const r = await adb(['-s', serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], { timeout: 20_000 })
    xml = extractXml(r.out)
    if (!xml) {
      throw new Error(`读界面树失败：${oneLine(r.err || r.out || '无输出', 200)}`)
    }
  }
  const activity = await activityPromise
  const nodes = parseNodes(xml)
  /* 文本树给不出几个能读的控件（Flutter / 自绘 / 相机 / WebView）就补一次 OCR，别让模型对着空树猜。 */
  const textNodes = nodes.filter((node) => (node.text || node.desc || node.id) && node.enabled).length
  let ocrNote = ''
  let ocrMs = 0
  const needOcr = options.ocr === 'force' || (textNodes < 4 && options.ocr !== false && options.ocr !== 'off')
  if (needOcr) {
    const extra = await ocrNodes(serial)
    ocrMs = extra.ms
    if (extra.nodes.length > 0) {
      const base = nodes.length
      for (const [offset, node] of extra.nodes.entries()) {
        node.index = base + offset
        nodes.push(node)
      }
      source = `${source}+ocr`
      ocrNote = options.ocr === 'force'
        ? ` · 按要求用本机 OCR 补 ${extra.nodes.length} 段文字（${ocrMs}ms）`
        : ` · 文本树只有 ${textNodes} 个控件，已用本机 OCR 补 ${extra.nodes.length} 段文字（${ocrMs}ms）`
    }
  }
  const tree = compactTree(nodes, options)
  const signature = tree.lines.join('\n')
  const previous = lastTrees.get(serial)
  const changed = !previous || previous.signature !== signature
  lastTrees.set(serial, { refs: tree.refs, nodes, at: Date.now(), signature, activity })
  return { serial, activity, nodes, tree, changed, ms: Date.now() - started, source, ocrNote }
}

/**
 * 找 ref 对应的节点。
 * @param {string} serial - 设备。
 * @param {number} ref - 引用号。
 * @returns {any} 节点。
 */
function nodeForRef(serial, ref) {
  const cached = lastTrees.get(serial)
  if (!cached) throw new Error('还没有界面树：先调用 adb_ui 读一次界面，再用它给的 ref 点击。')
  if (Date.now() - cached.at > REF_TTL_MS) throw new Error('ref 已过期（超过 2 分钟或界面已变）：重新调用 adb_ui，用新的 ref。')
  const found = cached.refs.find((entry) => entry.ref === ref)
  if (!found) throw new Error(`没有 ref=${ref}：ref 编号每次 adb_ui 都会重新分配，用最新一次返回的编号。`)
  return found.node
}

/**
 * 按文字/资源 id/描述找节点。文字优先精确匹配，再退化为包含匹配。
 * @param {string} serial - 设备。
 * @param {{text?: string, id?: string, desc?: string}} want - 选择器。
 * @returns {any} 节点。
 */
function nodeForSelector(serial, want) {
  const cached = lastTrees.get(serial)
  if (!cached) throw new Error('还没有界面树：先调用 adb_ui 读一次界面，再按文字/id 点击。')
  const refs = cached.refs.map((entry) => entry.node)
  if (want.text) {
    const exact = refs.find((node) => node.text === want.text || node.desc === want.text)
    const loose = exact ?? refs.find((node) => `${node.text} ${node.desc}`.includes(want.text))
    if (!loose) throw new Error(`界面上没有文字「${want.text}」：先 adb_ui 看当前界面，或用 filter 搜一下。`)
    return loose
  }
  if (want.id) {
    const needle = shortId(want.id)
    const found = refs.find((node) => shortId(node.id) === needle) ?? refs.find((node) => shortId(node.id).includes(needle))
    if (!found) throw new Error(`界面上没有 id 包含「${needle}」的控件：先 adb_ui 看当前界面。`)
    return found
  }
  if (want.desc) {
    const found = refs.find((node) => node.desc.includes(want.desc)) ?? refs.find((node) => node.text.includes(want.desc))
    if (!found) throw new Error(`界面上没有描述包含「${want.desc}」的控件：先 adb_ui 看当前界面。`)
    return found
  }
  throw new Error('需要 ref、text、id、desc 或 point 其中之一。')
}

/**
 * 最近一次 adb_ui 的完整节点数组，用来找可点祖先。
 * @param {string} serial - 设备。
 * @returns {any[]} 节点。
 */
function nodesOf(serial) {
  return lastTrees.get(serial)?.nodes ?? []
}

/**
 * 找最近的可点击祖先：文字节点本身常常不可点，按它的中心点会点空。
 * @param {any[]} nodes - 完整节点数组。
 * @param {any} node - 目标节点。
 * @returns {any} 可点击祖先（没有就返回原节点）。
 */
function clickTarget(nodes, node) {
  const area = (item) => Math.max(1, (item.x2 - item.x1) * (item.y2 - item.y1))
  const midX = (item) => (item.x1 + item.x2) / 2
  const midY = (item) => (item.y1 + item.y2) / 2
  let current = node
  for (let guard = 0; guard < 12; guard += 1) {
    if (current.clickable && current.enabled) {
      if (current === node) return node
      /* 可点祖先大得离谱、中心又离文字很远时，点文字自己：点进祖先中心常常是空白。 */
      const bigger = area(current) > area(node) * 6
      const far = Math.abs(midX(current) - midX(node)) > Math.max(40, (node.x2 - node.x1) / 2)
        || Math.abs(midY(current) - midY(node)) > Math.max(40, (node.y2 - node.y1) / 2)
      return bigger && far ? node : current
    }
    const parent = nodes[current.parent]
    if (!parent) return node
    current = parent
  }
  return node
}

/**
 * shell 单引号转义，给 `su -c` 用。
 * @param {string} text - 命令。
 * @returns {string} 转义后的命令。
 */
function shQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`
}

/**
 * 把文字转成 `input text` 能接受的形式：空格用 %s，shell 元字符单引号包起来。
 * 非 ASCII 字符（中文、emoji）`input text` 不支持，直接报错，不静默吞掉。
 * @param {string} text - 原文。
 * @returns {{ok: boolean, value: string, reason?: string}} 结果。
 */
function shellInputText(text) {
  const bad = [...text].filter((char) => char.charCodeAt(0) > 126)
  if (bad.length > 0) {
    return {
      ok: false,
      value: '',
      reason: `含非 ASCII 字符（${[...new Set(bad)].slice(0, 5).join('')}）：adb 的 input text 不支持中文输入。改用剪贴板或换 ASCII 输入。`,
    }
  }
  const escaped = text.replace(/ /g, '%s').replace(/'/g, `'\\''`)
  return { ok: true, value: `'${escaped}'` }
}

/**
 * 读 PNG 的 IHDR 尺寸（字节 16..24）。缩图后以文件为准，避免手算误差。
 * @param {string} path - PNG 路径。
 * @returns {Promise<{width: number, height: number}>} 尺寸。
 */
async function pngSize(path) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(24)
    await handle.read(buffer, 0, 24, 0)
    if (buffer.toString('latin1', 1, 4) !== 'PNG') return { width: 0, height: 0 }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  } finally {
    await handle.close()
  }
}

/**
 * 截图到临时文件，可选缩到长边 N 像素（默认 900）。
 * @param {string} serial - 设备。
 * @param {{scale?: number, path?: string}} options - 参数。
 * @returns {Promise<{path: string, bytes: number, width: number, height: number, ms: number}>} 结果。
 */
async function screenshot(serial, options) {
  const started = Date.now()
  const r = await adb(['-s', serial, 'exec-out', 'screencap', '-p'], { timeout: 30_000 })
  if (!r.ok || r.out.length === 0) throw new Error(`截图失败：${oneLine(r.err || '无输出', 160)}`)
  const buffer = r.raw
  const dir = join(tmpdir(), 'dsh-adb')
  await mkdir(dir, { recursive: true })
  const path = options.path || join(dir, `screen-${serial}-${Date.now()}.png`)
  await writeFile(path, buffer)
  const scale = options.scale ?? 900
  const original = await pngSize(path)
  if (scale > 0 && Math.max(original.width, original.height) > scale) {
    await new Promise((resolve) => execFile('sips', ['-Z', String(scale), path], () => resolve(undefined)))
  }
  const size = await pngSize(path)
  const bytes = await stat(path).then((value) => value.size).catch(() => buffer.length)
  return {
    path,
    bytes,
    width: size.width || original.width,
    height: size.height || original.height,
    ms: Date.now() - started,
  }
}

/**
 * 一个工具结果的渲染器：文本优先，结构化字段留在 JSON 里。
 * @param {string} text - 给模型看的文本。
 * @returns {any[]} 渲染块。
 */
function textBlock(text) {
  return [{ type: 'text', text }]
}

/**
 * 圈选区域里有哪些控件：把 ref 文本树按中心点收进矩形，供标注回传时
 * 让模型知道「圈的是这个按钮」而不只是看像素。
 * @param {string} serial - 设备序列号。
 * @param {{x: number, y: number, w: number, h: number}} rect - 设备坐标上的矩形。
 * @returns {Promise<string[]>} 最多 12 行控件描述。
 */
async function uiInRect(serial, rect) {
  if (!serial || !rect) return []
  const left = rect.x
  const top = rect.y
  const right = rect.x + rect.w
  const bottom = rect.y + rect.h
  let state
  try {
    state = await dumpState(serial, {})
  } catch {
    return []
  }
  const lines = []
  for (const node of state.nodes ?? []) {
    const cx = (node.x1 + node.x2) / 2
    const cy = (node.y1 + node.y2) / 2
    if (cx < left || cx > right || cy < top || cy > bottom) continue
    const label = node.text || node.desc || ''
    if (label === '' && node.id === '') continue
    lines.push(`${node.clickable ? '[可点] ' : ''}${label || shortClass(node.cls)}${node.id ? ` #${shortId(node.id)}` : ''} @${Math.round(cx)},${Math.round(cy)}`)
    if (lines.length >= 12) break
  }
  return lines
}

/**
 * 注册插件。
 * @param {any} ctx - Cordis 上下文。
 * @param {any} config - bundle patch 里的 config。
 */
export function apply(ctx, config) {
  const serial = async () => resolveSerial(config)

  /* 实时镜像：侧栏直播 + 标注回传 + 本机 3 分钟环形缓冲。 */
  const mirror = setupMirror(ctx, {
    adb: Object.assign(adb, { path: ADB }),
    resolveSerial: serial,
    uiInRect,
    recentActions,
  })
  ctx.effect(() => () => {
    mirror.stopAll()
    stopOcr()
    for (const device of [...shellChannels.keys()]) killShell(device)
  }, 'adb: 实时镜像退出')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_ui',
    description: [
      '读 Android 设备当前界面的文本树（一次约 0.12s，走设备端 uiautomator2 常驻服务），代替截图判断界面状态：文字、控件 id、坐标、是否可点。',
      '输出每行一个控件：ref、类型、文字、#资源id、@中心坐标，尾部 * 可点击 / ~ 可滚动 / [x] 勾选 / [off] 不可用；ref 可直接给 adb_tap。',
      '判断「页面对不对、有没有报错、按钮在不在」用它；只有要确认颜色/布局/相机画面时才用 adb_shot。',
      '要等界面变化（接口返回、跳转、弹窗）传 wait_for_text / wait_for_activity，不要 sleep 之后反复截图。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '只返回包含这段文字的控件行（不区分大小写）' },
        full: { type: 'boolean', description: '连没有文字的结构容器也返回，用于排查布局；默认只给有文字/可点击的节点' },
        max_nodes: { type: 'integer', description: `最多返回多少行，默认 ${MAX_NODES.default}` },
        wait_for_text: { type: 'string', description: '等到界面上出现这段文字再返回（子串匹配），配合 timeout_ms' },
        wait_for_id: { type: 'string', description: '等到界面上出现这个资源 id（子串匹配）' },
        wait_for_activity: { type: 'string', description: '等到前台 Activity 匹配这个正则，例如 "ScanActivity"' },
        wait_until_gone: { type: 'string', description: '等到这段文字从界面上消失，例如等加载提示消失' },
        timeout_ms: { type: 'integer', description: '等待上限，默认 15000' },
        changed_only: { type: 'boolean', description: '只给跟上一棵树不一样的控件行（+ 新增，- 消失），页面几乎没变时省一大截' },
        ocr: { type: 'string', enum: ['auto', 'force', 'off'], description: 'OCR 兜底：auto 只在文本树几乎为空时跑（默认），force 强制加一层 OCR 文字，off 关掉' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          serial: { type: 'string' },
          activity: { type: 'string' },
          summary: { type: 'string' },
          tree: { type: 'string' },
          changed: { type: 'boolean' },
          matched: { type: 'boolean' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['serial', 'activity', 'summary', 'tree', 'changed', 'matched', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(`${value.summary}\n${value.tree}`),
    },
    execute: async (args) => {
      const device = await serial()
      const started = Date.now()
      const want = {
        text: args.wait_for_text,
        id: args.wait_for_id,
        desc: undefined,
        activity: args.wait_for_activity,
        gone: args.wait_until_gone,
      }
      const shouldWait = Boolean(want.text || want.id || want.activity || want.gone)
      let state
      let matched = true
      if (shouldWait) {
        const waited = await waitFor(device, want, args.timeout_ms ?? 15_000)
        state = waited.state
        matched = waited.matched
      } else {
        state = await dumpState(device, { full: args.full === true, maxNodes: args.max_nodes, ocr: args.ocr ?? 'auto' })
      }
      const lines = state.tree.lines
      const filtered = args.filter
        ? lines.filter((line) => line.toLowerCase().includes(String(args.filter).toLowerCase()))
        : lines
      let shown = filtered.slice(0, MAX_NODES.max)
      if (args.changed_only === true) {
        const before = lastUiLines.get(device)
        const counts = new Map()
        for (const line of before ?? []) counts.set(line, (counts.get(line) ?? 0) + 1)
        const added = []
        const removed = []
        for (const line of filtered) {
          const left = counts.get(line) ?? 0
          if (left > 0) counts.set(line, left - 1)
          else added.push(`+ ${line}`)
        }
        for (const [line, left] of counts) for (let i = 0; i < left; i += 1) removed.push(`- ${line}`)
        shown = before === undefined ? filtered.slice(0, MAX_NODES.max) : [...removed, ...added]
        lastUiLines.set(device, filtered)
        if (shown.length === 0) shown = ['（界面没有变化）']
      } else {
        lastUiLines.set(device, filtered)
      }
      const summary = [
        `${state.serial} · ${state.activity || '未知页面'}`,
        `${state.tree.kept}/${state.tree.total} 节点${args.filter ? `，匹配 ${filtered.length}` : ''} · ${state.ms}ms`,
        state.source === 'uiautomator2' ? '' : `· 来源 ${state.source}`,
        state.ocrNote ?? '',
        state.changed ? '' : '（与上一次读取相同）',
        shouldWait ? (matched ? `等待命中，${Date.now() - started}ms` : `等待超时 ${args.timeout_ms ?? 15_000}ms，界面未变化`) : '',
      ].filter(Boolean).join(' · ')
      return {
        serial: state.serial,
        activity: state.activity,
        summary,
        tree: shown.join('\n') || '（没有匹配的控件）',
        changed: state.changed,
        matched,
        elapsed_ms: Date.now() - started,
      }
    },
  }), 'adb: adb_ui')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_tap',
    description: '在 Android 设备上点一下：用 ref（来自最近一次 adb_ui）、文字、资源 id、描述，或者绝对坐标 point="x,y"。long=true 长按。比截图定位快，也不会因为分辨率变化点错。',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'integer', description: 'adb_ui 返回的 ref 编号（只对最近一次 adb_ui 有效）' },
        text: { type: 'string', description: '按钮/文字内容，精确匹配优先，其次包含匹配' },
        id: { type: 'string', description: '资源 id，可写全名或只写后半段，如 login_btn' },
        desc: { type: 'string', description: 'content-desc 内容' },
        point: { type: 'string', description: '绝对坐标 "x,y"（屏幕像素）' },
        long: { type: 'boolean', description: '长按 600ms' },
        dry_run: { type: 'boolean', description: '只算落点、不真点（先用它确认点的是对的，避免点错返工）' },
        wait_for_text: { type: 'string', description: '点完等这段文字出现再返回，省掉一次 adb_ui 往返' },
        wait_for_id: { type: 'string', description: '点完等这个资源 id 出现' },
        wait_until_gone: { type: 'string', description: '点完等这段文字消失（关弹窗、等加载完）' },
        timeout_ms: { type: 'integer', description: '等待上限，默认 10000' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          target: { type: 'string' },
          activity: { type: 'string' },
          matched: { type: 'boolean' },
          message: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'target', 'activity', 'matched', 'message', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async (args) => {
      const device = await serial()
      const started = Date.now()
      let x
      let y
      let target
      if (args.point) {
        const parts = String(args.point).split(',').map((value) => Number(value.trim()))
        if (parts.length !== 2 || parts.some((value) => !Number.isFinite(value))) throw new Error('point 要写成 "x,y"，例如 "540,1200"。')
        ;[x, y] = parts
        target = `坐标 ${x},${y}`
      } else {
        /* 这次会话还没读过树就自动读一次：少一个来回，也不用先让模型调 adb_ui。 */
        if (!lastTrees.has(device)) await dumpState(device, {})
        const node = args.ref !== undefined
          ? nodeForRef(device, Number(args.ref))
          : nodeForSelector(device, { text: args.text, id: args.id, desc: args.desc })
        const hit = clickTarget(nodesOf(device), node)
        x = Math.round((hit.x1 + hit.x2) / 2)
        y = Math.round((hit.y1 + hit.y2) / 2)
        const label = node.text || node.desc || shortId(node.id) || shortClass(node.cls)
        const via = hit === node ? '' : `，落在可点祖先 ${shortClass(hit.cls)}${hit.id ? ` #${shortId(hit.id)}` : ''}`
        target = `「${oneLine(label, 24)}」@${x},${y}${via}`
      }
      /* 轻点用 input tap（一条命令 ~35ms）；长按只能靠 swipe 原地按住 600ms。 */
      if (args.dry_run) {
        return { ok: true, target, message: `预演：会${args.long ? '长按' : '点击'} ${target}（没有真点）。确认无误去掉 dry_run 再点。`, elapsed_ms: Date.now() - started }
      }
      const r = args.long
        ? await sh(device, `input swipe ${x} ${y} ${x} ${y} 600`, 10_000)
        : await sh(device, `input tap ${x} ${y}`, 10_000)
      if (!r.ok) throw new Error(`点击失败：${oneLine(r.out || '命令超时', 200)}`)

      lastActions.push({ at: Date.now(), what: `${args.long ? '长按' : '点击'} ${target}` })
      /* 点完顺手等结果：一次工具调用顶「点一下 + 再读一次树」，省一个模型回合。 */
      const want = { text: args.wait_for_text, id: args.wait_for_id, gone: args.wait_until_gone, activity: undefined }
      const shouldWait = Boolean(want.text || want.id || want.gone)
      let activity = ''
      let matched = true
      let detail = ''
      if (shouldWait) {
        const waited = await waitFor(device, want, args.timeout_ms ?? 10_000)
        matched = waited.matched
        activity = waited.state.activity
        detail = matched
          ? `，等待命中 ${waited.elapsedMs}ms · 当前 ${activity || '未知页面'}`
          : `，等待超时 ${args.timeout_ms ?? 10_000}ms，界面没出现预期变化`
      }
      const message = `${args.long ? '长按' : '点击'} ${target} 完成（${r.ms}ms）${detail || '。界面变化用 adb_ui 确认。'}`
      return { ok: true, target, activity, matched, message, elapsed_ms: Date.now() - started }
    },
  }), 'adb: adb_tap')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_gesture',
    description: '真人轨迹手势：给一串坐标点，设备端逐点发 DOWN/MOVE/UP。两个点是直线，多个点是曲线；能做曲线拖拽、按住再拖、慢速滑，比 input swipe 的直线更像手指。逐条 input 有约 35ms 下限，单次段数 3–40。',
    parameters: {
      type: 'object',
      properties: {
        points: {
          type: 'array',
          items: { type: 'array', items: { type: 'integer' } },
          description: '轨迹点 [[x,y],[x,y],…]，至少 2 个；曲线要给中间点',
        },
        duration_ms: { type: 'integer', description: '整段耗时，默认 500' },
        hold_ms: { type: 'integer', description: '起点按住多久再移动，默认 0；长按拖动给 500' },
      },
      required: ['points'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'message', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async (args) => {
      const device = await serial()
      const started = Date.now()
      const points = (args.points ?? []).map((pair) => pair.map((value) => Math.round(Number(value))))
      if (points.length < 2) throw new Error('points 至少给 2 个点，例如 [[540,1800],[900,1200]]。')
      for (const pair of points) {
        if (pair.length !== 2 || pair.some((value) => !Number.isFinite(value))) throw new Error('每个点都要写成 [x,y]。')
      }
      const duration = Math.max(60, Number(args.duration_ms ?? 500))
      const hold = Math.max(0, Number(args.hold_ms ?? 0))
      /* 每个点沿折线按长度均分，段数受 35ms/条的设备端下限约束。 */
      const steps = Math.max(3, Math.min(40, Math.round(duration / 40)))
      const segmentLengths = []
      let total = 0
      for (let index = 1; index < points.length; index += 1) {
        const length = Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1])
        segmentLengths.push(length)
        total += length
      }
      const path = [points[0]]
      for (let step = 1; step <= steps; step += 1) {
        let remaining = (total * step) / steps
        let cursor = 0
        while (cursor < segmentLengths.length - 1 && remaining > segmentLengths[cursor]) {
          remaining -= segmentLengths[cursor]
          cursor += 1
        }
        const ratio = segmentLengths[cursor] === 0 ? 0 : remaining / segmentLengths[cursor]
        const from = points[cursor]
        const to = points[cursor + 1] ?? points[cursor]
        path.push([Math.round(from[0] + (to[0] - from[0]) * ratio), Math.round(from[1] + (to[1] - from[1]) * ratio)])
      }
      const pause = Math.max(0, duration / steps / 1000 - 0.035).toFixed(3)
      const script = [`input motionevent DOWN ${path[0].join(' ')}`]
      if (hold > 0) script.push(`sleep ${(hold / 1000).toFixed(3)}`)
      for (const point of path.slice(1)) script.push(`sleep ${pause}`, `input motionevent MOVE ${point.join(' ')}`)
      script.push(`input motionevent UP ${path[path.length - 1].join(' ')}`)
      const r = await sh(device, script.join('; '), 30_000)
      if (!r.ok) throw new Error(`手势失败：${oneLine(r.out || '命令超时', 200)}`)
      lastActions.push({ at: Date.now(), what: `手势 ${points[0].join(',')}→${points[points.length - 1].join(',')}（${duration}ms）` })
      return {
        ok: true,
        message: `手势完成：${points.length} 个控制点 / ${path.length} 步 / 约 ${duration}ms，${Date.now() - started}ms 返回。`,
        elapsed_ms: Date.now() - started,
      }
    },
  }), 'adb: adb_gesture')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_input',
    description: '往 Android 设备输入：text 输入文字（只支持 ASCII，空格自动转义）、key 按键（如 ENTER/BACK/DEL/HOME）、swipe 滑动 [x1,y1,x2,y2,ms]、clear=true 先清空输入框。中文输入 adb 原生不支持，会明确报错。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文字（ASCII）；先点中输入框再调用' },
        key: { type: 'string', description: '按键名，如 ENTER、BACK、HOME、DEL、TAB、APP_SWITCH，或数字 keycode' },
        swipe: {
          type: 'array',
          items: { type: 'integer' },
          description: '滑动 [x1,y1,x2,y2] 或 [x1,y1,x2,y2,毫秒]，例如 [1000,2000,1000,500,400]',
        },
        clear: { type: 'boolean', description: '输入前先清空当前聚焦输入框（END + 多次 DEL）' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'message', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async (args) => {
      const device = await serial()
      const started = Date.now()
      const messages = []
      if (args.clear) {
        await sh(device, 'input keyevent KEYCODE_MOVE_END; for i in $(seq 40); do input keyevent KEYCODE_DEL; done', 20_000)
        messages.push('已清空输入框')
      }
      if (args.text !== undefined) {
        const encoded = shellInputText(String(args.text))
        if (!encoded.ok) throw new Error(encoded.reason)
        const r = await sh(device, `input text ${encoded.value}`, 15_000)
        if (!r.ok) throw new Error(`输入失败：${oneLine(r.out || '命令超时', 200)}`)
        lastActions.push({ at: Date.now(), what: `输入文字 ${String(args.text).length} 字` })
        messages.push(`已输入 ${String(args.text).length} 个字符`)
      }
      if (args.key !== undefined) {
        const key = String(args.key).trim()
        const name = /^\d+$/.test(key) ? key : key.toUpperCase()
        const r = await sh(device, `input keyevent ${name}`, 8000)
        if (!r.ok) throw new Error(`按键失败：${oneLine(r.out || '命令超时', 200)}`)
        lastActions.push({ at: Date.now(), what: `按键 ${name}` })
        messages.push(`已按 ${name}`)
      }
      if (Array.isArray(args.swipe)) {
        const values = args.swipe.map((value) => Number(value))
        if (values.length < 4) throw new Error('swipe 至少给 4 个数：x1,y1,x2,y2')
        const duration = values[4] ?? 300
        const r = await sh(device, `input swipe ${values.slice(0, 4).join(' ')} ${duration}`, 15_000)
        if (!r.ok) throw new Error(`滑动失败：${oneLine(r.out || '命令超时', 200)}`)
        lastActions.push({ at: Date.now(), what: `滑动 ${values.slice(0, 4).join(',')}` })
        messages.push(`已滑动 ${values.slice(0, 4).join(',')}（${duration}ms）`)
      }
      if (messages.length === 0) throw new Error('没有要执行的动作：给 text、key、swipe 或 clear 其中之一。')
      return { ok: true, message: `${messages.join('；')}。`, elapsed_ms: Date.now() - started }
    },
  }), 'adb: adb_input')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_app',
    description: '管理 Android 应用：info 看版本号/版本名/前台页面，install 装 APK（-r 覆盖，等安装完成），start 启动，stop 强制停止，clear 清数据，foreground 只看当前前台页面。装完真机后用它确认 versionCode 有没有变。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['info', 'install', 'start', 'stop', 'clear', 'foreground'], description: '要做的操作' },
        package: { type: 'string', description: '包名，如 com.example.app；install 时可省略（从 APK 里读）' },
        apk: { type: 'string', description: 'install 用的 APK 绝对路径' },
        activity: { type: 'string', description: 'start 时可指定 Activity，例如 .ScanActivity；不写就用启动器入口' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          message: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'action', 'message', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async (args) => {
      const device = await serial()
      const started = Date.now()
      const action = args.action
      const pkg = args.package ? String(args.package) : ''
      if (action === 'foreground') {
        const activity = await foregroundActivity(device)
        return { ok: true, action, message: `前台页面：${activity || '未知'}`, elapsed_ms: Date.now() - started }
      }
      if (action === 'install') {
        if (!args.apk) throw new Error('install 需要 apk 路径（绝对路径）。')
        const r = await adb(['-s', device, 'install', '-r', '-d', String(args.apk)], { timeout: 180_000, buffer: 8 << 20 })
        const ok = /Success/i.test(r.out)
        if (!ok) throw new Error(`安装失败：${oneLine(r.out || r.err, 300)}`)
        return { ok: true, action, message: `安装完成（${r.ms}ms）：${oneLine(r.out, 120)}`, elapsed_ms: Date.now() - started }
      }
      if (!pkg) throw new Error(`${action} 需要 package。`)
      if (action === 'info') {
        const r = await adb(['-s', device, 'shell', `dumpsys package ${pkg}`], { timeout: 15_000 })
        const versionCode = /versionCode=(\d+)/.exec(r.out)?.[1] ?? '?'
        const versionName = /versionName=([^\s]+)/.exec(r.out)?.[1] ?? '?'
        const installed = r.out.includes(`Package [${pkg}]`) || r.out.includes(pkg)
        if (!installed) throw new Error(`设备上没有安装 ${pkg}。`)
        const activity = await foregroundActivity(device)
        return {
          ok: true,
          action,
          message: `${pkg} · versionCode=${versionCode} · versionName=${versionName} · 前台：${activity || '未知'}`,
          elapsed_ms: Date.now() - started,
        }
      }
      if (action === 'start') {
        const component = args.activity ? `${pkg}/${String(args.activity).startsWith('.') ? String(args.activity) : `.${args.activity}`}` : ''
        const cmd = component ? `am start -n ${component}` : `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`
        const r = await adb(['-s', device, 'shell', cmd], { timeout: 20_000 })
        if (!r.ok || /No activities found|Error/i.test(`${r.out}${r.err}`)) throw new Error(`启动失败：${oneLine(r.out || r.err, 240)}`)
        await new Promise((resolve) => setTimeout(resolve, 600))
        const activity = await foregroundActivity(device)
        return { ok: true, action, message: `已启动 ${pkg}，前台：${activity || '未知'}`, elapsed_ms: Date.now() - started }
      }
      if (action === 'stop' || action === 'clear') {
        const cmd = action === 'stop' ? `am force-stop ${pkg}` : `pm clear ${pkg}`
        const r = await adb(['-s', device, 'shell', cmd], { timeout: 20_000 })
        if (!r.ok || /Error/i.test(`${r.out}${r.err}`)) throw new Error(`${action} 失败：${oneLine(r.out || r.err, 240)}`)
        return { ok: true, action, message: `${action === 'stop' ? '已强制停止' : '已清除数据'} ${pkg}`, elapsed_ms: Date.now() - started }
      }
      throw new Error(`未知 action：${action}`)
    },
  }), 'adb: adb_app')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_sh',
    description: '在 Android 设备上跑一条 shell 命令，返回截断后的文本（最多 20k 字符）。日志用：logcat -d -t 300 或 logcat -d -s TAG；查页面/服务用 dumpsys activity top / dumpsys package。需要「看日志有没有报错」时用它，不要截图。',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: '设备端的 shell 命令，例如 "logcat -d -t 200" 或 "dumpsys activity top | head -40"' },
        root: { type: 'boolean', description: '以 root 执行（设备已 root 时读 /data/data、settings、dropbox 等）' },
        timeout_ms: { type: 'integer', description: '超时，默认 15000' },
      },
      required: ['cmd'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          output: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'output', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.output),
    },
    execute: async (args) => {
      const device = await serial()
      const raw = String(args.cmd)
      const cmd = args.root ? `su -c ${shQuote(raw)}` : raw
      const wait = Math.min(120_000, Number(args.timeout_ms ?? 15_000))
      const r = args.root
        ? await adb(['-s', device, 'shell', cmd], { timeout: wait, buffer: 16 << 20 })
        : await sh(device, cmd, wait)
      const body = `${r.out}${r.err ?? ''}`.trim()
      const output = body.length > OUTPUT_LIMIT ? `${body.slice(0, OUTPUT_LIMIT)}\n…（截断，原长 ${body.length} 字符）` : body
      return { ok: r.ok, output: output || '（无输出）', elapsed_ms: r.ms }
    },
  }), 'adb: adb_sh')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_do',
    description: [
      '一串动作一次调用跑完：点、滑、输入、按键、系统动作、等界面。',
      '每一步都能带上「等它生效」的条件，跑完一次性给结果；适合「点开→等加载→输入→发送」这种连着做的流程，比一步步调工具少好几个回合。',
      'steps 按顺序执行，任何一步失败就停，并报出是哪一步。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: {
              tap: { type: 'string', description: '点哪个：文字内容，或用 "x,y" 坐标' },
              id: { type: 'string', description: '按资源 id 点' },
              swipe: { type: 'array', items: { type: 'integer' }, description: '滑动 [x1,y1,x2,y2,毫秒]' },
              key: { type: 'string', description: '按键名：BACK / HOME / ENTER，或 keycode 数字' },
              text: { type: 'string', description: '往焦点输入框输入（仅 ASCII）' },
              action: { type: 'string', description: '系统动作：home / back / recents / lock / wake / notifications / quick_settings' },
              wait_text: { type: 'string', description: '等这段文字出现再做下一步' },
              wait_gone: { type: 'string', description: '等这段文字消失再做下一步' },
              sleep_ms: { type: 'integer', description: '硬等多久（尽量用 wait_text 代替）' },
            },
            additionalProperties: false,
          },
        },
        timeout_ms: { type: 'integer', description: '每步等待上限，默认 8000' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          steps: { type: 'integer' },
          activity: { type: 'string' },
          summary: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'steps', 'activity', 'summary', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.summary),
    },
    execute: async (args) => {
      const device = await serial()
      const began = Date.now()
      const limit = args.timeout_ms ?? 8000
      const done = []
      let activity = ''
      for (const [index, step] of (args.steps ?? []).entries()) {
        const at = index + 1
        if (step.tap !== undefined || step.id !== undefined) {
          let node
          let point = null
          if (step.tap !== undefined && /^\s*-?\d+\s*,\s*-?\d+\s*$/.test(String(step.tap))) {
            const parts = String(step.tap).split(',').map((value) => Number(value.trim()))
            point = { x: parts[0], y: parts[1] }
          } else {
            if (!lastTrees.has(device)) await dumpState(device, {})
            node = nodeForSelector(device, { text: step.tap, id: step.id })
          }
          let target
          if (point !== null) {
            target = { x: point.x, y: point.y, label: `坐标 ${point.x},${point.y}` }
          } else {
            const hit = clickTarget(nodesOf(device), node)
            const x = Math.round((hit.x1 + hit.x2) / 2)
            const y = Math.round((hit.y1 + hit.y2) / 2)
            target = { x, y, label: `「${oneLine(node.text || node.desc || shortId(node.id) || shortClass(node.cls), 20)}」@${x},${y}` }
          }
          const r = await sh(device, `input tap ${target.x} ${target.y}`, 10_000)
          if (!r.ok) throw new Error(`第 ${at} 步点击失败：${oneLine(r.out || '命令超时', 160)}`)
          lastActions.push({ at: Date.now(), what: `点击 ${target.label}` })
          done.push(`点 ${target.label}`)
        } else if (step.swipe !== undefined) {
          const s4 = step.swipe
          if (!Array.isArray(s4) || s4.length < 4) throw new Error(`第 ${at} 步 swipe 要写 [x1,y1,x2,y2,毫秒]。`)
          const ms = s4[4] ?? 300
          const r = await sh(device, `input swipe ${s4[0]} ${s4[1]} ${s4[2]} ${s4[3]} ${ms}`, 15_000)
          if (!r.ok) throw new Error(`第 ${at} 步滑动失败：${oneLine(r.out || '命令超时', 160)}`)
          done.push(`滑 ${s4[0]},${s4[1]}→${s4[2]},${s4[3]}`)
        } else if (step.key !== undefined) {
          const code = /^\d+$/.test(String(step.key)) ? String(step.key) : String(step.key).toUpperCase()
          const r = await sh(device, `input keyevent ${code}`, 10_000)
          if (!r.ok) throw new Error(`第 ${at} 步按键失败：${oneLine(r.out || '命令超时', 160)}`)
          done.push(`键 ${code}`)
        } else if (step.text !== undefined) {
          const bad = [...String(step.text)].filter((char) => char.charCodeAt(0) > 127)
          if (bad.length > 0) throw new Error(`第 ${at} 步含非 ASCII 字符（${[...new Set(bad)].slice(0, 5).join('')}），adb input text 不支持中文。`)
          const r = await sh(device, `input text '${String(step.text).replace(/'/g, "'\\''")}'`, 15_000)
          if (!r.ok) throw new Error(`第 ${at} 步输入失败：${oneLine(r.out || '命令超时', 160)}`)
          done.push(`输入 ${oneLine(String(step.text), 20)}`)
        } else if (step.action !== undefined) {
          const cmd = ACTION_MAP[step.action]
          if (cmd === undefined) throw new Error(`第 ${at} 步 action 不认识：${step.action}`)
          const r = await sh(device, cmd, 12_000)
          if (!r.ok) throw new Error(`第 ${at} 步系统动作失败：${oneLine(r.out || '命令超时', 160)}`)
          done.push(step.action)
        }

        if (step.wait_text !== undefined || step.wait_gone !== undefined) {
          const waited = await waitFor(device, { text: step.wait_text, gone: step.wait_gone }, limit)
          activity = waited.state.activity
          if (!waited.matched) throw new Error(`第 ${at} 步等界面超时 ${limit}ms：${step.wait_text ? `没等到「${step.wait_text}」` : `「${step.wait_gone}」还在`}`)
          done.push(`等 ${step.wait_text ?? '界面变化'} ${waited.elapsedMs}ms`)
        } else if (step.sleep_ms !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(Number(step.sleep_ms) || 0, 15_000)))
          done.push(`等 ${step.sleep_ms}ms`)
        }
      }
      if (activity === '') activity = (await foregroundActivity(device).catch(() => '')) || ''
      const summary = [`${done.length} 步跑完（${Date.now() - began}ms）`, `当前 ${activity || '未知页面'}`, '', ...done.map((line, index) => `${index + 1}. ${line}`)].join('\n')
      return { ok: true, steps: done.length, activity, summary, elapsed_ms: Date.now() - began }
    },
  }), 'adb: adb_do')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_anim',
    description: [
      '录一段界面动效：按 fps 反复读界面树，输出目标控件的大小/位置随时间的变化、抖动次数、超调、缓动形状，可同时在采样期间点一下触发动画。',
      '用于「桌宠变大不协调」「按钮弹跳生硬」「转场卡顿」这类动态问题——把肉眼感觉变成数字，比连拍截图准得多（单帧 150–250ms，实测 5–7 帧/秒）。',
      '目标给 ref（先 adb_ui）、text 或 id。trigger 里放采样期间要执行的动作（tap / swipe / text / action），采样不等它，边动边录。',
      '局限：读的是控件树坐标，列表滚动、页面转场这类合成器驱动的动画可能全程报「没变」，那种改用帧序列看。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'integer', description: '目标控件 ref，来自最近一次 adb_ui（和 text/id 三选一）' },
        text: { type: 'string', description: '目标控件文字' },
        id: { type: 'string', description: '目标控件资源 id' },
        duration_ms: { type: 'integer', description: '采样时长，默认 2000，上限 20000' },
        fps: { type: 'integer', description: '采样频率，默认 6，上限 10（受单帧 150ms 限制）' },
        trigger: {
          type: 'array',
          description: '采样开始后执行的动作，最多 4 步；每步可用 tap / id / text / action',
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              tap: { type: 'string', description: '文字内容，或 "x,y" 坐标' },
              swipe: { type: 'array', description: '滑动 [x1,y1,x2,y2,毫秒]', items: { type: 'integer' } },
              id: { type: 'string', description: '资源 id' },
              text: { type: 'string', description: '要输入的文字（ASCII）' },
              action: { type: 'string', description: '系统动作，同 adb_action' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          target: { type: 'string' },
          samples: { type: 'integer' },
          fps: { type: 'number' },
          metrics: { type: 'object' },
          timeline: { type: 'array' },
          summary: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'target', 'samples', 'fps', 'metrics', 'timeline', 'summary', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.summary),
    },
    execute: async (args) => {
      const device = await serial()
      const began = Date.now()
      const duration = Math.min(Math.max(args.duration_ms ?? 2000, 300), 20_000)
      const wantedFps = Math.min(Math.max(args.fps ?? 6, 2), 10)
      if (!lastTrees.has(device)) await dumpState(device, {})
      const seed = args.ref !== undefined ? nodeForRef(device, args.ref) : nodeForSelector(device, { text: args.text, id: args.id })
      const key = { text: seed.text, id: seed.id, desc: seed.desc }
      const seedX = (seed.x1 + seed.x2) / 2
      const seedY = (seed.y1 + seed.y2) / 2
      const matches = (node) => {
        if (key.text && (node.text === key.text || node.desc === key.text)) return true
        if (key.desc && node.desc === key.desc) return true
        if (key.id && shortId(node.id) === shortId(key.id)) return true
        return false
      }
      /* 同一段文字可能存在多份（离屏副本、左右分栏），取离起始位置最近的那个，否则会盯错对象。 */
      const find = (nodes) => {
        let best = null
        let bestDistance = Number.POSITIVE_INFINITY
        for (const node of nodes) {
          if (!matches(node)) continue
          const distance = Math.hypot((node.x1 + node.x2) / 2 - seedX, (node.y1 + node.y2) / 2 - seedY)
          if (distance < bestDistance) {
            best = node
            bestDistance = distance
          }
        }
        return best
      }
      const timeline = []
      let triggered = false
      const trigger = Array.isArray(args.trigger) ? args.trigger : []
      const finish = Date.now() + duration
      while (Date.now() < finish) {
        const at = Date.now() - began
        let state
        try {
          state = await dumpState(device, { activity: false })
        } catch {
          break
        }
        const hit = find(state.nodes) ?? (timeline.length > 0 ? null : seed)
        if (hit) {
          timeline.push({
            at,
            x: Math.round((hit.x1 + hit.x2) / 2),
            y: Math.round((hit.y1 + hit.y2) / 2),
            w: hit.x2 - hit.x1,
            h: hit.y2 - hit.y1,
            found: true,
          })
        } else {
          timeline.push({ at, x: null, y: null, w: null, h: null, found: false })
        }
        if (!triggered && trigger.length > 0 && timeline.length === 1) {
          triggered = true
          /* 不 await：边滑边采样才录得到过程中的每一帧。 */
          void (async () => { for (const step of trigger) {
            try {
              if (step.action) {
                await adb(['-s', device, 'shell', ACTION_MAP[step.action] ?? '', ], { timeout: 6000 })
                continue
              }
              if (step.text !== undefined) {
                await adb(['-s', device, 'shell', 'input', 'text', String(step.text).replace(/ /g, '%s')], { timeout: 8000 })
                continue
              }
              if (Array.isArray(step.swipe)) {
                await adb(['-s', device, 'shell', 'input', 'swipe', ...step.swipe.map(String)], { timeout: 10_000 })
                continue
              }
              if (step.tap !== undefined && /^-?\d+,-?\d+$/.test(String(step.tap))) {
                const [tx, ty] = String(step.tap).split(',').map(Number)
                await adb(['-s', device, 'shell', 'input', 'tap', String(tx), String(ty)], { timeout: 8000 })
                continue
              }
              const target = step.id
                ? nodeForSelector(device, { id: step.id })
                : nodeForSelector(device, { text: step.tap })
              const landed = clickTarget(state.nodes, target)
              await adb(['-s', device, 'shell', 'input', 'tap', String(Math.round((landed.x1 + landed.x2) / 2)), String(Math.round((landed.y1 + landed.y2) / 2))], { timeout: 8000 })
            } catch {
              /* 触发动作失败不影响采样 */
            }
          } })()
        }
        const stepMs = 1000 / wantedFps
        const rest = stepMs - (Date.now() - began - at)
        if (rest > 0) await dshSleep(rest)
      }
      const hits = timeline.filter((row) => row.found)
      if (hits.length === 0) throw new Error(`采样 ${duration}ms 里一次也没找到「${(args.text ?? args.id ?? `ref=${args.ref}`)}」：动画期间控件可能被移除，换个更稳定的对象再试。`)
      const sizes = hits.map((row) => row.w * row.h)
      const firstSize = sizes[0]
      const lastSize = sizes[sizes.length - 1]
      const maxSize = Math.max(...sizes)
      const minSize = Math.min(...sizes)
      const overshoot = (lastSize - firstSize) >= 0 ? maxSize - lastSize : lastSize - minSize
      const sizeSteps = sizes.slice(1).map((size, index) => size - sizes[index])
      let reversals = 0
      for (let index = 1; index < sizeSteps.length; index += 1) {
        if (sizeSteps[index] !== 0 && sizeSteps[index - 1] !== 0 && Math.sign(sizeSteps[index]) !== Math.sign(sizeSteps[index - 1])) reversals += 1
      }
      const deltas = hits.slice(1).map((row, index) => Math.abs(row.w - hits[index].w) + Math.abs(row.h - hits[index].h))
      const meanDelta = deltas.length > 0 ? deltas.reduce((sum, value) => sum + value, 0) / deltas.length : 0
      const peakDelta = deltas.length > 0 ? Math.max(...deltas) : 0
      const motionSpan = Math.abs(lastSize - firstSize)
      const settleIndex = motionSpan === 0
        ? 0
        : Math.max(0, [...deltas].reverse().findIndex((value) => value >= Math.max(2, motionSpan * 0.02)))
      const settleAt = settleIndex === 0 && motionSpan !== 0 ? (hits[hits.length - 1]?.at ?? 0) - (hits[0]?.at ?? 0) : (hits[Math.max(0, hits.length - 1 - settleIndex)]?.at ?? 0) - (hits[0]?.at ?? 0)
      const metrics = {
        frames: hits.length,
        fps: Number(((hits.length / Math.max(1, timeline[timeline.length - 1].at - timeline[0].at)) * 1000).toFixed(1)),
        w: [hits[0].w, hits[hits.length - 1].w],
        h: [hits[0].h, hits[hits.length - 1].h],
        area: [firstSize, lastSize],
        area_min: minSize,
        area_max: maxSize,
        overshoot_px: Math.round(overshoot),
        reversals,
        mean_step_px: Math.round(meanDelta),
        peak_step_px: Math.round(peakDelta),
        smoothness: meanDelta === 0 ? 0 : Number((peakDelta / meanDelta).toFixed(2)),
        settle_ms: Math.round(settleAt),
        center_start: [hits[0].x, hits[0].y],
        center_end: [hits[hits.length - 1].x, hits[hits.length - 1].y],
      }
      const verdict = []
      if (overshoot > Math.max(8, Math.abs(lastSize - firstSize) * 0.08)) verdict.push(`超调 ${metrics.overshoot_px}px（回弹过头）`)
      if (reversals >= 3) verdict.push(`大小来回改了 ${reversals} 次（抖动）`)
      if (metrics.smoothness > 3) verdict.push(`帧间跳变不均：峰值 ${metrics.peak_step_px}px vs 均值 ${metrics.mean_step_px}px`)
      if (Math.abs(lastSize - firstSize) < 4) verdict.push('全程尺寸几乎没变（这期间可能没有动画）')
      if (verdict.length === 0) verdict.push('尺寸变化单调、无超调、帧间步长均匀')
      const rows = hits.filter((_row, index) => index % Math.max(1, Math.ceil(hits.length / 16)) === 0)
      const summary = [
        `${hits.length} 帧 / ${metrics.fps} fps · 目标「${key.text || key.id || `ref=${args.ref}`}」`,
        `尺寸 ${hits[0].w}×${hits[0].h} → ${hits[hits.length - 1].w}×${hits[hits.length - 1].h}（面积 ${firstSize} → ${lastSize}，峰值 ${maxSize}）`,
        `判定：${verdict.join('；')}`,
        `稳定于 ${metrics.settle_ms}ms · 抖动 ${reversals} 次 · 平滑度 ${metrics.smoothness}（峰值/均值步长）`,
        '',
        't(ms) 中心 宽×高',
        ...rows.map((row) => `${String(row.at).padStart(5)} ${row.x},${row.y} ${row.w}×${row.h}`),
      ].join('\n')
      return { ok: true, target: key.text || key.id || `ref=${args.ref}`, samples: hits.length, fps: metrics.fps, metrics, timeline, summary, elapsed_ms: Date.now() - began }
    },
  }), 'adb: adb_anim')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_proc',
    description: '看设备上的进程与内存：top 给最吃 CPU 的进程，mem 给指定包的内存明细，list 列进程。排查卡顿/被杀/内存涨先看这里。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['top', 'mem', 'list'], description: '默认 top' },
        package: { type: 'string', description: 'mem 用：包名，如 com.example.app' },
        lines: { type: 'integer', description: '最多回多少行，默认 20，上限 80' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          text: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'summary', 'text', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(`${value.summary}\n${value.text}`),
    },
    execute: async (args) => {
      const device = await serial()
      const began = Date.now()
      const action = args.action ?? 'top'
      const limit = Math.min(Math.max(args.lines ?? 20, 3), 80)
      let command
      if (action === 'mem') {
        if (!args.package) throw new Error('mem 需要 package：例如 com.example.app。')
        command = `dumpsys meminfo ${args.package} | head -${limit}`
      } else if (action === 'list') {
        command = `ps -A -o PID,RSS,NAME | head -${limit}`
      } else {
        command = `dumpsys cpuinfo | head -${limit}`
      }
      const result = await adb(['-s', device, 'shell', command], { timeout: 15_000 })
      const text = (result.out || '').replace(/\r/g, '').trim()
      return { ok: result.ok !== false, summary: `adb_proc ${action}（${Date.now() - began}ms）`, text: text || oneLine(result.err, 200), elapsed_ms: Date.now() - began }
    },
  }), 'adb: adb_proc')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_web',
    description: [
      '直读 App 里 WebView 的 DOM（走 devtools 协议，比文本树准）：list 列页面，dom 按选择器取元素矩形与文字，eval 跑一段 JS。',
      '混合 App（内嵌 H5）定位不准时优先用它；返回 CSS 像素矩形，附带换算到设备像素的比例，可直接喂 adb_tap point。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'dom', 'eval'], description: '默认 list' },
        package: { type: 'string', description: '包名（必填）：用来找 WebView 进程' },
        selector: { type: 'string', description: 'dom 用：CSS 选择器，默认 *，只回有直接文字的元素' },
        expression: { type: 'string', description: 'eval 用：要执行的 JS 表达式（返回值按 JSON 回）' },
        lines: { type: 'integer', description: '最多回多少个元素，默认 20' },
        webPort: { type: 'integer', description: '已手动 adb forward 时直接用这个本机端口，跳过自动查找' },
      },
      required: ['package'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          text: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'summary', 'text', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(`${value.summary}\n${value.text}`),
    },
    execute: async (args) => {
      const device = await serial()
      const began = Date.now()
      const target = args.webPort ? { pid: '0', socketPid: '手动转发', port: args.webPort } : await webTarget(device, args.package)
      const pagesResponse = await fetch(`http://127.0.0.1:${target.port}/json/list`, { signal: AbortSignal.timeout(6000) }).catch((error) => {
        throw new Error(`WebView 调试口连不上：${oneLine(error.message, 120)}（App 可能没开 WebView 调试）`)
      })
      const pages = await pagesResponse.json().catch(() => [])
      const page = pages.find((item) => item.webSocketDebuggerUrl && String(item.type) === 'page') ?? pages[0]
      if ((args.action ?? 'list') === 'list') {
        const lines = pages.map((item) => `${item.title || '(无标题)'} · ${oneLine(item.url, 90)}`)
        return { ok: true, summary: `${pages.length} 个页面（进程 ${target.socketPid || target.pid}）`, text: lines.join('\n') || '没有页面', elapsed_ms: Date.now() - began }
      }
      if (!page?.webSocketDebuggerUrl) throw new Error('这个 WebView 没有可用的调试页面。')
      const limit = Math.min(Math.max(args.lines ?? 20, 1), 60)
      const expression = args.action === 'dom'
        ? `(() => {
            const out = [];
            const nodes = Array.from(document.querySelectorAll(${JSON.stringify(args.selector ?? '*')}));
            for (const el of nodes) {
              const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
              const label = own || (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
              if (!label) continue;
              const r = el.getBoundingClientRect();
              if (r.width < 2 || r.height < 2) continue;
              out.push({ tag: el.tagName.toLowerCase(), text: label.slice(0, 60), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
              if (out.length >= ${limit}) break;
            }
            return { viewport: { iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, sw: screen.width, sh: screen.height }, items: out };
          })()`
        : `(() => { const value = (${args.expression ?? 'document.title'}); return { viewport: { iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, sw: screen.width, sh: screen.height }, value }; })()`
      const reply = await wsCall(page.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 8000)
      if (reply.error) throw new Error(`WebView 执行失败：${oneLine(reply.error.message, 160)}`)
      const result = reply.result?.result?.value
      if (!result) throw new Error('WebView 没有返回值（页面可能已跳转）。')
      const scale = result.viewport.iw > 0 ? result.viewport.sw / result.viewport.iw : 1
      if (args.action === 'eval') {
        const text = typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2)
        return { ok: true, summary: `eval 完成 · viewport ${result.viewport.iw}×${result.viewport.ih} 缩放 ${scale.toFixed(2)}`, text: oneLine(text, 8000), elapsed_ms: Date.now() - began }
      }
      const rows = (result.items ?? []).map((item) => {
        const cx = Math.round((item.x + item.w / 2) * scale)
        const cy = Math.round((item.y + item.h / 2) * scale)
        return `<${item.tag}> "${oneLine(item.text, 40)}" css ${item.x},${item.y} ${item.w}×${item.h} → 点 ${cx},${cy}`
      })
      return {
        ok: true,
        summary: `${rows.length} 个元素 · viewport ${result.viewport.iw}×${result.viewport.ih} → 设备 ${result.viewport.sw}×${result.viewport.sh}（×${scale.toFixed(2)}）`,
        text: rows.join('\n') || '选择器没匹配到带文字的元素',
        elapsed_ms: Date.now() - began,
      }
    },
  }), 'adb: adb_web')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_action',
    description: [
      '系统级动作一条命令完成，不用在界面里找按钮：home / back / recents / lock / wake / rotate / notifications / quick_settings / night_mode。',
      '走设备 shell（常驻通道，一次 10–40ms），比点界面稳；点亮屏幕、收紧通知栏、转屏这类用它。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['home', 'back', 'recents', 'lock', 'wake', 'rotate', 'notifications', 'quick_settings', 'night_mode'],
          description: '要执行的系统动作',
        },
        degrees: { type: 'integer', enum: [0, 90, 180, 270], description: 'rotate 用：指定方向；不写就转到下一个方向' },
        enable: { type: 'boolean', description: 'night_mode 用：true 开夜间模式，false 关' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          summary: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['ok', 'summary', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.summary),
    },
    execute: async (args) => {
      const device = await serial()
      const began = Date.now()
      let cmd
      let label
      if (args.action === 'home') { cmd = 'input keyevent 3'; label = '回桌面' }
      else if (args.action === 'back') { cmd = 'input keyevent 4'; label = '返回' }
      else if (args.action === 'recents') { cmd = 'input keyevent 187'; label = '最近任务' }
      else if (args.action === 'lock') { cmd = 'input keyevent 223'; label = '锁屏' }
      else if (args.action === 'wake') { cmd = 'input keyevent 224; wm dismiss-keyguard'; label = '点亮并解锁' }
      else if (args.action === 'notifications') { cmd = 'cmd statusbar expand-notifications'; label = '拉下通知栏' }
      else if (args.action === 'quick_settings') { cmd = 'cmd statusbar expand-settings'; label = '拉下快捷开关' }
      else if (args.action === 'night_mode') { cmd = `cmd uimode night ${args.enable === false ? 'no' : 'yes'}`; label = args.enable === false ? '关夜间模式' : '开夜间模式' }
      else if (args.action === 'rotate') {
        const current = await sh(device, 'settings get system user_rotation', 8000)
        const now = Number(String(current.out ?? '').trim())
        const order = [0, 90, 180, 270]
        const degrees = args.degrees ?? order[(order.indexOf(Number.isFinite(now) ? now * 90 : 0) + 1) % 4]
        const value = order.indexOf(degrees)
        cmd = `settings put system accelerometer_rotation 0; settings put system user_rotation ${value < 0 ? 0 : value}`
        label = `转到 ${degrees}°`
      } else {
        throw new Error('action 只能是 home / back / recents / lock / wake / rotate / notifications / quick_settings / night_mode。')
      }
      const r = await sh(device, cmd, 12_000)
      if (!r.ok) throw new Error(`${label}失败：${oneLine(r.out || '命令超时', 200)}`)
      return { ok: true, summary: `${label}完成（${r.ms}ms）。界面变化用 adb_ui 确认。`, elapsed_ms: Date.now() - began }
    },
  }), 'adb: adb_action')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_shot',
    description: '截一张设备屏幕，缩到长边 900px 后返回文件路径，用 read_image 看。只在确实需要看颜色、布局、相机/扫码画面时用；「页面对不对、按钮在不在、有没有报错」用 adb_ui 文本树，快十倍且不花图片 token。scale=0 保留原图。',
    parameters: {
      type: 'object',
      properties: {
        scale: { type: 'integer', description: '长边像素，默认 900；传 0 保留原图（2136x3200 的平板原图约 9MB）' },
        path: { type: 'string', description: '保存路径（绝对路径），不写就放临时目录' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['path', 'bytes', 'width', 'height', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(`截图：${value.path}（${value.width}x${value.height}，${Math.round(value.bytes / 1024)}KB，${value.elapsed_ms}ms）。需要看画面时对路径调用 read_image。`),
    },
    execute: async (args) => {
      const device = await serial()
      const began = Date.now()
      /* 侧栏正在直播时，最新一帧就是现在这张屏：0ms，不必再 screencap。 */
      const live = args.scale === 0 ? null : mirror.liveFrame(device)
      if (live !== null) {
        const dims = jpegSize(live.frame)
        if (dims !== null) {
          const target = args.path ?? join(tmpdir(), `adb-${Date.now()}.jpg`)
          await mkdir(dirname(target), { recursive: true }).catch(() => {})
          await writeFile(target, live.frame).catch(() => {})
          return { path: target, bytes: live.frame.length, width: dims.w, height: dims.h, elapsed_ms: Date.now() - began }
        }
      }
      const shot = await screenshot(device, { scale: args.scale, path: args.path })
      return { path: shot.path, bytes: shot.bytes, width: shot.width, height: shot.height, elapsed_ms: shot.ms }
    },
  }), 'adb: adb_shot')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_state',
    description: '一次调用拿到设备底层状态：前台 Activity、窗口栈（弹窗/输入法/悬浮窗都在栈里）、键盘是否弹出、方向与分辨率、亮屏、电量、是否 root。约 0.5s，判断「有没有弹窗 / 键盘挡没挡 / 跳没跳页」先用它，不要截图。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          activity: { type: 'string' },
          focus: { type: 'string' },
          windows: { type: 'string' },
          keyboard: { type: 'boolean' },
          rotation: { type: 'integer' },
          size: { type: 'string' },
          dialog: { type: 'boolean' },
          screen_on: { type: 'boolean' },
          battery: { type: 'string' },
          root: { type: 'boolean' },
          message: { type: 'string' },
          elapsed_ms: { type: 'integer' },
        },
        required: ['activity', 'focus', 'dialog', 'windows', 'keyboard', 'rotation', 'size', 'screen_on', 'battery', 'root', 'message', 'elapsed_ms'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async () => {
      const device = await serial()
      const started = Date.now()
      const script = [
        'echo @F@', 'dumpsys window | grep -m2 -E "mCurrentFocus=|mFocusedApp="',
        'echo @W@', 'dumpsys window windows | grep -E "^  Window #" | head -12',
        'echo @I@', 'dumpsys input_method | grep -m3 -E "mInputShown=|mShowRequested="',
        'echo @P@', 'dumpsys power | grep -m1 -E "mWakefulness="',
        'echo @B@', 'dumpsys battery | grep -m2 -E "level:|status:"',
        'echo @R@', 'dumpsys display | grep -m1 -o "orientation=[0-9]"',
        'echo @S@', 'wm size',
      ].join('; ')
      const r = await adb(['-s', device, 'shell', script], { timeout: 20_000, buffer: 4 << 20 })
      if (!r.ok && !r.out) throw new Error(`读状态失败：${oneLine(r.err || 'adb 无输出', 200)}`)
      const sections = {}
      let current = ''
      for (const line of r.out.split('\n')) {
        const marker = /^@([FWIPBRS])@$/.exec(line.trim())
        if (marker) {
          current = marker[1]
          sections[current] = []
          continue
        }
        if (current) sections[current].push(line)
      }
      const joined = (key) => (sections[key] ?? []).join('\n').trim()
      const focusSection = joined('F')
      const activity = /mFocusedApp=ActivityRecord\{[^}]*? u\d+ ([\w.]+\/[\w.$]+)/.exec(focusSection)?.[1] ?? '未知'
      const focusWindow = /mCurrentFocus=Window\{[0-9a-f]+ u\d+ ([\w.]+\/[\w.$]+)\}/.exec(focusSection)?.[1] ?? activity
      const sameComponent = (left, right) => {
        const norm = (value) => {
          const [pkg, cls] = String(value).split('/')
          if (!cls) return value
          return `${pkg}/${cls.startsWith('.') ? `${pkg}${cls}` : cls}`
        }
        return norm(left) === norm(right)
      }
      const dialog = !sameComponent(focusWindow, activity) && activity !== '未知' && !/InputMethod/i.test(focusWindow)
      const windowNames = [...new Set([...joined('W').matchAll(/Window #\d+ Window\{[0-9a-f]+ u\d+ ([^}\s]+)/g)].map((m) => m[1]))]
      const ime = joined('I')
      const keyboard = /mInputShown=true/.test(ime)
      const rotation = Number(/orientation=(\d)/.exec(joined('R'))?.[1] ?? 0) * 90
      const sizes = [...joined('S').matchAll(/(Physical|Override) size: (\d+x\d+)/g)].map((m) => `${m[1] === 'Override' ? '覆盖' : '物理'} ${m[2]}`)
      const screenOn = /mWakefulness=(Awake|Dreaming)/.test(joined('P'))
      const level = /level: (\d+)/.exec(joined('B'))?.[1]
      const root = await deviceRoot(device)
      const message = [
        `前台 ${activity}`,
        `焦点窗口 ${focusWindow}${dialog ? '（不是前台 Activity：可能有弹窗/浮层盖着）' : ''}`,
        `窗口 ${windowNames.length > 0 ? windowNames.slice(0, 8).join(' | ') : '（没读到窗口名）'}`,
        `键盘${keyboard ? '弹着' : '没弹'} · ${rotation}° · ${sizes.join(' / ') || '尺寸未知'} · ${screenOn ? '亮屏' : '熄屏'} · 电量 ${level ? `${level}%` : '未知'} · root ${root ? '有' : '无'}`,
      ].join('\n')
      return {
        activity,
        focus: focusWindow,
        dialog,
        windows: windowNames.slice(0, 12).join(' '),
        keyboard,
        rotation,
        size: sizes.join(' / ') || '未知',
        screen_on: screenOn,
        battery: level ? `${level}%` : '未知',
        root,
        message,
        elapsed_ms: Date.now() - started,
      }
    },
  }), 'adb: adb_state')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_device',
    description: '看当前连了哪些 Android 设备、状态、型号，以及选中的设备序列号和分辨率。工具报「没有检测到设备」时先用它排查。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          serial: { type: 'string' },
          devices: { type: 'string' },
          size: { type: 'string' },
          profile: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['serial', 'devices', 'size', 'message'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.message),
    },
    execute: async () => {
      const devices = await listDevices()
      const device = await serial().catch(() => '')
      let size = '未知'
      let profile = ''
      if (device) {
        const r = await adb(['-s', device, 'shell', 'wm size; getprop ro.build.characteristics; getprop ro.build.version.sdk'], { timeout: 8000 })
        size = /(\d+x\d+)/.exec(r.out)?.[1] ?? '未知'
        const lines = r.out.split('\n').map((line) => line.trim()).filter((line) => line && !/size/i.test(line))
        if (lines.length > 0) profile = `${lines[0] || '未知'} · sdk ${lines[1] || '?'}`
      }
      const listed = devices.map((item) => `${item.serial}(${item.state}${item.model ? `,${item.model}` : ''})`).join(' ') || '没有设备'
      return {
        serial: device,
        devices: listed,
        size,
        profile,
        message: devices.length > 0
          ? `设备：${listed}\n当前使用：${device} · ${size}${profile ? ` · ${profile}` : ''}`
          : '没有检测到设备：检查 USB 线、手机的「USB 调试」开关，以及手机上是否点了允许调试。',
      }
    },
  }), 'adb: adb_device')

  ctx.effect(() => ctx.tools.register({
    name: 'adb_mirror',
    description: [
      '把设备画面镜像到右侧栏「实时ADB」：那里的画面可以直接点、拖动，也能画圈标注后推进聊天。',
      'action=open 打开侧栏（用户也能自己从「更多工具」打开）；status 看是否在直播和缓冲长度；peek 拿当前一帧的 JPEG 路径（比 adb_shot 快，直接 read_image）；recent 列本机环形缓冲的片段文件；stop 停掉录制。',
      '需要人眼看画面、并说明「就是这个位置」时用它；判断界面结构仍用 adb_ui。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'status', 'peek', 'recent', 'stop'], description: '要做的操作' },
        serial: { type: 'string', description: '设备序列号；不写用当前设备' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          path: { type: 'string' },
        },
        required: ['summary'],
        additionalProperties: false,
      },
      render: (_args, value) => textBlock(value.summary),
    },
    execute: async (args, exec) => {
      if (args.action === 'open') {
        const device = await serial()
        const sid = exec?.agent?.session?.id
        const opened = mirror.open(sid)
        const state = await mirror.status(device)
        return {
          summary: [
            `已请求在「实时ADB」侧栏打开（${opened} 个页面收到）· ${device}`,
            '栏没出现就切到本会话再叫一次',
            state.live ? `画面在直播，约 ${state.fps} 帧/秒` : '画面正在起，几秒后出现',
            `本机缓冲 ${state.bufferedSeconds ?? 0}s`,
          ].join(' · '),
        }
      }
      if (args.action === 'stop') {
        mirror.stopAll()
        return { summary: '已停止镜像与录制。' }
      }
      const device = args.serial || await serial()
      if (args.action === 'peek') {
        const frame = await mirror.peek(device)
        if (!frame.ok) return { summary: `画面还没起来（${device}），再等一两秒重试。` }
        return {
          summary: `${device} · 当前帧 ${Math.round(frame.bytes / 1024)}KB · ${frame.path}`,
          path: frame.path,
        }
      }
      if (args.action === 'recent') {
        const state = await mirror.status(device)
        if (!state.dir) return { summary: `${device} · 还没有录制缓冲；先 action=open 或 peek 起一次。` }
        const listed = (await mirror.segmentList?.(device)) ?? null
        return { summary: `${device} · 本机缓冲约 ${state.bufferedSeconds ?? 0}s · ${state.dir}${listed ? ` · ${listed.length} 段` : ''}` }
      }
      const state = await mirror.status(device)
      return {
        summary: [
          `${device} · ${state.live ? '正在直播' : '未在直播'}`,
          state.live ? `${state.fps ?? 4} 帧/秒 · 已推 ${state.frames ?? 0} 帧` : '',
          `缓冲 ${state.bufferedSeconds ?? 0}s`,
          state.dir ? state.dir : '',
        ].filter(Boolean).join(' · '),
      }
    },
  }), 'adb: adb_mirror')

  const prompt = ctx.get?.('systemPrompt')
  if (prompt && typeof prompt.section === 'function') {
    ctx.effect(() => prompt.section({
      name: 'adb-text-first',
      order: 860,
      text: [
        '## Android 调试：先读文本树，截图只在看外观时用',
        '',
        '判定顺序：先 `adb_state`（前台 Activity + 窗口栈 + 键盘 + 方向，约 0.5s），再 `adb_ui`（界面文本树）。不要用截图回答「页面对不对 / 有没有弹窗 / 键盘挡住没 / 跳没跳页 / 有没有报错」——报错用 `adb_sh logcat -d -t 200`。',
        '要等接口返回、跳转或弹窗，传 `wait_for_text` / `wait_for_activity`，不要 sleep 后再截图。',
        '连着做的一串动作（点开→等加载→输入→发送、或先回桌面再进目标页）用 `adb_do` 一次调用跑完，比一步一调少好几个回合；点完要确认结果，给 `adb_tap` 带 `wait_for_text` / `wait_for_id` / `wait_until_gone`，不要点完再单独读一次树。',
        '只想知道「刚才点了之后变了什么」用 `adb_ui changed_only=true`（只给新增/消失的行）。桌面、返回、最近任务、锁屏、亮屏、转屏、通知栏、夜间模式用 `adb_action` 一条命令，不要再去界面里找按钮。',
        '点击用 `adb_tap`（ref / 文字 / id，自己或最近可点祖先里挑更准的落点；ref 来自最近一次 `adb_ui`），输入用 `adb_input`，装包启停用 `adb_app`。要拖拽、曲线滑、按住再拖这种手指轨迹，用 `adb_gesture`（逐点 DOWN/MOVE/UP，比 `input swipe` 的直线更像真人）。顶部状态、开关这类一步就能改的，直接 `adb_sh`（如 `settings put system font_scale 1.15`、`svc wifi enable`、`pm grant`），比点 UI 快且不会点歪。设备已 root 时 `adb_sh root=true cmd="cat /data/data/<包名>/shared_prefs/x.xml"` 能直接读应用存储、数据库、dropbox —— 状态类问题先读存储，比走 UI 点进去更准。',
        '`adb_shot` 只在这些时候用：颜色/布局/相机扫码画面/图表，或文本树几乎全是空节点（Flutter、自绘、部分 WebView）。图缩到长边 900px，配 `read_image` 看。「文本树看着是空的」先别急着截图：`adb_ui` 发现可读文字少于 4 个会自动跑一次 macOS 视觉 OCR，把识别出的文字当成可点击节点补进树里（来源标记 `+ocr`），慢 200ms 但省掉一次截图回合。',
        '动效问题用 `adb_anim`：给 ref/text/id 加时长和 fps，采样期间可以带 `trigger`（tap/swipe/text/action）点一下触发动画，回来的是尺寸/位置时间线 + 抖动次数、超调、帧间步长、稳定时间，比连拍截图准，也不用读图。局限：它读的是控件树坐标，列表滚动、页面转场这类合成器动画坐标可能不动，那种情况改成 `adb_mirror` 里的帧序列看。',
        '卡顿、被杀、内存涨用 `adb_proc`（top / mem / list），别截图猜。内嵌 H5 定位不准用 `adb_web`（CDP 直读 DOM，返回 CSS 矩形和换算后的设备坐标，可直接喂 `adb_tap point=`）；App 没开 WebView 调试时会明确报错。',
      ].join('\n'),
    }), 'adb: system prompt section')
  }
}
