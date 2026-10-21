# 已知坑（Gotchas）

> `AGENTS.md` 的外链细节。踩到一个补一行，带现象和对策。

| 坑 | 表现 | 对策 |
| - | - | - |
| 全局键鼠钩子 | 被 AV 当键盘记录器误报、被删 | M1 不上全局键鼠钩子；意图信号只用窗口/剪贴板（被动、干净） |
| 全屏截图 | 功耗、发热、隐私面过大 | 帧差 + 只裁前台窗口 + 降采样；内容未变直接丢弃 |
| LLM 归纳编造 | 记忆污染，用户不再信任 | `intent_json` / 归纳节点强制 `source_events`；上层面必须可下钻核对 |
| OCR 中文精度 | 记错关键词，检索失效 | WinRT 系统 OCR 起步；接口留替换点，不够再换 RapidOCR |
| 图谱万节点 | 渲染卡顿 | LOD 分层默认折叠 + 时间窗过滤 + sigma.js 大规模设计 |
| better-sqlite3 原生模块 | Electron 版本不匹配报 ABI 错误 | better-sqlite3 ≥13 已 N-API 化：13.0.3 同一份自带 prebuilds 在 Node 24.13 与 Electron 45.0.0（napi 10）均可加载，**无需 electron-rebuild**（2026-10-21 两运行时实测）；仍锁版本 13.0.3，大版本升级后先跑 `npm test` + dev 冒烟 |
| npm 11 安装脚本白名单 | `npm install` 警告 `better-sqlite3@13.0.3 (install: node-gyp rebuild) not covered by allowScripts`，安装脚本未执行 | 本机用 v13 自带 prebuilds，不执行也不影响；`active-win@9` 同理自带 `napi-9-win32-x64` 预编译，跳过 install 脚本仍可用。将来若必须本地编译，先 `npm install-scripts approve <pkg>`（需拍板） |
| WinRT OCR 只能在 PowerShell 5.1 里调 | pwsh 7 加载 `[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]` 失败（.NET Core 无 WinRT 投影）；PS 5.1 正常，长驻进程稳态往返 ~43ms（1080p） | 用 `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File resources/ocr/winrt-ocr.ps1`，JSON 行协议（启动先输出 `{"ready":true}`）；2026-10-21 实测 |
| active-win 在 Electron 主进程返回物理像素 | 同一窗口 node 里 1550×830、Electron 里 1938×1038（@1.25），而 `display.bounds` 是 DIP（1536×864）→ 直接相减裁剪会错位（2026-10-21 实测） | 先把 `display.bounds × scaleFactor` 换成物理坐标再裁剪；desktopCapturer 的 thumbnailSize 也用 `DIP × scaleFactor`（screen.ts 已按此实现） |
| Electron `NativeImage.getBitmap()` 已废弃 | Electron 45 类型里返回 `void`，`new Uint8Array(image.getBitmap())` 报 TS2769 | 用 `image.toBitmap()`（返回 Buffer，RGBA），见 screen.ts |
| WinRT OCR 中文按字分词 | 结果 CJK 字符间插空格：「记 忆 球 测 试」；M1a 原样入库（D10 忠实还原） | 不在采集层做归一化；M2 归纳/检索时再处理分词空格 |
| electron-vite 自定义启动参数 | `npm run dev -- --capture` 报 `CACError: Unknown option --capture`（参数被 electron-vite 当成自己的 CLI 选项） | 用仓库脚本 `npm run dev:capture`，或 `npm run dev -- -- --capture`（第二个 `--` 透传成 ELECTRON_CLI_ARGS），或 `GOTCHA_CAPTURE=1 npm run dev` |
| 透明置顶窗口 | 挡点击 / 抢焦点 / 任务栏异常 | 收起态 `setIgnoreMouseEvents(true, { forward: true })`，只在交互区恢复；永不 `focus()` 抢焦点 |
| 归纳任务与实时采集争用 | 卡顿、事件积压 | 归纳走 worker + 任务队列，空闲/低负载时执行；队列有上限与背压 |
| 「为了调试」打印原文 | 隐私事故 | 日志只记 id + 元数据；代码审查重点看日志语句 |
| 文档漂移 | 方案说的和代码不一致 | 按 workflow.md §5 同步矩阵 + 提交前自检 |
| Electron 宿主 shell 启动 electron | DSH（Electron 应用）向子 shell 注入 `ELECTRON_RUN_AS_NODE=1`，`electron.exe` 退化为纯 Node：`electron.app` undefined、`whenReady` 直接崩（2026-10-21 验证：Electron 45.0.0） | 启动前清变量：PowerShell `Remove-Item Env:\ELECTRON_RUN_AS_NODE`；bash `unset ELECTRON_RUN_AS_NODE`。仅 DSH 派生 shell 需要，用户自有终端不受影响 |
| electron 二进制未随 npm install 下载 | 本机 `npm install` 后 `node_modules/electron/dist` 缺失（electron 45 包未见 postinstall 钩子，2026-10-21 验证），dev 起不来 | 装完检查 `node_modules\electron\dist\electron.exe`（约 238MB）；缺失则 `node node_modules/electron/install.js` 手动补 |

## 规则

- 同一个坑第二次出现，说明这里没记住——先补本文件，再修代码。
- 对策要可执行（命令、参数、版本号），不写「注意一下」。
- 涉及版本敏感的行为，写清验证日期或版本。
