/**
 * dsh-adb 自测：用假 ctx 拿工具定义，然后对真机跑一遍。
 * 默认只跑只读工具；加 --tap 会真的点一下「可点击节点」（会动到设备，小心）。
 *
 *   node selftest.mjs            # 只读
 *   node selftest.mjs --tap      # 额外验证 adb_tap 的点按路径
 *   node selftest.mjs --serial emulator-5554
 */

import { apply } from './index.js'

const argv = process.argv.slice(2)
const wantTap = argv.includes('--tap')
const serialArg = argv[argv.indexOf('--serial') + 1]
const config = argv.includes('--serial') ? { serial: serialArg } : {}

const tools = new Map()
const ctx = {
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
  effect: (fn) => { const cleanup = fn(); return () => cleanup?.() },
  get: (name) => (name === 'systemPrompt' ? { section: () => () => undefined } : undefined),
}

apply(ctx, config)

const ok = (label, extra = '') => console.log(`  ✅ ${label}${extra ? `  ${extra}` : ''}`)
const bad = (label, extra = '') => console.log(`  ❌ ${label}${extra ? `  ${extra}` : ''}`)

/**
 * 调一个工具并计时。
 * @param {string} name - 工具名。
 * @param {any} args - 参数。
 * @returns {Promise<{value: any, ms: number}>} 结果。
 */
async function call(name, args = {}) {
  const tool = tools.get(name)
  if (!tool) throw new Error(`工具没注册：${name}`)
  const started = Date.now()
  const value = await tool.execute(args, {})
  return { value, ms: Date.now() - started }
}

console.log(`\n=== dsh-adb selftest（${tools.size} 个工具已注册）===\n`)

console.log('[1] adb_device')
const device = await call('adb_device')
console.log(device.value.message.split('\n').map((line) => `     ${line}`).join('\n'))
if (device.value.serial) ok('设备可选', `${device.value.serial} ${device.value.size}, ${device.ms}ms`)
else bad('没有可用设备')

console.log('\n[2] adb_ui（文本树）')
const ui = await call('adb_ui')
const treeText = ui.value.tree
const treeLines = treeText.split('\n').length
console.log(`     ${ui.value.summary}`)
console.log(treeText.split('\n').slice(0, 12).map((line) => `     │ ${line}`).join('\n'))
ok('读界面树', `${ui.ms}ms, ${treeText.length} 字符 ≈ ${Math.round(treeText.length / 2.2)} token, ${treeLines} 行`)

console.log('\n[3] adb_ui 过滤（模拟模型查关键字）')
const needle = treeText.split('\n').map((line) => /"([^"]{2,})"/.exec(line)?.[1]).find(Boolean) ?? '设置'
const filtered = await call('adb_ui', { filter: needle })
ok(`filter="${needle}"`, `${filtered.value.tree.split('\n').length} 行, ${filtered.ms}ms`)

console.log('\n[4] adb_app foreground')
const foreground = await call('adb_app', { action: 'foreground' })
ok('前台页面', `${foreground.value.message.replace(/^前台页面：/, '')}, ${foreground.ms}ms`)

console.log('\n[5] adb_sh logcat 尾部')
const logs = await call('adb_sh', { cmd: 'logcat -d -t 5' })
ok('logcat -d -t 5', `${logs.value.output.length} 字符, ${logs.ms}ms`)

console.log('\n[6] adb_shot（缩到长边 600）')
const shot = await call('adb_shot', { scale: 600 })
ok('截图', `${shot.value.path} ${shot.value.width}x${shot.value.height} ${Math.round(shot.value.bytes / 1024)}KB, ${shot.ms}ms`)

console.log('\n[7] adb_ui 等待命中（已存在的文字应立刻返回）')
const waited = await call('adb_ui', { wait_for_text: needle, timeout_ms: 3000 })
if (waited.value.matched) ok(`wait_for_text="${needle}"`, `${waited.ms}ms`)
else bad('等待没命中', waited.value.summary)

console.log('\n[8] 错误路径：不存在的 ref')
try {
  await call('adb_tap', { ref: 9999 })
  bad('ref=9999 居然成功了')
} catch (error) {
  ok('未知 ref 报错清楚', error.message.slice(0, 70))
}

console.log('\n[9] 错误路径：不存在的文字')
try {
  await call('adb_tap', { text: '这个文字绝对不存在-zzz' })
  bad('不存在的文字居然点到了')
} catch (error) {
  ok('未知文字报错清楚', error.message.slice(0, 70))
}

