# dsh-adb · 真机调试（ADB）

侧栏「实时ADB」：平板/手机画面按低帧率推进 DSH 右栏，鼠标点一下就是真机上点一下，在画面上圈一处再写一句话，带圈图和圈内控件一起回到会话里。插件内建，不需要额外 MCP、不需要独立 agent，也不上传任何画面——所有 HTTP 接口只监听 127.0.0.1，校验 peer / Host / Origin，伪造来源实测 403。

```bash
git clone https://github.com/regrevia/dsh-adb.git dsh-adb
cd dsh-adb
# 在 DSH 里：plugin_manager action=install_bundle target=$HOME/dsh-adb
# 或直接把它写进 profile 的 package.json 依赖： "dsh-adb": "link:$HOME/dsh-adb"
```

环境变量（可选，都可不设）：`ADB`（adb 路径）、`ANDROID_SERIAL`（默认设备）、`FFMPEG`（转码路径）。见 `.env.example`。

## 0.8（实测：看的成本降下来、不看就完全停）

| 能力 | 之前 | 现在 |
| --- | --- | --- |
| 侧栏每帧体积 | 1618×1080 JPEG ≈ 140 KB | **1024×684 · 21–48 KB**（右栏显示宽度只要几百 px，多余像素白解码） |
| 侧栏帧率 | 5 fps，每 120 ms 一拍 | **2.8–3.4 fps**，200 ms 一拍、2 张抓帧并发；实测 `/state` 报 3.4 帧/秒 |
| 没人在看侧栏 | 仍在抓帧、仍在推 | **0 次抓帧**：没有观看者时抓帧泵直接空转，`/state` 的 `watchers` 到 0 |
| 切走 / 最小化 / 面板滚出视野 | 照常占 CPU | 页面侧 `IntersectionObserver` + `visibilitychange` 判定，**断开直播流**，重新被看见再自动接上 |
| 盲等重开 | 靠 sleep 后反复试 | 页面不在前台也能用 `openTabIn(发起会话, kind)` **定向**把页签建进该会话自己的布局（实测 `tabsIn` 回 `guide,adb-mirror`），回到该会话时 800 ms 一次的挂起请求立刻展开并出画面，不用再叫一次 |

**店铺里的坑**：宿主热重载会重新执行页面侧模块，但页签登记处是页面级的单例，旧登记还在，新登记会抛 `tab type id "adb-mirror" is already registered`，页签行建出来了、内容却永远不挂载。现在遇到这个冲突直接整页重建一次（30 s 内最多一次，有弹窗时不动），重建后登记处是干净的，`want` 还在，页签自动开、自动出画面。**插件更新后如果侧栏没反应，按一次 ⌘R 即可**——这是目前唯一需要人动手的地方。

**右栏归属**：右栏是全局唯一可见栏，插件只在「右栏正挂着你发起的那个会话」时才占它；屏幕上是别的会话时改用定向接口只往发起会话自己的布局里建页签，不展开、不切页签、不碰别人正在看的那一栏。


把「看一眼手机界面」从**截图 + 视觉**换成**读界面文本树**，给 DSH 里的所有会话使用。装一次，任何会话都能用；不需要 MCP 行、不需要后台服务常驻。

## 0.7（实测：看不清字也能读、动效给数字、标注不再偏）

