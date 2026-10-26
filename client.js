/**
 * dsh-adb · 实时ADB 的页面半边。
 *
 * 一栏给三种用法：
 *   · 看：设备画面按 4 帧/秒推过来，鼠标点一下就是真机上的点击，拖动就是滑动；
 *   · 说：在画面上圈一下，写一句话，「发送」把带圈的图连同圈内控件一起推回聊天；
 *   · 叫：agent 通过 adb_mirror 也能把这一栏叫出来，不用人去找。
 *
 * 画面、录制、标注落盘都在宿主那半边，这里只负责画出来和收集人的动作。
 */

window.__ModuleLoader__.load({
  id: 'dsh-adb',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'adb-mirror'
    const KIND = 'adb-mirror' // ui-copy-ignore
    const ID = 'dsh-adb'
    const SLOT = 'sidebar.right.pane.tab'
    const TITLE_SLOT = 'sidebar.right.pane.tab.title'
    const ROUTE = '/dsh-adb' // ui-copy-ignore

    const DICT = {
      zh: {
        'type.label': '实时ADB',
        'type.hint': '手机画面同步显示，点一下就是点手机',
        'act.mark': '标注',
        'act.tap': '点按',
        'act.send': '发送',
        'act.clear': '清除',
        'state.starting': '画面准备中',
        'state.sent': '已发送',
        'state.failed': '发送失败',
        'ph.note': '说一下这是什么',
      },
      en: {
        'type.label': 'Live ADB',
        'type.hint': 'The phone screen, live; tap it to tap the phone',
        'act.mark': 'Mark',
        'act.tap': 'Tap',
        'act.send': 'Send',
        'act.clear': 'Clear',
        'state.starting': 'Starting',
        'state.sent': 'Sent',
        'state.failed': 'Send failed',
        'ph.note': 'Say what this is',
      },
    }
    const LANG = /^zh/i.test(typeof navigator === 'undefined' ? '' : navigator.language ?? '') ? 'zh' : 'en'
    const L = (key) => DICT[LANG][key] ?? key

    /* 诊断上报：只在 loopback 上写一行，用来确认「这一页、这一栏」到底有没有起来。 */
    const PID = (() => {
      try { return crypto.randomUUID().slice(0, 8) } catch { return String(Math.random()).slice(2, 10) }
    })()
    const report = (body) => {
      try {
        void fetch(`${ROUTE}/diag`, { // ui-copy-ignore
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pid: PID, ...body }),
        })
      } catch {}
    }

    const CSS = [
      '.adbm-body{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;min-height:0;height:100%;gap:6px;padding:8px;background:var(--dsw-alias-bg-base)}',
      '.adbm-bar{flex:none;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);min-height:26px}',
      '.adbm-btn{font:inherit;font-size:12px;padding:2px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-subtle);background:transparent;color:inherit;cursor:pointer}',
      '.adbm-btn[data-on="1"]{border-color:var(--dsw-alias-label-success);color:var(--dsw-alias-label-success)}',
      '.adbm-btn[disabled]{opacity:.45;cursor:default}',
      '.adbm-said{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}',
      '.adbm-stage{position:relative;flex:1 1 auto;min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden}',
      '.adbm-frame{position:relative;display:inline-flex;max-width:100%;max-height:100%;line-height:0}',
      '.adbm-img{display:block;max-width:100%;max-height:100%;background:#000;border-radius:6px;-webkit-user-drag:none;user-select:none}',
      '.adbm-ink{position:absolute;inset:0;touch-action:none}',
      '.adbm-ink[data-mode="mark"]{cursor:crosshair}',
      '.adbm-ink[data-mode="tap"]{cursor:pointer}',
      '.adbm-input{flex:none;font:inherit;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-subtle);background:transparent;color:inherit}',
      '.adbm-title{white-space:nowrap}',
    ].join('')

    /**
     * 兜底：一栏渲染出错时留下证据，而不是变成一块空白。
     * @param {any} props - 同上。
     * @returns {any} 元素。
     */
    function Body(props) {
      try {
        return h(BodyView, props)
      } catch (error) {
        report({ err: `body-render: ${String(error && error.message ? error.message : error)}` })
        return h('div', { className: 'adbm-body' }, String(error))
      }
    }

    /**
     * 一栏的全部内容。
     * @param {{ sessionId: string }} props - 这一栏属于哪个会话。
     * @returns {any} 元素。
     */
    function BodyView(props) {
      const sessionId = String(props?.sessionId ?? '')
      const [serial, setSerial] = React.useState('')
      const [devices, setDevices] = React.useState([])
      const [mode, setMode] = React.useState('view')
      const [note, setNote] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [ready, setReady] = React.useState(false)
      const [screen, setScreen] = React.useState({ w: 0, h: 0 })
      const [frameSize, setFrameSize] = React.useState({ w: 0, h: 0 })
      const [streaming, setStreaming] = React.useState(false)
      const imgRef = React.useRef(null) // ui-copy-ignore
      const frameRef = React.useRef(null) // ui-copy-ignore
      const canvasRef = React.useRef(null) // ui-copy-ignore
      const strokes = React.useRef([]) // ui-copy-ignore
      const drawing = React.useRef(null) // ui-copy-ignore
      const gesture = React.useRef(null) // ui-copy-ignore

      /* 画布按显示尺寸重建，人画的线才和画面同尺度。 */
      const paint = React.useCallback(() => {
        const canvas = canvasRef.current
        if (canvas === null) return
        const ratio = Math.min(2, window.devicePixelRatio || 1)
        const box = canvas.getBoundingClientRect()
        const width = Math.max(1, Math.round(box.width * ratio))
        const height = Math.max(1, Math.round(box.height * ratio))
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width
          canvas.height = height
        }
        const ink = canvas.getContext('2d')
        if (ink === null) return
        ink.setTransform(1, 0, 0, 1, 0, 0)
        ink.clearRect(0, 0, canvas.width, canvas.height)
        ink.setTransform(ratio, 0, 0, ratio, 0, 0)
        ink.strokeStyle = '#ff3b30'
        ink.lineWidth = 3
        ink.lineCap = 'round'
        ink.lineJoin = 'round'
        for (const stroke of strokes.current) {
          if (stroke.length < 1) continue
          ink.beginPath()
          stroke.forEach((point, index) => {
            if (index === 0) ink.moveTo(point.x, point.y)
            else ink.lineTo(point.x, point.y)
          })
          if (stroke.length === 1) ink.lineTo(stroke[0].x + 0.5, stroke[0].y + 0.5)
          ink.stroke()
        }
      }, [])

      /* 只在这一栏真的被人看见时收画面：切走、最小化、被别的页签盖住都停。 */
      React.useEffect(() => {
        const node = frameRef.current
        const awake = () => document.visibilityState !== 'hidden'
        const decide = () => {
          const box = node === null ? null : node.getBoundingClientRect()
          const onScreen = box !== null && box.width > 8 && box.height > 8 && box.bottom > 0 && box.top < window.innerHeight
          setStreaming(awake() && onScreen)
        }
        decide()
        const watch = typeof ResizeObserver === 'function' && node !== null ? new ResizeObserver(decide) : null
        watch?.observe(node)
        document.addEventListener('visibilitychange', decide)
        window.addEventListener('resize', decide)
        return () => {
          watch?.disconnect()
          document.removeEventListener('visibilitychange', decide)
          window.removeEventListener('resize', decide)
        }
      }, [])

      React.useEffect(() => {
        report({ body: true, sessionId })
      }, [sessionId])

      React.useEffect(() => {
        const frame = frameRef.current
        if (frame === null || typeof ResizeObserver !== 'function') return undefined
        const watch = new ResizeObserver(() => paint())
        watch.observe(frame)
        return () => watch.disconnect()
      }, [paint])

      React.useEffect(() => {
        let live = true
        fetch(`${ROUTE}/devices`, { cache: 'no-store' })
          .then((response) => response.json())
          .then((body) => {
            if (!live) return
            setDevices(Array.isArray(body?.devices) ? body.devices : [])
            setSerial(String(body?.serial ?? ''))
          })
          .catch(() => {})
        return () => { live = false }
      }, [])

      /* 画面尺寸与是否在直播：标注坐标要换算到设备像素，必须知道这两个数。 */
      React.useEffect(() => {
        if (serial === '') return undefined
        let live = true
        const tick = () => {
          fetch(`${ROUTE}/state?serial=${encodeURIComponent(serial)}`, { cache: 'no-store' })
            .then((response) => response.json())
            .then((state) => {
              if (!live) return
              if (Number(state?.screen?.w) > 0) setScreen({ w: Number(state.screen.w), h: Number(state.screen.h) })
              if (Number(state?.frame?.w) > 0) setFrameSize({ w: Number(state.frame.w), h: Number(state.frame.h) })
              setReady(state?.live === true)
            })
            .catch(() => {})
        }
        tick()
        const timer = setInterval(tick, 1500)
        return () => { live = false; clearInterval(timer) }
      }, [serial])

      /**
       * 指针位置换成画布里的坐标。
       * @param {any} event - 指针事件。
       * @returns {{ x: number, y: number }} 坐标。
       */
      const pointOf = (event) => {
        const box = canvasRef.current.getBoundingClientRect()
        return { x: event.clientX - box.left, y: event.clientY - box.top }
      }

      /**
       * 画布坐标换成设备坐标：画面等比铺满画布，两边比例一致。
       * @param {{ x: number, y: number }} point - 画布坐标。
       * @returns {{ x: number, y: number }} 设备坐标。
       */
      const devicePoint = (point) => {
        const box = canvasRef.current.getBoundingClientRect()
        if (box.width < 1 || screen.w < 1) return { x: 0, y: 0 }
        const scale = deviceWidth() / box.width
        return { x: Math.round(point.x * scale), y: Math.round(point.y * scale) }
      }

      const onDown = (event) => {
        if (mode === 'view') return
        const point = pointOf(event)
        if (mode === 'mark') {
          drawing.current = [point]
          strokes.current.push(drawing.current)
          paint()
          return
        }
        gesture.current = { start: point, last: point }
      }

      const onMove = (event) => {
        const point = pointOf(event)
        if (mode === 'mark') {
          if (drawing.current === null) return
          drawing.current.push(point)
          paint()
          return
        }
        if (gesture.current !== null) gesture.current.last = point
      }

      const onUp = () => {
        if (mode === 'mark') {
          drawing.current = null
          return
        }
        const gestureNow = gesture.current
        gesture.current = null
        if (gestureNow === null || serial === '') return
        const from = devicePoint(gestureNow.start)
        const to = devicePoint(gestureNow.last)
        const far = Math.abs(to.x - from.x) + Math.abs(to.y - from.y)
        const body = far < 12
          ? fetch(`${ROUTE}/tap`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serial, x: from.x, y: from.y }),
          })
          : fetch(`${ROUTE}/swipe`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serial, x1: from.x, y1: from.y, x2: to.x, y2: to.y, ms: 260 }),
          })
        body.catch(() => setStatus(L('state.failed')))
      }

      const clear = () => {
        strokes.current = []
        paint()
        setStatus('')
      }

      /* 图上带圈，连同圈里的控件一起推进聊天。 */
      /* `wm size` 报的是竖屏物理尺寸（2136x3200），画面常是横屏 3200x2136；
         两边横竖不一致时按长边归位，否则标注/点按会整体缩到左上角。 */
      const deviceWidth = () => {
        if (screen.w < 1) return 0
        const same = frameSize.w < 1 || (screen.w > screen.h) === (frameSize.w > frameSize.h)
        return same ? screen.w : Math.max(screen.w, screen.h)
      }

      const send = async () => {
        if (serial === '' || status === L('state.sent')) return
        setStatus(L('state.starting'))
        try {
          const response = await fetch(`${ROUTE}/frame?serial=${encodeURIComponent(serial)}`, { cache: 'no-store' })
          if (!response.ok) throw new Error('no frame')
          const bitmap = await createImageBitmap(await response.blob())
          const out = document.createElement('canvas')
          out.width = bitmap.width
          out.height = bitmap.height
          const ink = out.getContext('2d')
          if (ink === null) throw new Error('no canvas')
          ink.drawImage(bitmap, 0, 0)
          const box = canvasRef.current.getBoundingClientRect()
          const scale = box.width < 1 ? 1 : out.width / box.width
          ink.strokeStyle = '#ff3b30'
          ink.lineWidth = Math.max(3, 3 * scale)
          ink.lineCap = 'round'
          ink.lineJoin = 'round'
          let left = Infinity
          let top = Infinity
          let right = -Infinity
          let bottom = -Infinity
          for (const stroke of strokes.current) {
            ink.beginPath()
            stroke.forEach((point, index) => {
              const x = point.x * scale
              const y = point.y * scale
              if (index === 0) ink.moveTo(x, y)
              else ink.lineTo(x, y)
              left = Math.min(left, x)
              top = Math.min(top, y)
              right = Math.max(right, x)
              bottom = Math.max(bottom, y)
            })
            ink.stroke()
          }
          const deviceScale = deviceWidth() > 0 ? deviceWidth() / out.width : 1
          const rect = Number.isFinite(left)
            ? {
              x: left * deviceScale,
              y: top * deviceScale,
              w: Math.max(1, (right - left) * deviceScale),
              h: Math.max(1, (bottom - top) * deviceScale),
            }
            : null
          const png = out.toDataURL('image/png').split(',')[1]
          const answer = await fetch(`${ROUTE}/annotate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serial, session: sessionId, note, png, rect }),
          }).then((res) => res.json())
          if (answer?.ok === true) {
            setStatus(L('state.sent'))
            strokes.current = []
            setNote('')
            paint()
          } else {
            setStatus(String(answer?.reason ?? L('state.failed')))
          }
        } catch {
          setStatus(L('state.failed'))
        }
      }

      const button = (value, label, onClick, extra) => h('button', {
        className: 'adbm-btn',
        'data-on': mode === value ? '1' : '0',
        disabled: extra?.disabled === true,
        onClick,
      }, label)

      return h('div', { className: 'adbm-body' },
        h('div', { className: 'adbm-bar' },
          button('mark', L('act.mark'), () => setMode(mode === 'mark' ? 'view' : 'mark')),
          button('tap', L('act.tap'), () => setMode(mode === 'tap' ? 'view' : 'tap')),
          h('button', {
            className: 'adbm-btn',
            disabled: !ready,
            onClick: send,
          }, L('act.send')),
          strokes.current.length > 0 ? h('button', { className: 'adbm-btn', onClick: clear }, L('act.clear')) : null,
          h('span', { className: 'adbm-said' }, status || (ready ? '' : L('state.starting'))),
          devices.length > 1
            ? h('select', {
              className: 'adbm-input',
              value: serial,
              onChange: (event) => { setSerial(event.target.value); setReady(false) },
            }, devices.map((each) => h('option', { key: each, value: each }, each)))
            : null,
        ),
        h('div', { className: 'adbm-stage' },
          h('div', { className: 'adbm-frame', ref: frameRef }, // ui-copy-ignore
            serial === ''
              ? null
              : h('img', {
                className: 'adbm-img',
                ref: imgRef, // ui-copy-ignore
                alt: '',
                draggable: false,
                /* 没人在看就断开：右栏切到别的页签、窗口在后台、面板滚出视野，
                   都不该让设备一直截图。重新被看见时这一条会自己接上。 */
                src: streaming ? `${ROUTE}/live?serial=${encodeURIComponent(serial)}` : undefined, // ui-copy-ignore
                onLoad: () => { setReady(true); paint() },
              }),
            h('canvas', {
              className: 'adbm-ink',
              ref: canvasRef, // ui-copy-ignore
              'data-mode': mode,
              onPointerDown: onDown,
              onPointerMove: onMove,
              onPointerUp: onUp,
              onPointerCancel: onUp,
            }),
          ),
        ),
        h('input', {
          className: 'adbm-input',
          value: note,
          placeholder: L('ph.note'),
          onChange: (event) => setNote(event.target.value),
          onKeyDown: (event) => { if (event.key === 'Enter') void send() },
        }),
      )
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      /**
       * 注册这一栏，并让 agent 也能把它叫出来。
       * @param {any} ctx - 客户端插件上下文。
       */
      apply(ctx) {
      report({ event: 'boot' })
        try {
          ctx.locale.register(NS, { zh: DICT.zh, 'zh-CN': DICT.zh, en: DICT.en })
        } catch {
          /* 只有一个 locale 服务，或没有 */
        }
        ctx.effect(() => {
          const style = document.createElement('style')
          style.id = 'dsh-adb-mirror-css'
          style.dataset.pluginCss = ID
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-adb: 实时镜像样式')

        /* 右栏的登记处是页面级单例，而插件的模块可能被就地换过一次：旧实例注册的类型
           还在册，新实例再注册就会撞名，页签于是只长出个空壳。这里把整页重建一次，
           登记处和页面一起换新；同一页面 30 秒内只重建一次，避免来回跳。 */
        const reloadPage = (reason) => {
          try {
            const last = Number(sessionStorage.getItem('dsh-adb.reload') ?? 0)
            if (Date.now() - last < 30_000) return
            if (document.querySelector('[aria-modal="true"], dialog[open]') !== null) return
            sessionStorage.setItem('dsh-adb.reload', String(Date.now()))
            report({ event: 'reload', reason })
            location.reload()
          } catch {
            /* 没有存储的页面就宁可不动 */
          }
        }

        ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => scope.effect(() => {
          const done = []
          /* 先把页签类型注册进右栏的登记处：没有这一条，openTab 等于没调。 */
          try {
            const tabs = scope.sidebarRightTabs
            const registration = typeof tabs?.register === 'function'
              ? tabs.register({
                id: KIND, // ui-copy-ignore
                kind: KIND, // ui-copy-ignore
                title: () => L('type.label'),
                guide: [{
                  order: 40,
                  title: () => L('type.label'),
                  description: () => L('type.hint'),
                  icon: 'mdi:cellphone-link',
                }],
              })
              : undefined
            if (registration !== undefined) done.push(registration)
          } catch (error) {
            if (/already registered/i.test(String(error?.message ?? error))) {
              reloadPage('tab-type-conflict')
              return () => {}
            }
          }

          done.push(scope.slots.inject(SLOT, () => scope.slots.register({
            name: SLOT, // ui-copy-ignore
            key: KIND, // ui-copy-ignore
            locale: NS, // ui-copy-ignore
            inject: (sessionId) => ({ sessionId }),
          }, Body)))

          done.push(scope.slots.inject(TITLE_SLOT, () => scope.slots.register({
            name: TITLE_SLOT, // ui-copy-ignore
            key: KIND, // ui-copy-ignore
            locale: NS, // ui-copy-ignore
          }, () => h('span', { className: 'adbm-title' }, L('type.label')))))

          const right = () => {
            try { return scope.get('sidebarRight') } catch { return undefined }
          }
          /* 某个会话自己那一栏里已经开着的页签。不能用全局清单：别处开着的同类型页签
             会让这里误判「已经开了」，于是跳过建页签、转而去动别人正在看的那一栏。 */
          const rowsOf = (sessionId) => {
            try { return right()?.tabsIn?.(sessionId) ?? [] } catch { return [] }
          }
          const mountedNow = () => {
            try { return right()?.mounted?.getSnapshot?.() } catch { return undefined }
          }
          /* 宿主说「打开这一栏」：只在发起方那一栏建页签、展开右栏、切到它。 */
          const onWanted = (event, retryPass) => {
            let body
            try { body = JSON.parse(event?.data ?? '{}') } catch { body = {} }
            const want = body?.sessionId ?? body?.session
            if (typeof want !== 'string' || want === '') return
            /* 推送会重连、页面会重载：同一个请求（at 不变或更旧）不再重放一次。 */
            const at = Number(body?.at ?? 0) || 0
            /* 宿主留下的旧请求不补开：页面隔很久才装载时，半小时前的 want 不该再弹一次栏。 */
            if (at > 0 && Date.now() - at > 120000) return
            if (at > 0 && retryPass !== true) {
              if (at <= seenWantAt) return
              seenWantAt = at
              wantTries = 0
            }
            const mounted = mountedNow()
            /* 默认拒绝：只有「右栏正挂在发起方这一栏上」才允许占用可见栏。
               会话未知（undefined）不是许可，先短等右栏挂上来，挂的不是这一栏就彻底放弃。 */
            if (mounted !== want) {
              report({ event: 'want-skip', mounted: mounted === undefined ? 'undefined' : String(mounted).slice(-8), want: String(want).slice(-8) })
              if (mounted === undefined && wantTries < 20) {
                wantTries += 1
                clearTimeout(retry)
                retry = setTimeout(() => { onWanted({ data: JSON.stringify(body) }, true) }, 250)
              }
              return
            }
            const pane = right()
            if (rowsOf(want).some((row) => row.kind === KIND) === false) {
              try { pane?.openTab?.(KIND) } catch { /* 页签被拒：下一跳再看 */ }
            }
            try {
              if (typeof pane?.isExpanded === 'function' && !pane.isExpanded()) pane.toggleExpanded()
            } catch { /* 没有展开能力就这样 */ }
            report({ event: 'want-ok', tabs: rowsOf(want).map((row) => row.kind).slice(-4) })
            const tab = rowsOf(want).find((row) => row.kind === KIND)
            try {
              if (tab !== undefined && typeof pane?.focus === 'function') pane.focus(tab.tabId ?? tab.id)
            } catch { /* 切不过去就等下一跳 */ }
          }
          /* 短等右栏挂上的重试要有限度：每次 onWanted 只排一次，靠 at 去重挡重复请求。 */
          let seenWantAt = 0
          let wantTries = 0
          let retry
          let source
          try {
            source = new EventSource(`${ROUTE}/events`) // ui-copy-ignore
            source.addEventListener('message', onWanted)
          } catch {
            source = undefined
          }
          /* 推送之外再补一条拉取：宿主重启过、或页面在后台被节流时，推送会断但轮询还会醒。 */
          const pull = async () => {
            try {
              const response = await fetch(`${ROUTE}/want`, { cache: 'no-store' }) // ui-copy-ignore
              const body = await response.json()
              if (typeof body?.session === 'string' && body.session !== '') {
                onWanted({ data: JSON.stringify(body) })
              }
            } catch { /* 宿主没起就下一跳再问 */ }
          }
          const timer = setInterval(pull, 3000)
          void pull()

          return () => {
            clearInterval(timer)
            clearTimeout(retry)
            try { source?.close() } catch { /* 已关 */ }
            for (const dispose of done.reverse()) { try { dispose?.() } catch { /* 已撤 */ } }
          }
        }, 'dsh-adb: 实时镜像面板'))
      },
    }
  },
})
