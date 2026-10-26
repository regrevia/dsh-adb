/**
 * 本地 OCR：macOS Vision 框架，常驻 python 进程，不联网、不上传。
 *
 * 用途：文本树几乎为空（Flutter / 自绘 / 相机 / 部分 WebView）时兜底，
 * 把画面上的文字和归一化位置变成可点的候选控件。
 *
 * 资源：进程空闲 45 秒自动退出；一次识别实测 150–180 ms（1618×1080 帧），
 * 首次启动约 230 ms（Vision 模型加载）。
 *
 * @module dsh-adb/ocr
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER = join(HERE, 'ocr_worker.py')
const IDLE_MS = 45_000
const CALL_TIMEOUT_MS = 8_000

let worker = null
let ready = null
let idleTimer = null
let seq = 0
const pending = new Map()
let buffer = ''

/** python3 是否存在（不存在就没有 OCR）。 */
export function ocrAvailable() {
  return existsSync(WORKER) && existsSync('/usr/bin/python3')
}

function kill() {
  if (worker) {
    try {
      worker.kill()
    } catch {
      /* 已经退了 */
    }
  }
  worker = null
  ready = null
  buffer = ''
  for (const [, entry] of pending) entry.reject(new Error('OCR 进程已退出'))
  pending.clear()
}

function armIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (pending.size === 0) kill()
  }, IDLE_MS)
  idleTimer.unref?.()
}

function start() {
  if (ready) return ready
  ready = new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [WORKER], { stdio: ['pipe', 'pipe', 'pipe'] })
    worker = child
    const timer = setTimeout(() => {
      reject(new Error('OCR 进程启动超时'))
      kill()
    }, 15_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.ready === true) {
          clearTimeout(timer)
          resolve()
          continue
        }
        const entry = pending.get(message.path)
        if (!entry) continue
        pending.delete(message.path)
        if (message.error) entry.reject(new Error(message.error))
        else entry.resolve({ blocks: message.blocks ?? [], width: message.w, height: message.h })
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {})
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
      kill()
    })
    child.on('exit', () => {
      clearTimeout(timer)
      if (worker === child) {
        worker = null
        ready = null
        for (const [, entry] of pending) entry.reject(new Error('OCR 进程退出'))
        pending.clear()
      }
    })
  })
  return ready
}

/**
 * 识别一张本机图片上的文字。
 * @param {string} path - 图片绝对路径（PNG/JPEG）。
 * @returns {Promise<{blocks: Array<{text: string, conf: number, x: number, y: number, w: number, h: number}>, width: number, height: number}>}
 *   `x/y/w/h` 是归一化坐标，原点在**左下角**（Vision 的习惯）。
 */
export async function ocrImage(path) {
  await start()
  armIdle()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(path)
      reject(new Error('OCR 超时'))
    }, CALL_TIMEOUT_MS)
    pending.set(path, {
      resolve: (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    worker.stdin.write(`${path}\n`)
  })
}

/** 关掉常驻进程（插件卸载时调）。 */
export function stopOcr() {
  if (idleTimer) clearTimeout(idleTimer)
  kill()
}

/**
 * 把归一化结果换算成设备像素矩形。
 * @param {Array} blocks - `ocrImage` 的返回值。
 * @param {number} width - 图片宽（= 设备宽，screencap 原图）。
 * @param {number} height - 图片高。
 * @returns {Array<{text: string, conf: number, x1: number, y1: number, x2: number, y2: number}>}
 */
export function toRects(blocks, width, height) {
  const rects = []
  for (const block of blocks) {
    if (!block.text || block.conf < 0.3) continue
    const x1 = Math.round(block.x * width)
    const x2 = Math.round((block.x + block.w) * width)
    const y1 = Math.round((1 - block.y - block.h) * height)
    const y2 = Math.round((1 - block.y) * height)
    if (x2 - x1 < 6 || y2 - y1 < 6) continue
    rects.push({ text: block.text, conf: block.conf, x1, y1, x2, y2 })
  }
  return rects
}

export { seq }