| 能力 | 之前 | 现在 |
| --- | --- | --- |
| 界面只有自绘/Flutter、文本树空 | 只回一句「没有可读文字」 | `adb_ui` 自动补一层本机 Vision OCR（`ocr:"force"` 可强制）：实测 `force` 全流程 **1771 ms**（截屏 0.36 s + 3.5 MB 传输 + 识别 1.58 s，21 段），只当兜底、不当默认 |
| 截屏取字 | `exec-out screencap -p` **3.0–3.1 s / 8.5 MB** | 设备端 `screencap -j` 落盘再 `cat`：**0.36 s / 3.5 MB**（PNG 路径保留作回退） |
| 判断「变大变小不协调」 | 连拍截图靠眼睛 | `adb_anim` 给数字：每 150–250 ms 一帧的**中心 / 宽×高**表，加上超调 px、方向反转次数、平均步长、峰值步长、平滑度、稳定耗时 |
| 卡顿/被杀/内存涨 | 截图猜 | `adb_proc`：`top` 最吃 CPU、`mem` 看单包 PSS 明细、`list` 列进程 |
| 内嵌 H5 定位不准 | 只能读控件树 | `adb_web`：CDP 直读 DOM（`list` / `dom` 选择器 / `eval`），返回 CSS 矩形与换算好的设备坐标，可直接喂 `adb_tap point=` |
| 侧栏标注位置偏 | `wm size` 报竖屏 `2136x3200`、画面是横屏 `1618x1080`，标注整体缩到左上角 | 按真实画面横竖对齐后再换算：`3200/1618 = 1.978`，标注/点按与设备坐标一致 |

`adb_anim` 读的是控件树坐标：列表滚动、页面转场这类合成器驱动的动画可能全程报「没变」，那种情况改用侧栏「最近 6 秒」拼图看。OCR 走本机 Vision（macOS），一个 worker 进程、空闲 45 s 自杀；只支持 macOS。

## 0.6（实测：一个回合跑一串动作、截图 0 ms 复用、精确落点）

| 能力 | 之前 | 现在 |
| --- | --- | --- |
| 「点开→等加载→输入→发送」 | 4–6 次工具调用、4–6 个模型回合 | **`adb_do` 一次调用**（实测 4 步：home→等「设置」→点→等「WLAN」= **1614 ms / 1 回合**） |
| 侧栏在看画面时截图 | 0.5–3.2 s（screencap + 转码） | **1 ms**（直接拿直播里最新一帧，`liveFrame`） |
| 点完再确认界面 | 2 次调用（tap + adb_ui） | **1 次**：`adb_tap` 带 `wait_for_text` / `wait_for_id` / `wait_until_gone`，返回命中/超时与当前 Activity |
| 看「点完到底变了什么」 | 整棵树重读 | `adb_ui changed_only`：只给 `+ 新增 / - 消失`，没变化时一行「界面没有变化」 |
| 系统开关（桌面/返回/最近/锁屏/亮屏/转屏/通知栏/快捷开关/夜间） | 界面里找按钮，或自己拼 `input keyevent` | **`adb_action` 一条命令**（实测 home 126 ms） |
| 点文字落到哪 | 最近可点祖先的中心 | 祖先大得离谱（>6 倍面积）且中心离文字远时**点文字自己**：MIUI 桌面点「设置」实测从 1600,1068 修到 2283,1986 |
| 侧栏路由 | 只靠端口 | **回环 + 同源三重校验**（peer / Host / Origin·Sec-Fetch-Site），伪造来源实测 403 |

## 0.5（实测：常驻 shell、真人轨迹、动效回看）

| 能力 | 之前 | 现在 |
| --- | --- | --- |
| 轻点耗时（含工具往返） | 120–151 ms | **61 ms**（首次 101 ms，建通道成本；之后 61） |
| `adb_sh` 每命令开销 | 70–90 ms（新起 adb） | **2–4 ms**（常驻 shell 提交，命令本身另算） |
| 曲线/长按拖动 | `input swipe` 只能直线 | `adb_gesture` 逐点 DOWN/MOVE/UP（实测 5 控制点 / 16 步 / 请求 600 ms → 1161 ms 返回） |
| 标注回传给模型 | 圈选图 + 圈内控件 | 再加**操作时间线**（`-3.2s 点击「开始」@640,1200`）与**最近 6 秒 6 帧拼图**（265 ms 内建好，112 KB） |

常驻 shell：插件为每台设备保一条 `adb shell` 交互通道，命令串行排队、用随机标记切分输出；超时/断开自动重建并退回一次性 `adb shell`，不会卡死。退出时统一关闭。

`adb_gesture` 的段数是 `duration/40`（3–40 段）：设备端每条 `input motionevent` 有约 35 ms 进程下限，所以 600 ms 的手势实际 1.1 s 左右；要更顺就减点、拉长时间。多指（双指缩放）`input motionevent` 不支持，需要 u2 `gesture` 或 root `sendevent`。

