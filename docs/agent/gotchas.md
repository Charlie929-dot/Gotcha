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
| Playwright 跑 Electron E2E | `electron.launch()` 继承 shell 的 `ELECTRON_RUN_AS_NODE=1` 会退化成 Node 直接崩；且默认会读写真实 userData | 测试里先 `delete process.env.ELECTRON_RUN_AS_NODE`；用 `GOTCHA_USER_DATA` 指向临时目录（main 用 `app.setPath('userData')` 覆盖），跑完 `rmSync`；Playwright 不需要 `playwright install` 浏览器（Electron 走本地 electron 包），2026-10-21 验证 2 用例通过 |
| 帧差指纹尺寸混用 | 截图层返回的是 90x80 灰度，OCR 图尺寸却是 1280x1029；调用方若拿 OCR 尺寸去 `dHash(gray, width, height)`，越界读到 `undefined` → 指纹恒同 → **帧差永不触发**：真机 34 分钟只入 1 条事件，而单测全绿（单测里 width/height 恰好等于灰度尺寸，盲区） | 指纹在截图层按灰度自身尺寸算好再交给管线（`CapturedFrame.diffHash`），管线不得用 image 尺寸重算；`dHash` 对「缓冲区不足」直接抛 `RangeError`，把这类错变成响错；2026-10-21 真机验证：修复后 30 秒 5–8 条事件 |
| WinRT OCR 对真实屏幕小字号中文错误率高 | 合成图 13px 中文识别 100% 正确，但真实窗口截图里「记事本」被读成「记不文亻牛」、「应用」读成「旧应用」；英文同样有错（verify→verlfy）。**根因是字号不是画质**：同一张截图 15 个关键词，原生 1152 宽命中 11/15、缩到 806 宽 13/15、**放大 2× 后 15/15**（放大后耗时反而更低：118ms vs 原生 250ms） | OCR 输入统一放大 2×（上限 3840 宽，`src/capture/ocr-scaling.ts`，`resize` quality 用 `'best'`）。仍读不对的是浅灰底小字（如记事本标题栏），M1a 接受：**应用名/窗口标题来自 active-win**，OCR 只作摘要；M2 前若要再上一档再评估云端 VLM（`docs/cloud-ocr-vlm-draft.md`） |
| 屏幕捕获阻塞主线程 | 采集模式下时间线鼠标悬停 1–2s 才变色、滚轮几秒才动；主进程 CPU ~50%，渲染进程却空闲。探针实测 `desktopCapturer.getSources()` 本机单次 **1.2–2.3s**（与 thumbnailSize 无关：320×180 也要 1.4s），且同步卡住 Electron 主进程 UI 线程 → OS 输入事件排队；每 2s 采一次 = 持续冻结（2026-10-21 实测事件循环最大卡顿 2209ms） | 改为隐藏窗口常驻 `getDisplayMedia` 屏幕流：`src/capture/screen-stream.ts` 启动时只 `getSources` 一次做「显示器 → 源」映射，之后每帧用 `executeJavaScript` 让 `src/renderer/capture-window.ts` 在隐藏渲染进程里裁剪 / 2× 放大 / PNG 编码，主进程只写文件 + 算 dHash。真机 12s 采样：主进程 IPC 往返 **max 5ms / p95 2ms**，OCR 正常出「记忆球 时间线」；启动多 ~1.5s（getSources 一次） |
| 暗色模式按钮悬停变近纯白 | 鼠标放到时间线按钮上，按钮从深灰 `#26262c` 直接变成近白 `#f0f0f4`（本机 `AppsUseLightTheme=0`），像「悬停闪白」 | `.nav button:hover` 必须写在暗色媒体查询内（`#2f2f37`）并补 `:active`；按钮加 120ms 颜色过渡，避免主题切换瞬间的闪色。E2E 断言暗/亮两种模式的 hover 计算色（`tests/e2e/timeline.spec.ts`） |
| A2 CPU 采样受屏幕变化频率影响 | 同一运行时：两次 5 分钟静置窗口 **1.58% / 1.24%**（各约 12 次帧变化），含启动的 23 分钟累计 **3.63%**；OCR 只在帧变化时执行，屏幕持续变化时 0.6–1.2s/帧 ≈ 最坏 5% | 报 A2 必须同时给「窗口内帧变化次数 / 事件数」与累计均值；只看 5 分钟静置数会低估，只看含启动累计会高估。新旧架构对比固定同一采样法：`Get-Process` 全树（含 OCR 子进程）`TotalProcessorTime` 增量 / 时长 / 逻辑核数（2026-10-21 实测） |
| stats 跨午夜归属漂移 | `stats.day.<date>` 启动时按当天 key 载入，但 00:00 后 60s 落盘换成新 key 写入的仍是**同一份累计计数器**：2026-10-22 的 key 含 10-21 累计（13782 帧，不是当日新增），`capture_errors:607` 两天完全相同 | **已修（2026-10-22）**：`src/capture/stats.ts` 的 `createDailyStatsFlusher` 在 flush 时比较 `statsKey(now)` 与当前 key，跨日先把旧 key 落盘、再 `resetStats()` 清零写新 key；回归用例 `tests/unit/stats.test.ts`「跨午夜 flush」。边界误差 ≤ 一轮 flush 间隔（60s）：跨日后到下一次 flush 的帧仍归旧 key，新 key 从 0 起算 |
| 异步退出收口卡死 | 在 `will-quit` 里 `event.preventDefault()` 等异步 stop，完成后再 `app.quit()`，进程不退出（E2E `app.close()` 60s 超时；无窗口时偶发能退出，有窗口必现）；`window-all-closed` 在 quit 进行中重入 `app.quit()` 同样卡住（2026-10-22 实测） | 异步收口放 `before-quit`（`preventDefault` → await stop → closeAll → `app.quit()`）；用 `before-quit` 置 `quitRequested`，`window-all-closed` 与窗口 `closed` 处理器在 quit 进行中不再补 `app.quit()`。改完 E2E `app.close()` 恢复到 ~0.1s |
| 非整数缩放下透明窗口越拖越胖 | 本机 125%（`scaleFactor=1.25`），64×64 透明置顶球窗口放到右边缘时 `getBounds()` 变成 68×64，**每次 `setPosition` 宽 +1**（64→68→69…70）；`setContentSize(64,64)` 只能压回 65，且 `setPosition` 传小数会直接 `TypeError: conversion failure`（2026-10-22 实测 Electron 45） | 根因是整数 DIP 落在非整数物理像素上，Windows/Chromium 取整窗口尺寸；`win.setPosition` 前先把坐标吸附到「`DIP × scaleFactor` 为整数」的像素网格（`snapToPixelGrid` / `positionOnPixelGrid`，`src/main/ball-position.ts`），代价是 125% 下贴边 6px 会落成 4–8px；单测 `ball-position.test.ts` + E2E「球窗口 64×64 / 拖动后位置」覆盖 |
| 球被自己录进截图 | 球常驻置顶叠在活动窗口上，按窗口 bounds 截屏会把它一起截进去（污染 OCR / 帧差） | `win.setContentProtection(true)`（Windows 走 WDA_EXCLUDEFROMCAPTURE）有效：2026-10-22 真机实测 `desktopCapturer.getSources` 缩略图里，球区域「显示 vs 隐藏」逐像素 diff = 0（1920×1080，80×80 区域全等）。注意 CopyFromScreen 截图同样看不到球——这是预期（隐私收益），别拿它当「球没显示」的证据；球是否在屏上由 `BrowserWindow.isVisible()` / 用户肉眼确认 |

## 规则

- 同一个坑第二次出现，说明这里没记住——先补本文件，再修代码。
- 对策要可执行（命令、参数、版本号），不写「注意一下」。
- 涉及版本敏感的行为，写清验证日期或版本。
