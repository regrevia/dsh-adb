# dsh-adb 开源前审计

- 审计对象：`/Users/apple/Desktop/odd/dsh-adb` 工作区（HEAD `ecc6738` + 未提交修改）
- 审计时间：2026-10-27（行号以当日工作区快照为准，代码仍在并行改动，提交前请复核）
- 方法：逐文件 grep（路径、IP、域名、token、序列号、调试路由、占位符、许可证），`git ls-files` / `git status`，`npm pack --dry-run --json` 实际打包清单，`sha256sum vendor/*`
- 范围：只读审计，未改任何 `.js` / `package.json`；本报告自身是唯一新增的审计产物
- 忽略：`.git/`（版本库元数据，不随包发布）、`vendor/`（第三方二进制，只查许可证与再分发义务，未反编译）、`node_modules/`（当前不存在）

## 结论摘要

**剩余高风险 3 条**（发布会直接坏或存在合规缺口），中危 6 条，低危 4 条。另有一批原本列入高危的问题在并行修复中已处理，见文末「已修复项」，提交前不要回退。

| 等级 | 数量 | 主题 |
| --- | --- | --- |
| 高 | 3 | npm 包缺 OCR worker、git 漏跟踪运行时文件、vendor 二进制缺许可证 |
| 中 | 6 | README 安装占位符、回环信任边界文档不符、调试路由残留、selftest 端口、屏幕内容落盘、设备指纹 |
| 低 | 4 | 版本号静默降级、探针死代码、macOS 路径、误报排除 |

负向结论：仓库内**没有** `/Users/apple` 或个人主目录真实路径、**没有**内网/公网真实 IP、**没有** token/密钥/Authorization/Cookie、**没有**真实设备序列号（只有 `emulator-5554` 示例）、没有 `.env`（只有空值的 `.env.example`）。详见「未发现项」。

## 一、高危（发布阻塞）

- **`package.json:27-41`（files 白名单）** → 白名单已列 `ocr.js`，但漏了它运行时 spawn 的 `ocr_worker.py`（`ocr.js:19` `const WORKER = join(HERE, 'ocr_worker.py')`）。`npm pack --dry-run --json` 实测打包 13 个文件，`ocr_worker.py` MISSING；安装后 `ocrAvailable()` 因文件不存在返回 false，OCR 兜底静默失效。→ 把 `"ocr_worker.py"` 加进 `files`；发布前用 `npm pack --dry-run --json` 核对清单里是否同时有 `ocr.js`、`ocr_worker.py`。
- **`mirror.js:23` + `git status`** → `stream.js` 与 `client.rev` 在工作区是未跟踪文件（`?? stream.js`、`?? client.rev`）。`mirror.js:23` 顶层 `import ... from './stream.js?v=137'`，干净克隆 HEAD 会缺模块，插件直接起不来；`client.rev` 缺失则 `mirror.js:108` 读取失败、版本协商失效。package.json 已把两者写进 files，但 git 里没有，属于「打包能过、克隆就坏」。→ `git add stream.js client.rev` 并纳入正常提交；发布 tag 前用 `git ls-files | grep -E 'stream\.js|client\.rev'` 必须两条都命中。不要用 `.gitignore` 掩盖。
- **`vendor/u2.jar`、`vendor/app-uiautomator.apk`** → 两个第三方二进制随包再分发。`u2.jar` 内只有 `LICENSE-junit.txt`（junit 的），`app-uiautomator.apk` 内无任何 LICENSE/NOTICE；README:170 声明来自 openatx uiautomator2、Apache-2.0，但仓库没有 `THIRD_PARTY_NOTICES.md`，不满足 Apache-2.0 §4 的 NOTICE 与来源说明义务。→ 新增 `THIRD_PARTY_NOTICES.md`：上游仓库 URL、版本、Apache-2.0 全文、获取方式，并附二进制 sha256（`u2.jar` = `87c8ac9505970d42aa5922baa90114808fda6f47f9e5fbd4caa0f621c2c8d30d`，`app-uiautomator.apk` = `6f85594700ad96de89d012b3767049c2c6988510b68b31b439dd2a6dd93a30c9`）。本审计不构成法律意见。