标注回传落点：`~/.dsh/adb-mirror/annotations/`。拼图取自内存里最近 40 帧（约 8 秒，5 fps），不 seek 录屏文件——录屏是 720×1280 且末段还在写，seek 会空手。

## 为什么

原做法是 `adb exec-out screencap` 出 PNG，再 `read_image` 让模型看图。一次「确认页面对不对」要花：一次截图进程 + 一张几百 KB～9 MB 的图 + 一次带图的模型步。

实测（小米平板 8，3200×2136，Android 15，2026-10）对比同一动作的两种取法：

| 取法 | 耗时 | 返回体积 | 模型侧成本 |
| --- | --- | --- | --- |
| `adb -s X exec-out screencap -p` | 0.5 s（纯色页）/ 3.2 s（相机页） | 0.3–8.9 MB PNG | 1 张图 ≈ 1.5–2 k token + 一次带图推理 |
| `adb -s X exec-out uiautomator dump /dev/tty` | 0.33 s（静态页）/ 2.2 s（持续动画页） | 8 KB XML | 压成 460–2872 字符 ≈ **200–1300 token 纯文本** |
| `uiautomator dump --compressed` | 2.1–2.4 s | 5.6 KB | **不要用**，慢 6 倍换 30% 体积 |
| `dumpsys activity` 取前台 Activity | 0.07–0.09 s | 一行 | 判断「有没有进目标页」用它 |
| `logcat -d -t 200` | 0.11–0.14 s | 数 KB | 看报错用它 |

耗时不是全部：截图那条路每次还要一次 `read_image` 往返，文本树直接把「文字 + 资源 id + 中心坐标」写进上下文，点击不再需要算坐标。

## 工具

| 工具 | 作用 |
| --- | --- |
| `adb_ui` | 读界面文本树：`ref`、控件类型、文字、`#资源id`、`@中心坐标`，尾部 `*` 可点击 / `~` 可滚动 / `[x]` 勾选 / `[off]` 不可用。支持 `filter`、`full`、`wait_for_text` / `wait_for_id` / `wait_for_activity` / `wait_until_gone`（替代 sleep + 反复截图） |
| `adb_tap` | 按 `ref` / `text` / `id` / `desc` / `point="x,y"` 点击，`long: true` 长按；可带 `wait_for_text` / `wait_for_id` / `wait_until_gone` 点完直接等结果 |
| `adb_input` | `text`（ASCII，空格自动转义）、`key`（ENTER/BACK/DEL…）、`swipe`、`clear` |
| `adb_gesture` | 真人轨迹：`points` 折线逐点 DOWN/MOVE/UP，`duration_ms`、`hold_ms`；曲线拖拽、按住再拖 |
| `adb_app` | `info`（versionCode/versionName + 前台）、`install`（`-r -d`）、`start`、`stop`、`clear`、`foreground` |
| `adb_sh` | 设备端任意命令，输出截断到 20k 字符；日志、`dumpsys` |
| `adb_shot` | 只在要看颜色/布局/相机画面时截图，默认缩到长边 900 px，返回路径给 `read_image`；`region="x,y,w,h"` 只回一块（看桌宠、小图标时体积降一个量级） |
| `adb_device` | 列设备、状态、型号、当前选中设备与分辨率 |
| `adb_state` | 一次往返：前台 Activity、焦点窗口、窗口栈、键盘、方向、分辨率、亮屏、电量、root（262–376 ms） |
| `adb_do` | 一串动作一次跑完（最多 20 步）：点 / 滑 / 输入 / 按键 / 系统动作 / 等文字，任何一步失败就停并报第几步 |
| `adb_action` | 系统动作一条命令：`home` / `back` / `recents` / `lock` / `wake` / `rotate` / `notifications` / `quick_settings` / `night_mode` |
| `adb_crash` | 最近的崩溃与 ANR：FATAL EXCEPTION 摘要、进程名、首段堆栈，外加 dropbox / `/data/anr` 现场（有 root 时）；用户只说「闪退了」时先查它 |
| `adb_recent` | 最近几秒 6 帧拼图（读本地环形录像，不碰设备）：动效比例/位移/卡顿这类单帧看不出的问题用它 |
| `adb_mirror` | 侧栏「实时ADB」：低帧率直播 + 手点 + 圈选推回会话；`status` / `peek` / `recent` / `stop` |