console.log('\n[10] adb_ui changed_only（同一个界面读两次，第二次应为空差）')
await call('adb_ui', {})
const delta = await call('adb_ui', { changed_only: true })
if (delta.value.tree.includes('界面没有变化') || delta.value.tree.length < treeText.length) ok('差量读取', `${delta.ms}ms，${delta.value.tree.split('\n').length} 行`)
else bad('差量读取没省下内容', delta.value.tree.slice(0, 80))

console.log('\n[11] adb_action home')
const act = await call('adb_action', { action: 'home' })
ok('home', act.value.summary)

console.log('\n[12] adb_do 两步（等桌面文字 + 回桌面）')
const batch = await call('adb_do', { steps: [{ action: 'home' }, { sleep_ms: 200 }], timeout_ms: 5000 })
ok('两步一次跑完', `${batch.value.steps} 步 / ${batch.ms}ms`)

console.log('\n[13] 推流接口（/stream/info + /stream 3 秒）')
/* 宿主端口会变：从环境变量取，默认当前的 GUI 端口。 */
const base = process.env.DSH_ADB_BASE ?? 'http://127.0.0.1:50802/dsh-adb'
const info = await fetch(`${base}/stream/info?serial=${encodeURIComponent(device.value.serial)}`).then((res) => res.json()).catch(() => null)
if (info === null) bad('拿不到 /stream/info')
else ok('/stream/info 可读', `codec=${info.codec || '(未开)'} clients=${info.clients}`)
try {
  const control = new AbortController()
  const timer = setTimeout(() => control.abort(), 3000)
  const res = await fetch(`${base}/stream?serial=${encodeURIComponent(device.value.serial)}`, { signal: control.signal })
  const reader = res.body.getReader()
  let bytes = 0
  let init = 0
  let media = 0
  let pending = Buffer.alloc(0)
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: null }))
    if (done || value === null) break
    pending = Buffer.concat([pending, Buffer.from(value)])
    while (pending.length >= 5) {
      const size = pending.readUInt32BE(1)
      if (pending.length < 5 + size) break
      const type = pending[0]
      if (type === 1) init += 1
      if (type === 2) media += 1
      bytes += 5 + size
      pending = pending.subarray(5 + size)
    }
  }
  clearTimeout(timer)
  /* 静态画面时 screenrecord 约 1 帧/秒，3 秒窗口可能一片都没有：初始化段到了就算链路通。 */
  if (init > 0) ok('推流链路可订阅', `init ${init} / media ${media} / ${Math.round(bytes / 1024)}KB`)
  else bad('推流没出片', `init ${init} / media ${media}`)
} catch (error) {
  bad('推流读取失败', String(error?.message ?? error).slice(0, 80))
}

console.log('\n[14] 镜像输入接口参数校验（不发真实手势）')
const scrollBad = await fetch(`${base}/scroll`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ serial: device.value.serial, x: 10, y: 10, dy: 0 }),
}).then((res) => res.json()).catch(() => null)
if (scrollBad?.ok === false) ok('/scroll 空位移被拒', scrollBad.reason)
else bad('/scroll 参数校验不对', JSON.stringify(scrollBad))

if (wantTap) {
  console.log('\n[13] adb_tap 真点（--tap）')
  const target = treeText.split('\n').find((line) => line.includes(' *'))
  const ref = Number(/(\d+)/.exec(target)?.[1])
  if (!target || !Number.isFinite(ref)) bad('文本树里没有可点击节点')
  else {
    const tap = await call('adb_tap', { ref })
    ok('按 ref 点击', tap.value.message)
  }
}

console.log('\n[15] adb_recent 近几秒拼图')
try {
  const recent = await call('adb_recent', { seconds: 6 })
  if (recent.value.bytes > 20000) {
    ok('抽到 6 帧拼图', `${recent.value.bytes} bytes / ${recent.value.elapsed_ms}ms`)
  } else {
    bad('没抽到拼图', JSON.stringify(recent.value).slice(0, 120))
  }
} catch (error) {
  bad('adb_recent 抛错', String(error?.message ?? error).slice(0, 80))
}

console.log('\n[16] adb_shot 缩放与尺寸')
try {
  const shot = await call('adb_shot', { scale: 600 })
  const fits = shot.value.width <= 600 && shot.value.height <= 600 && shot.value.width > 300
  if (fits) ok('尺寸按缩放回报', `${shot.value.width}x${shot.value.height} / ${shot.value.elapsed_ms}ms`)
  else bad('尺寸回报不对', `${shot.value.width}x${shot.value.height}`)
} catch (error) {
  bad('adb_shot 抛错', String(error?.message ?? error).slice(0, 80))
}

console.log('\n=== 完成 ===\n')