## 二、中危

- **`README.md:6`、`README.md:8`、`README.md:9`、`README.md:108`** → 安装命令仍是占位符：`git clone <这个仓库>`、`target=<克隆目录>/dsh-adb`、`"link:<克隆目录>/dsh-adb"`。`package.json:43-50` 已换成真实地址 `https://github.com/regrevia/dsh-adb`，两边不一致。→ 统一替换为 `git clone https://github.com/regrevia/dsh-adb.git dsh-adb` 与真实克隆目录，发布前点一遍命令。
- **`mirror.js:792-805`（isLocal）** → 信任边界：GET/HEAD 只校验 peer 与 Host，直接放行，不校验 `Origin`/`sec-fetch-site`；非 GET 在 `Origin` 为空且 `sec-fetch-site` 为 undefined 时也放行（本机 CLI/进程无这两个头）。浏览器跨站读不到响应（服务端不发 CORS 头），但可以 GET `/watching`、`/frame` 触发设备抓帧/录屏；本机任意进程可 POST `/tap` 等直接操作设备。README:3「校验 peer / Host / Origin，伪造来源实测 403」只对带 `Origin` 的写请求成立，表述过强。→ README 写清「只防浏览器跨站，不防本机进程」；如需再收紧，GET 也要求同源 `sec-fetch-site`，本机 CLI 走显式豁免。
- **`mirror.js:909`（/stream/info）、`mirror.js:919`（/watching）、`mirror.js:985`（/recent）** → 调试/内部路由仍无条件下注册：`/stream/info` 只有 `selftest.mjs:112` 用；`/watching`、`/recent` 全仓库无调用方（`/recent` 还返回本机分段目录 `dir`）。`/dev/mse`（`mirror.js:914`）与 `/sessions`（`mirror.js:1053`）已用 `DEV`（`mirror.js:64`，`DSH_ADB_DEV === '1'`）门控，默认 404，已缓解；但 `mirror.js:1157-1158` 注释仍称自测页「不参与打包」——`DEV_MSE_PAGE` 就在 `mirror.js` 里随包发布，只是运行时打不开，描述与事实不符。→ 删 `/watching`、`/recent`、`/stream/info`（selftest 改读 `/stream` 头或环境变量），`/dev/mse`+`/sessions` 的 DEV 分支连同 `DEV_MSE_PAGE` 一起删，或改注释；README 增加「开发开关」一节。
- **`selftest.mjs:112`** → `const base = 'http://127.0.0.1:60930/dsh-adb'` 硬编码端口；当前 GUI 实际是 `http://127.0.0.1:50802`，换端口后自测整体失败。→ 读 `process.env.DSH_WEB_PORT ?? 60930` 或 argv，README 里给出 `DSH_WEB_PORT=... node selftest.mjs` 用法。
- **`mirror.js:70`、`mirror.js:703-704`** → 屏幕内容落盘且无清理：`ROOT = ~/.dsh/adb-mirror`，标注 PNG `annotations/adb-<ts>.png` 永久保留，录屏分段 `screen-*.mp4` 也在同目录。README:3 只声明「不上传任何画面」，没披露本机留存与清理方式。→ README 增加「本机留存」小节（路径、保留策略、如何删）；代码侧后续按天数清理（本审计不改代码）。
- **`README.md:53`、`README.md:75`、`README.md:142`、`README.md:157`、`README.md:168`、`README.md:183`、`README.md:206`、`index.js:4`、`index.js:722`、`index.js:2137`、`mirror.js:223`、`client.js:678`、`ocr.js:7`** → 设备指纹贯穿文档与注释：小米平板 8、3200×2136、Android 15、已 root、MIUI、2026-10，以及具体点按坐标（README:53 `1600,1068` → `2283,1986`）。不是身份信息，但公网仓库可据此推断个人测试环境，且坐标只对这台机器成立。→ README 统一为「测试机（平板 3200×2136 / Android 15 / 已 root）」并加一句「机型与坐标仅用于复现实测条件，换机需重测」；如保留型号，需确认仓库所有者接受。