## 安装

```bash
# 一次性：装进当前 profile（对所有会话生效）
# 在 DSH 里用 plugin_manager：action=install_bundle, target=$HOME/dsh-adb
```

装完 `plugin_manager list_plugins` 里应出现 `include:adb`（`enabled=true`、`fiberPhase=active`）。

配置（可选，写在 bundle patch 的 `config` 下）：

```yaml
- id: adb
  name: dsh-adb
  config:
    serial: ""             # 固定设备序列号；留空则取 ANDROID_SERIAL，再退回第一台 online 设备
    adb: /opt/homebrew/bin/adb  # 可选；不写按常见路径探测
```

卸载：`plugin_manager action=set_plugin, target=adb, enabled=false`，或移除 bundle。

## 自测

```bash
node selftest.mjs              # 只跑只读工具（安全）
node selftest.mjs --tap        # 额外真点一次，会动设备
node selftest.mjs --serial emulator-5554
```

## 已知边界

- 改了 `mirror.js` / `ocr.js` 后要同步改 `index.js` 顶部的 `?v=` 后缀：宿主热重载只重读入口文件，被它 import 的模块仍走模块缓存，不加后缀改了不生效（实测：`/state` 的 `screen` 一直是竖屏 `2136x3200`，加上 `?v=` 重载后变 `3200x2136`）。

- **中文输入**：`adb shell input text` 不支持非 ASCII，`adb_input` 会明确报错而不是静默吞字。中文走剪贴板或 App 内的粘贴。
- **动画页读树慢**：`uiautomator dump` 内部会等界面空闲，相机预览这类持续刷新的页面要 ~2 s；静态页只要 0.33 s。这种页面优先用 `adb_app foreground`（0.09 s）判断页面，只在真要读控件时 `adb_ui`。
- **`ref` 有时效**：每次 `adb_ui` 重新编号，超过 2 分钟或界面变了就失效，会报错提示重新读，不会点错位置。
- **多设备**：默认第一台 online 设备；同时插着平板和模拟器时用 `config.serial` 或 `--serial` 明确指定。

## 0.2（实测数据，小米平板 8，已 root）

新增能力：

- `adb_state`：一次往返拿前台 Activity、焦点窗口、窗口栈、键盘、方向、分辨率、亮屏、电量、root。实测 262–376ms（比截图 + 读图快，且弹窗/键盘判断更准）。
- `adb_sh root=true`：以 `su -c` 执行；实测可读 `/data/data/com.example.app/shared_prefs`（非 root 对照为 Permission denied）。
- `adb_tap` 自动落最近可点祖先 + `dry_run` 预演落点（先确认再点，避免点错返工）。
- `adb_device` 增加设备画像（`ro.build.characteristics`、sdk、root）。

### 测量记录（同一设备，逐条实测）

| 动作 | 耗时 | 备注 |
| --- | --- | --- |
| `adb_state`（7 段 dumpsys 合并一次 shell） | 262–376ms | 含 5 次 dumpsys + `wm size` |
| `dumpsys window`（设备侧） | 0.03–0.05s | 含 `mCurrentFocus` / `mFocusedApp` + 18 个窗口 |
| `dumpsys activity activities \| grep mResumedActivity` | 时有时无 | MIUI 上不可靠，已改用 window 的 `mFocusedApp` |
| `uiautomator dump`（静态页 / 动画页） | 0.33s / 2.2s | 动画页仍是最慢的一环 |
| `screencap -p` PNG | 0.49–0.58s（90KB） | 相机预览页曾达 3.2s（8.9MB） |
| 原始 RGBA screencap（想省 PNG 编码） | 2.05–2.38s（27MB） | **比 PNG 慢**，已放弃 |
| 关掉动画缩放后 dump | 2.05s → 1.64s | 只省约 20%，不是银弹 |