## 三、低危

- **`mirror.js:104-108`** → `client.rev` 读取失败时 `catch { return '' }`，`build` 静默变空，页面版本协商静默失效（配合上面的漏跟踪会放大）。→ 失败时 `console.warn`，并在 `selftest.mjs` 断言 `client.rev` 存在且非空。
- **`mirror.js:726`** → `sessionProbe()` 里 `out.agentIds = keys.slice(0, 8)` 写在 `const out` 声明之前，TDZ ReferenceError 被外层 catch 吞掉，`agentIds` 永远拿不到。探针已被 `DEV` 门控，风险低；删探针时一并清掉这段死代码。
- **`index.js:51`、`mirror.js:56`、`README.md:120`、`cordis.patch.yml:5`、`.env.example:5`** → `/opt/homebrew/bin/...` 作为默认路径示例，只覆盖 macOS/Homebrew；Linux/Windows 用户按文档操作会找不到 adb/ffmpeg。不是个人信息，属可移植性。→ README 注明「非 macOS 用 `ADB`/`FFMPEG` 环境变量或 PATH，不要照抄路径」。
- **误报排除（不用改）** → `icon.svg:1` 的 `http://www.w3.org/2000/svg` 是 SVG 命名空间，不产生网络请求；`mirror.js:749` 的 `http://dsh.invalid` 是 RFC 2606 保留域名，仅作 URL 解析 base；`client.js:1021` 的 `svc-sidebar` 是诊断事件名，不是路由（全仓库没有 `/svc`、`/svc-sidebar`、`/dom`、`/pane` 处理器）；`README.md:130`、`selftest.mjs:7` 的 `emulator-5554` 是示例序列号；`selftest.mjs:112` 的 `127.0.0.1:60930` 是本机回环示例。

## 四、专项：调试/内部路由清单

| 路由 | 位置 | 调用方 | 现状与建议 |
| --- | --- | --- | --- |
| `/stream/info` | mirror.js:909 | selftest.mjs:112 | 仅自测用，建议删或 DEV 门控 |
| `/dev/mse` | mirror.js:914 | 人工调试 | 已 DEV 门控（默认 404），建议连 `DEV_MSE_PAGE`（1157+）一起删 |
| `/watching` | mirror.js:919 | 无 | 遗留保活接口，建议删 |
| `/frame` | mirror.js:927 | client.js:461、690 | 产品在用（MSE 兜底），保留 |
| `/state` | mirror.js:952 | client.js:493 | 产品在用，但字段过宽（`dir` 分段路径、`want` 会话 id/标题、`clients` pid、`diag`），建议收窄 |
| `/recent` | mirror.js:985 | 无 | 返回本机分段目录，建议删 |
| `/text` | mirror.js:1025 | client.js:619 | 产品在用（输入文字），保留 |
| `/want` | mirror.js:1041 | client.js:1105 | 产品在用，暴露当前会话 id/标题，建议只回 `at/pages` 或加同源校验 |
| `/diag` | mirror.js:1045 | client.js:65 | 产品在用，收客户端诊断进 `/state`，保留但限制字段长度 |
| `/sessions` | mirror.js:1053 | 无（探针） | 已 DEV 门控，建议整段删除（含 `sessionProbe`） |
| `/annotate` | mirror.js:1056 | client.js 标注按钮 | 产品在用，保留 |

## 五、专项：package.json / .gitignore / LICENSE