### 踩过的坑

- 合并 shell 命令里 `echo ##A` 会被 sh 当注释，整条命令静默不执行 → 标记改成 `@A@`。
- 前台 Activity 不能用 `dumpsys activity activities` 抓（MIUI 缺行），统一走 `dumpsys window` 的 `mFocusedApp`；焦点窗口 ≠ 前台 Activity 时判定为有弹窗/浮层。

## 0.3（实测，小米平板 8，已 root）

- **读界面提速 15 倍**：设备端常驻 uiautomator2（openatx，Apache-2.0）走 `app_process`，`adb_ui` 从 2343 ms 降到 **136–153 ms**，同样返回文本树与 `ref`。首次使用自动 push `vendor/u2.jar` + 装 `vendor/app-uiautomator.apk` 并拉起服务，之后复用；进程死了下次调用自愈。
- **实时ADB 侧栏**：直播 2.8–3.4 帧/秒（`/state` 实测 3.4，单帧 21–48 KB），画面上能直接点、能圈一块把「这里 + 设备坐标 + 前 12 秒操作时间线」连同截图推回当前会话（实测注入成功，返回 `{"ok": true}`）；本机留最近 3 分钟分段（10 s 一段 × 18 段，实测 17 段 212 KB）。全部在本机，不经过外部服务。

### 镜像的实测结论（都踩过）

| 事实 | 实测 | 结论 |
| --- | --- | --- |
| `screenrecord --output-format=h264 -` 静止画面 8 s | 8.7 KB、只出 1 帧 | 直播不能只靠录像 |
| 同一路 h264 加 `-vf fps=4` | ffmpeg 直接 `-22`、0 字节 | 单帧被 fps 滤镜丢掉，删掉滤镜 |
| 改为 `screencap -p` 一帧 | 0.7–1.2 s | 直播改走截图续帧，稳 |
| `screencap -p` 的字节头 | PNG 签名（不是 JPEG SOI） | 先找 `89 50 4e 47` 再交 ffmpeg `png_pipe` |
| 设备端分段录制 10 s → `cat` 拉回 | 单段 8–16 KB、可 `ffprobe` 出时长 | 环形缓冲走分段文件，不走管道 |

## 0.4（实测，小米平板 8，已 root）

- **直播 4.5–5.0 帧/秒**：连续看 20 s 收到 121 帧（5.0 帧/秒），`/state` 报的实测帧率 4.3–4.9。做法：3 张 `screencap -p` 并发轮流补位，每张一出就交给一次 `ffmpeg png_pipe` 转 JPEG，按 200 ms 固定节拍把最新帧写给侧栏。
- **没人看时零开销**：关掉侧栏后实测 `frames` 停在 159 不再增长，设备端 `screencap` 进程消失；设备上的 10 s 分段录像照旧走，本机只留最近 3 分钟。
- **本机开销**：转码约 16 ms CPU/帧（≈8% 单核），每帧约 54 KB、本机 240 KB/s，全在回环地址上。

| 试过 | 实测 | 结论 |
| --- | --- | --- |
| 一张一张抓 | 单张 0.65 s → 1.4 帧/秒 | 不够 |
| 3 张并发抓 | 3–4 路并发 0.61–0.68 s → 4.3–4.9 帧/秒 | 采纳 |
| 常驻 ffmpeg `image2pipe` 吃 PNG | 喂 1 张后 3 s 不出字节；`-flush_packets` / `-analyzeduration 0` 也无效，只在 stdin 关闭时一次性吐出 | 不能用于直播，改每帧起一次 `png_pipe` |
| 有帧才推 | 并发抓帧成簇完成，画面被削到 1.2–1.7 帧/秒 | 改为固定 200 ms 节拍重发最新帧 |
| 抓帧时的设备侧占用 | `screencap -p` 峰值约 1 核 | 只在有人看时抓 |

## 路线图（未实现，按收益排序）

2. **scrcpy（~120k★）视频流**：连续 H.264 + 精确输入，单帧约几十毫秒，适合扫码/相机预览这种截图极慢的页面。
3. **WebView CDP**：拿到 DOM 文本与 JS 状态，替代 WebView 内稀疏的文本树。
4. **手表/眼镜**：靠 `ro.build.characteristics=watch` 等做设备画像；圆屏按内切矩形裁剪点击坐标；走 `adb pair`/`adb connect` 的无线 ADB；GL 自绘界面文本树为空时回退截图。均【未核实】。
5. **root 直读**：`shared_prefs`/`files` 已可读；数据库需 push 一个静态 `sqlite3` 二进制（当前系统无 sqlite3）。

## 性能

同一台测试机（小米平板 8，3200×2136，Android 15，USB 直连，宿主 macOS，2026-10）上的实测。下表数字均为实测；`约 1 帧/秒` 是内容驱动下的实测近似值，不是估算。

| 能力 | 旧做法 | 现在 | 实测 |
| --- | --- | --- | --- |
| 截一张图 | `exec-out screencap -p` 出 PNG | `exec-out screencap -j` 设备端直出 JPEG，按右栏显示宽度缩放 | PNG 3.2 s / 8.9 MB → **330 ms**；900 px 34 KB，600 px 19 KB |
| 读界面文本树 | `uiautomator dump` 每次冷启动 | uiautomator2 常驻服务直接读树 | dump 350 ms → **120 ms** |
| 单条 adb 命令 | 每条 `execFile` 起一次 adb | 每台设备一条常驻 `adb shell` 通道 | **33 ms → 20 ms** |
| 侧栏直播 | JPEG 长轮询逐帧抓（保留作兜底） | `screenrecord --output-format=h264` + ffmpeg 转 fMP4 + MSE | 960×640；首帧 **1380 ms**；画面一变到上屏 **+163 ms**；空闲约 1 帧/秒（`screenrecord` 内容驱动） |
| 近 6 秒回看 | 连拍截图再拼 | 本地环形录像抽 6 帧拼图，不碰设备 | 6 帧拼图 **365 ms** |
| 多步操作 | 一步一个工具往返 | `adb_do` 一次调用串起多步 | 2 步 **318 ms** |
| 侧栏重开 | 每次重新起流、等首帧 | 最后一个观众走后录屏留 20 秒 | 冷开首帧 **2440 ms** → 20 秒内重开 **18 ms** |
| 只截一块 | 截整屏再自己裁 | `adb_shot region` 在宿主侧裁 | 640×420 **13 KB**（整屏约 80 KB），732 ms |

- 截图这条路省的是设备编码、回传体积和浏览器解码三段：PNG 3.2 s / 8.9 MB，JPEG 330 ms，900 px 34 KB、600 px 19 KB；右栏只显示几百 px 宽，按显示宽度缩放后体积和延迟一起降。
- 读界面默认走文本树：uiautomator2 常驻 120 ms，比朴素 `uiautomator dump` 的 350 ms 快近 3 倍，返回的仍是可点的文字 + 资源 id + 坐标。
- 每条命令的开销在通道不在命令：常驻 shell 把起进程的 33 ms 压到 20 ms。
- 直播按内容驱动：H.264 960×640 在画面静止时约 1 帧/秒，变化到上屏 +163 ms；首帧 1380 ms 含页面加载与建流；MSE 起不来时仍退回 JPEG 长轮询。
- 侧栏重开几乎是零成本：录屏与最后一段 IDR 都还在，20 秒内重连直接用，实测 2440 ms 降到 18 ms；超过宽限才真正停掉。
- 区域裁切省的是 token 而不是设备时间（整屏 `screencap` 仍要跑），但一张 640×420 的图比整屏小一个量级，模型看细节反而更准。
- 起流失败的两个真实原因都已处理：本地 `adb` 被强杀后设备端 `screenrecord` 会活到 `--time-limit`，占住编码器让下一次开流必失败；同一毫秒起两个录屏也会互相打架。现在开流/停流都先清残留，且只有真故障才置错误。
- `adb_recent` 的 365 ms 拼图不占设备（读本地环形录像），`adb_do` 2 步 318 ms 说明多步流程的瓶颈仍是设备侧动作，不是工具往返。