- **package.json:27-41（files）**：已含 `client.rev`、`stream.js`、`ocr.js`，仍缺 `ocr_worker.py`（见高危第 1 条）。`LICENSE` 不在白名单但 npm 默认必带，实测 13 个文件里有，无需改。
- **package.json:43-50（repository/homepage/bugs）**：已从 `your-name` 占位符换成 `https://github.com/regrevia/dsh-adb`，格式正确，无需再改；仅需确认该仓库真实存在且 issues 可访问。
- **`.gitignore:4`**：只有 `.env`，缺 `.env.*`（本地覆盖文件常见 `.env.local`）。建议 `.env.*` + `!.env.example`。`client.rev` **不应**加进 `.gitignore`（它是运行时版本号，必须提交，见高危第 2 条）。`.gitignore:8-11` 已补 `annotations/`、`*.mp4`、`recent-*.png`、`peek-*.jpg`：`~/.dsh/adb-mirror` 在仓库外（`mirror.js:70`），这些规则是预置，防止有人把缓存拷进仓库时误提交，保留即可。
- **`LICENSE:1-21`**：MIT，第 3 行 `Copyright (c) 2026 dsh-adb contributors`，与 `package.json:42 "license": "MIT"`、`package.json:43 "author": "dsh-adb contributors"` 一致，无需改。

## 六、未发现项（负向证据）

- 个人路径：`grep -rn '/Users/'`（排除 `.git`）→ 0 命中；文档里的 `~/.dsh/adb-mirror/...` 是应用数据目录，不是用户名路径。
- IP：只有 `127.0.0.1`（index.js:2018、mirror.js:931 附近、selftest.mjs:112）与 `dsh.invalid`（mirror.js:749）；无 `10./172.16-31./192.168.` 内网地址，无公网 IP。
- 凭据：无 `AKIA`、`ghp_`、`sk-`、`xox`、`PRIVATE KEY`、`Authorization`、`Cookie` 等模式命中；仓库内无 `.env`，`.env.example` 三个变量均为空值。
- 序列号：无真实设备序列号，只有 `emulator-5554` 示例（README:130、selftest.mjs:7）。
- 示例数据：locale 两个文件各 6 行，只有界面文案，无数据。
- 第三方：`vendor/` 只有两个二进制与 `LICENSE-junit.txt`，没有夹带源码或额外资源。

## 七、发布前 checklist（按顺序）

1. `package.json` files 补 `ocr_worker.py`，`npm pack --dry-run --json` 核对 14 个文件。
2. `git add stream.js client.rev`，`git status --short` 除构建产物外必须干净，打 tag。
3. `vendor/` 补 `THIRD_PARTY_NOTICES.md`（含 Apache-2.0 全文与 sha256）。
4. README 替换 4 处安装占位符，补「本机留存」「安全边界」「开发开关」「平台差异」四段说明。
5. 删 `/watching`、`/recent`、`/stream/info`、`/dev/mse`+`DEV_MSE_PAGE`、`/sessions`+`sessionProbe`；`/state`、`/want`、`/diag` 收窄字段。
6. `selftest.mjs` 端口改环境变量，`README` 同步用法。
7. 发布前在干净克隆 + `npm pack` 安装各跑一次：插件能挂载、`adb_ui`/`adb_shot`/直播可用、OCR 兜底可用。

## 已修复项（并行修复中已处理，勿回退）

- `package.json:43-50`：仓库地址占位符已替换为真实地址。
- `package.json:31-32` + files：`client.rev`、`stream.js`、`ocr.js` 已加入 files（仅缺 `ocr_worker.py`）。
- `mirror.js:64`：新增 `DEV = process.env.DSH_ADB_DEV === '1'`，`/dev/mse`（914）与 `/sessions`（1053）已门控。
- `.gitignore:8-11`：已补 `annotations/`、`*.mp4`、`recent-*.png`、`peek-*.jpg`。
