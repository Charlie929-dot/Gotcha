# M1b 悬浮球壳 · 实施方案（草案 v0.2）

> 状态：**草案（2026-10-22 v0.2，待拍板）**。§8 的 Q 未获明确批准前，不进入其「阻塞」列标注的 Phase（decisions.md「拍板人与授权载体」：沉默 ≠ 批准）。
> 上游依据：技术方案 §6.1 / §6.3 / §7（M1b 行）、策划案 §8.1、security.md、workflow.md、testing.md、gotchas.md。
> 范围边界：M1b 只做「球壳 + 隐私总开关接线」；不做图谱画布与迷你相关面板的内容（M2 / M4）、不做剪贴板 / URL 信号（M4）、不做数据清除通道（M5）。
> 本版依据三轮审查（PR #17）修订：暂停语义、持久化红线、E2E 注入、退出路径、IPC 权限面、多屏与窗口几何。v0.1 → v0.2 逐条差异见 §10。

## 0. 目标与验收

**做什么**：常驻贴边的悬浮球（收起 / 悬停 / 拖动 / 暂停态视觉）+ `Alt+P` 隐私总开关接线 + 开关状态持久化 + 最小托盘入口。

**出口标准**（技术方案 §7 M1b 行具体化为可复现验收）：

| # | 验收项 | 方法 |
| - | - | - |
| B1 | 球常驻贴边 | 启动后球出现在屏幕边缘（默认右侧、垂直居中）：不抢焦点、不进任务栏、不挡正常操作 |
| B2 | 悬停 / 拖动 | 悬停轻微放大（「我在」）；可拖动并吸附回边缘；位置重启后恢复；多屏 / 缩放不越界；拔屏后球回到主屏可见区 |
| B3 | 暂停/运行视觉可辨 | 运行 = 常态半透明；暂停 = 灰暗 + 斜杠图标；**首次启动、无任何设置与无显式交互时为暂停态**（A3 延续）；**「已暂停」只能在采集闸关闭后显示**（§4.4） |
| B4 | `Alt+P` 全链路 | 运行中按下 → 闸立即关闭（新帧不再入队、在途结果不再写库）、停屏幕流 / 调度 / OCR、落盘 stats、球切暂停视觉；再按恢复；视觉切换 ≤ 200ms 且不依赖流释放；热键被占用时有可见反馈 |
| B5 | 状态持久化 | 用户显式开启/暂停写 `capture.enabled`；重启按 Q1 结论恢复；无设置键时仍为暂停；**`capture.enabled` 只表示当前运行态，不表示下次启动的授权**（§4.7） |
| B6 | 测试闸门 | `npm test` 全绿 + `npm run typecheck` 通过；新增球位置 / 控制器状态机 / halt / 热键单测 + 1–2 条 E2E（球可见、`Alt+P` 视觉切换、时间线回归）；**E2E 不得启动真实录屏与真实 OCR**（§3 Phase 2） |
| B7 | 真机手工清单 | 贴边 / 多屏 / DPI 缩放 / 拖动吸附 / 暂停恢复 / 退出重启 / **双开** 各过一遍，结果回写本节 |
| B8 | 退出与单实例 | 托盘（或球右键）可退出且退出前等在途队列落地；重复启动只产生一个实例，不会出现第二个球或第二份采集 |

## 1. 前置约束（M1b 期间有效）

- **默认暂停，显式开启**（security.md 三条硬前提）：首次安装（无 settings 键）必须为暂停；只有用户显式操作（`Alt+P` / 托盘 / 球）才写 `capture.enabled=1`。**v0.2 不改写这条**；只有当 Q1 明确批准「重启恢复」时，才同步改写 security.md 并在 decisions.md 留痕（§4.7）。
- **不上全局键鼠钩子**（security.md）：只用 Electron `globalShortcut` 注册 `Alt+P`，不引 keyspy / iohook 类依赖。注意：全局注册会抢占其他应用的 `Alt+P` 菜单助记键，属已知副作用，需在 Q5 旁告知拍板人。
- **暂停不碰数据**：只停采集链路，不删库、不清 events；数据清除通道属 M5。
- M1a 既有纪律不变：本地数据不出网、日志只记元数据、测试只用合成数据、`npm test` + typecheck 硬闸门。
- **A3 口径（本版明确，待 Q8 确认）**：A3 = 空 userData、无启动参数、无用户交互时，不截图、不 OCR、不建库、不写日志。M1b 起球位置偏好存 `userData/ball.json`，**仅在用户拖动/吸附后惰性写入**，且只含边缘/比例/display_id，不含任何采集内容。因此「空 userData 零磁盘写入」的取证口径收窄为「无显式交互时零磁盘写入」；空 userData 直接启动不会生成 `ball.json`。

## 2. 目录与文件落点

```
src/
├─ main/
│  ├─ index.ts              # 入口：单实例锁 / 装配球窗口 / 托盘 / 热键 / 采集控制器
│  ├─ capture-controller.ts # 从 startCapture 拆出：start() / stop() / status() / toggle()，Promise + 串行
│  ├─ ball.ts               # 悬浮球窗口：创建、贴边与拖动吸附（位置计算为纯函数）、显隐、命中检测通道
│  ├─ hotkeys.ts            # Alt+P 注册/注销 + 失败上报（注入 globalShortcut，可单测）
│  └─ tray.ts               # 托盘图标 + 最小菜单（打开时间线 / 暂停·恢复 / 退出）
├─ renderer/
│  ├─ ball/                 # ball.html / ball.ts / ball.css：圆形、悬停放大、暂停态、指针命中检测
│  ├─ ball-preload.ts       # 球专用 preload：状态订阅 / toggle / 指针进出通道（最小权限）
│  ├─ preload.ts            # 时间线只读查询（M1b 不追加采集开关 API）
│  └─ index.html / main.ts  # 现有时间线窗口（M1b 点击球的落地页）
├─ db/ ...                  # 既有
└─ capture/
   ├─ pipeline.ts           # 新增 halt()：闸 + 丢弃在途结果 + 清队列并删帧
   └─ queue.ts              # 新增 drainAll()：取空队列（供 halt 删帧）
tests/
├─ unit/ball-position.test.ts       # 贴边吸附、多屏 clamp、display_id 回退、比例位置（纯函数）
├─ unit/capture-controller.test.ts  # start/stop 幂等、并发串行、start 失败回滚、stop 后无 tick
├─ unit/pipeline-halt.test.ts       # 闸关后：在途 OCR 不写库、队列清空、临时帧删除
├─ unit/hotkeys.test.ts             # 注册失败/成功、切换调用（假 globalShortcut）
└─ e2e/ball.spec.ts                 # 球可见 + Alt+P 切换视觉 + 事件数不增长 + 时间线仍可用（假控制器）
```

- `electron.vite.config.ts`：preload 增加 `ball` 入口，renderer 增加 `ball` 入口（现有单 preload 共用会导致时间线页面也能调用采集开关）。
- settings 键（`settings` 表，不建新表）：仅 `capture.enabled`（`0/1`，缺省 = 0 暂停）；若 Q1=B 再增 `capture.resume_on_start`（缺省 0）。**球位置不进 SQLite**（见 §4.7）。

## 3. 阶段拆分（每 Phase 独立验收，各一支短命分支）

### Phase 0 · 采集控制器重构（约 1–1.5 天）

- 把 `main/index.ts` 里的 `startCapture` 拆成 `CaptureController`：`start()` / `stop()` / `toggle()` / `status()`；scheduler、屏幕流、stats flusher、连接生命周期都由它管。
- **契约（写死，不留「幂等」一句）**：
  - `start()` / `stop()` 返回 `Promise<void>`；内部以单一 Promise 链串行，同一时刻只允许一个转换在途；对同向重复调用返回同一个在途 Promise。
  - `start()` 失败必须回滚：停 scheduler、`dispose()` 屏幕流、关掉本次打开的连接、`log` 记错因，状态回落 `paused`；不得留下半开的采集窗口或临时目录。
  - `stop()` 的完成条件：闸已关（同步）→ 在途 OCR 已返回并丢弃 → 队列已空 → stats 已落盘 → 屏幕流已 dispose。屏幕流释放允许异步，但不阻塞视觉切换（§4.4）。
  - `status()` 返回 `paused | starting | running | stopping`，供球与托盘渲染。
- 管线改造：`CapturePipeline.halt()` 置闸；`tick()` 在 `getActiveWindow` 后、`captureWindow` 前，以及入队前检查闸，命中则删帧返回；`process()` 在 `insertEvent` 前检查闸，命中则计数 `queue_dropped` 并删帧；`OcrQueue.drainAll()` 一次取空，逐条删帧后计数 `queue_dropped`。
- 连接策略：一旦开启过采集，写连接保持到退出（时间线复用同一连接）；若此前只读打开过（`openTimelineDb`），`start()` 必须先 `close()` 再 `openDatabase()`，禁止双连接与 WAL 句柄残留。
- M1a 启动路径保留：`--capture` / `GOTCHA_CAPTURE=1` 仍可直开（只调试用，不写 settings，也不写 `ball.json`）。
- **测试**：重复 `start/stop` 幂等；并发 `start()+stop()` 串行且终态确定；start 失败回滚；`stop()` 后 scheduler 不再 tick；**假 OCR 延迟到 stop 之后 resolve → events 表不新增、`userData/tmp` 无残留帧**；停时 stats 落盘。
- **验收**：`npm run dev:capture` 行为与 M1a 一致；`npm test` + typecheck 绿。

### Phase 1 · 球窗口与视觉（约 2–2.5 天）

- 窗口：`frame: false` / `transparent: true` / `alwaysOnTop` / `skipTaskbar` / `hasShadow: false` / `resizable: false` / `show: false` 后 `showInactive()`（不抢焦点）。尺寸 **64×64**（球直径 48 + 悬停 `scale(1.08)` 到 51.8 + 阴影余量），避免放大被裁；球体视觉仍按 Q2 的 48px。
- 鼠标穿透：**不是区域级 API**。窗口默认 `setIgnoreMouseEvents(true, { forward: true })`，renderer 靠转发的指针事件做命中检测（到圆心距离 ≤ 半径即「在球上」），进入圆内 → IPC 通知主进程 `setIgnoreMouseEvents(false)`，离开 → 恢复 `true`。该 IPC 只接受球窗口 sender。
- 拖动：`pointerdown` 拖动 → 主进程节流 `setPosition`（约 16ms）→ 松手吸附最近边缘；位置写 `userData/ball.json`（`tmp` + rename 原子写；只在拖动/吸附后写，不写采集内容）。
- 点击（未拖动）→ 打开/聚焦现有时间线窗口（Q3）。
- 位置计算抽成纯函数（`ball.ts`）：默认右边缘垂直居中、贴边 6px；clamp 用 `workArea`（避开任务栏）；`ball.display_id` 找不到时**回退主屏**并记日志；监听 `display-added` / `display-removed` / `display-metrics-changed` 重新吸附。
- **单实例**：`app.requestSingleInstanceLock()`，未拿到即 `app.quit()`；`second-instance` 只把已有实例的时间线窗口打开/聚焦，不新建球、不重启采集。
- **退出入口（Q4）**：托盘为必选（打开时间线 / 暂停·恢复 / 退出）；球右键菜单同样提供「退出」，作为托盘不可用时的兜底。退出前 `await pipeline.flush()`（3s 超时后放弃并记 warn），避免在途事件丢失与临时帧残留。
- **测试**：纯函数单测（贴边 / 越界 / 负坐标 / 缩放 / 缺失 display_id）；单实例逻辑用假锁单测。
- **验收**：真机可见球、悬停放大、拖动吸附、重启位置恢复、拔屏回主屏、双开只起一个、可退出。

### Phase 2 · 隐私总开关 + Alt+P（约 1.5–2 天）

- `hotkeys.ts`：`globalShortcut.register('Alt+P', toggle)`；注册失败返回 false → 日志 + 球上「热键未生效」角标；退出时 `unregisterAll`。
- **单一 toggle 入口**：热键 / 托盘 / 球点击共用 `controller.toggle()`；暂停与恢复是**非对称**的：
  - 暂停 = 同步 `halt()`（关闸、清队列、删帧）→ 立即切灰暗/斜杠 → 异步停 scheduler → 异步 `dispose()` 屏幕流 → stats 落盘。视觉不等流释放。
  - 恢复 = `await start()` 成功后才切亮；起流失败保持暂停视觉并在球上提示，**不得出现「已运行但没在采」**。
- 写库：只有用户显式操作写 `capture.enabled`；`--capture` / `GOTCHA_CAPTURE=1` 不写。
- 启动态：无 `capture.enabled` 键 → 暂停（A3）；`=1` → 按 Q1 结论；若 Q1=B 批准自动恢复，启动后延迟 3s 并给可见提示（球脉冲 + 托盘气泡），给用户取消窗口。
- 托盘（Q4 已改必选）：打开时间线 / 暂停·恢复 / 退出；图标用 `nativeImage` 内联 PNG，不新增依赖。
- **preload 与 IPC**：新增 `ball-preload.ts`，只暴露 `onStatus` / `toggle` / `setPointerInside`；主进程对所有 `ball:*` handler 校验 `event.sender.id === ballWindow?.webContents.id`。时间线 preload **不追加**采集开关 API。
- **测试**：hotkeys 注册失败分支；暂停态 toggle 不启动采集；E2E 用假控制器注入——`GOTCHA_FAKE_CAPTURE=1` **且** `GOTCHA_USER_DATA` 存在时才生效，`app.isPackaged` 时忽略该变量，E2E 断言 toggle 后球视觉切换且 events 行数不变；时间线回归。
- **验收**：`Alt+P` 运行↔暂停，`settings` 值正确，屏幕流释放（无采集窗口活跃），时间线在暂停态仍可打开，E2E 全程无真实录屏。

### Phase 3 · 验收与收口（约 0.5–1 天）

- 跑 B1–B8 真机清单（含双开、拔屏、退出），结果回写 §0。
- 文档同步：workflow §8 M1b 行改 ✅、AGENTS.md 阶段行、security.md 采集开关表述（**仅 Q1=B 时**）、decisions 新拍板留痕、gotchas 新坑、本方案归档至 `docs/archive/`。

## 4. 关键设计决策（方案内定，有异议请标出）

1. **球与采集同进程**（技术方案 §3.1）：球只展示状态与开关入口，不直接碰管线；状态经主进程 IPC 单向广播。
2. **点击落地页**：M1b 点击球 = 打开现有时间线窗口（「查看」的出口）；图谱 / 迷你面板 M2 再接（Q3）。M1b 不做 M2 的占位功能，避免伪实现。
3. **拖动不用 `-webkit-app-region: drag`**：它无法区分点击与落点；用 pointer 事件 + 节流 `setPosition`，松手吸附，位置以「边缘 + 比例」存，适应分辨率变化。
4. **暂停语义：先关闸、后切视觉**（v0.2 改写，替代 v0.1「视觉先切、采集异步停」）：
   - 为什么改：`scheduler.stop()` 只置位清定时器，在途 tick 仍会截帧入队；`pipeline.drain()` 无闸会继续 `insertEvent`。若视觉先切，会出现「球已显示暂停、events 仍在增长」，违背技术方案 §6.1「暂停与运行不可混淆」。
   - 顺序（`stop()` 内部）：① 同步 `halt()`（置闸，同步，微秒级）→ ② 切暂停视觉 → ③ `scheduler.stop()` → ④ 异步 `dispose()` 屏幕流 → ⑤ `statsFlusher.flush()`。视觉在 ② 完成，总耗时远低于 200ms，不依赖流释放。
   - 已知取舍：暂停瞬间在途的一次 OCR 结果被丢弃（计入 `queue_dropped`），不写库；恢复不补采。
   - 验收断言：`stop()` 返回后 events 行数不再增长；`userData/tmp` 无该批次残留帧。
5. **热键只接 `Alt+P`**：`Alt+Space`（技术方案 §6.1 展开图谱）M1b 不注册（系统窗口菜单键冲突风险，Q5），M2 图谱落地时再定。已知副作用：全局 `Alt+P` 会吞掉其他应用的 `Alt+P` 助记键，需拍板人知情。
6. **复用 `createDailyStatsFlusher`**：暂停 / 恢复不另起 stats 逻辑，避免跨午夜修复在 M1b 回退；暂停丢弃的帧复用 `queue_dropped` 计数，不新增 stats 字段（避免 settings 内 JSON 结构漂移）。
7. **持久化边界**（v0.2 改写）：两个概念分开——`capture.enabled` = 当前运行态；`capture.resume_on_start`（若 Q1=B）= 下次启动的显式授权，缺省 0。球位置**不进 settings 表**：暂停态的时间线连接是只读的，且空 userData 建库违反 A3，故位置写 `userData/ball.json`，惰性写入。
8. **单实例**：采集与球都是进程级资源，双开会产生两个 scheduler、两个写连接（SQLite 争锁）与重复 events，故在创建任何窗口前加锁。
9. **权限面分离**：球与时间线各自 preload，且主进程校验 sender；最小权限不是「少写几行」，而是「球打不开时间线、时间线打不开采集」。
10. **球不进截图**（待验证）：球常驻置顶会叠在活动窗口上，按窗口 bounds 截屏会把它一起截进去，污染 OCR 与帧差。Phase 1 真机验证 `ballWindow.setContentProtection(true)`（Windows 走 WDA_EXCLUDEFROMCAPTURE）是否可用且不影响可见性；不可用则退到「截图前隐藏球 1 帧」的备选，并在 §6 记结论。

## 5. 依赖报备

无新增运行时依赖：`globalShortcut` / `Tray` / `screen` / `nativeImage` / `app.requestSingleInstanceLock` 均为 Electron 内置；球体视觉纯 CSS。若后续引入动画 / 托盘资源库，再单独报备。

## 6. 风险与对策

| 风险 | 对策 |
| - | - |
| 透明窗口鼠标穿透 / 悬停丢失 | 窗口默认穿透并 `forward: true`，renderer 命中检测后开关穿透（§3 Phase 1）；窗 64px > 球 48px×1.08，避免悬停被裁；真机在 Win11 缩放 / 多屏下验 |
| 多屏 / DPI 坐标漂移 | 位置存 `display_id` + 边缘比例，clamp 用 `workArea`；监听 `display-*` 事件；缺失 display_id 回退主屏；单测覆盖越界与负坐标 |
| `Alt+P` 被其他应用占用 / 抢占助记键 | `register` 返回 false → 球上角标 + 日志；托盘菜单提供同一开关入口；助记键副作用在 Q5 旁告知拍板人 |
| 重构采集生命周期引入 M1a 回归 | Phase 0 只搬移不改语义、保留 `--capture` 旧启动路径；跑 M1a 单测 + 65s 真机冒烟 |
| E2E 真的启动录屏 / OCR | 假控制器注入，且只在 `GOTCHA_USER_DATA` 存在、非打包态生效；E2E 断言 events 行数不变（§3 Phase 2） |
| 「默认暂停」被持久化悄悄破坏 | 两键分离：`capture.enabled` 只记当前态；空 settings 单测断言不启动采集；B3 手工清单检查首启视觉；security.md 措辞仅在 Q1=B 时改 |
| 球挡窗口 / 抢焦点 | `focusable: false` 需真机确认不影响拖动与 hover；`skipTaskbar` + `show: false` 后 `showInactive()`；点击只在拖动结束时生效 |
| 退出时丢在途事件 / 残留临时帧 | 退出前 `await pipeline.flush()`（3s 超时）；`halt()` 清队列时逐条删帧；B8 手工验证 |
| 双开导致重复采集 | `requestSingleInstanceLock()`；`second-instance` 只聚焦已有实例，不新建窗口 |
| 球被自己录进截图 | `setContentProtection(true)` 真机验证（§4.10）；不可用则截图前临时隐藏球并补 1 帧延迟 |
| 只读连接与写连接并存 | 开启采集时先 `close()` 时间线连接再 `openDatabase()`；单测覆盖「先浏览后开启」路径 |

## 7. 工期与提交计划

- 总量 **6–8 个工作日**（v0.1 的 5–7 未计 halt 与控制器契约，已按审查意见上调）：P0 1–1.5 / P1 2–2.5 / P2 1.5–2 / P3 0.5–1 / 缓冲 0.5–1。
- 分支（workflow §3.1）：`feat/m1b-p0-controller`、`feat/m1b-p1-ball`、`feat/m1b-p2-switch`、`feat/m1b-p3-acceptance`，每 Phase PR squash 合入。
- 代码与文档同一次提交；M1b 收口时本方案归档至 `docs/archive/m1b-plan.md`。

## 8. 待拍板清单（显式批准制）

> **沉默 ≠ 批准**（decisions.md「拍板人与授权载体」）。下表「建议方案」仅供拍板人参考，不构成默认授权。

| # | 问题 | 建议方案 | 阻塞 | 状态 |
| - | - | - | - | - |
| Q1 | 采集开关持久化语义：重启恢复上次开启态，还是每次启动都回到暂停？ | **建议 A：M1b 不引入自动恢复**（每次启动暂停），与 security.md 现有措辞一致、无需改红线；B 方案（持久化 `capture.resume_on_start`，重启恢复）需要：书面批准 + decisions.md 留痕 + security.md 同步改写 + 启动延迟 3s 与可见提示 | Phase 2 | 待批（A/B 二选一） |
| Q2 | 球体形态与默认位置：直径 / 贴边距离 / 默认边缘 / 是否记忆多屏位置？ | 球直径 48px（窗口 64px）、贴边 6px、屏幕右边缘垂直居中、半透明；位置存 `userData/ball.json`（`edge` + `offset_ratio` + `display_id`），缺失 display_id 回退主屏 | Phase 1 | 待批 |
| Q3 | M1b 点击球的行为：打开现有时间线窗口，还是先做「迷你面板」占位？ | 打开时间线窗口（M2 图谱落地后替换），不做占位伪功能 | Phase 1 | 待批 |
| Q4 | 托盘是否纳入 M1b？ | **改为必选**：球常驻后 `window-all-closed` 不再适用，没有退出入口就是硬缺陷；托盘用内置 `Tray`，不新增依赖，同时作为热键失效的兜底；球右键菜单提供同一出口 | Phase 1 | 待批 |
| Q5 | `Alt+Space`（展开图谱）是否 M1b 注册？ | 不注册（与系统窗口菜单键冲突），M2 再定；同时知会：`Alt+P` 全局注册会抢占其他应用的该助记键 | — | 待批（不阻塞开工） |
| Q6 | 暂停时是否关闭屏幕流释放资源？ | 关闭，恢复时重建；但**视觉切换不等流释放**（§4.4），<200ms 目标由同步闸保证 | Phase 2 | 待批 |
| Q7 | 「隐私暂停」范围：M1b 只停采集，还是表述为全链路静默（M2 起含归纳队列 / LLM）？ | 定位为全链路总开关，M1b 实现=停采集，文档写明 M2 起扩展口径 | Phase 2 | 待批 |
| Q8 | A3 取证口径：球位置写 `userData/ball.json`（仅拖动后惰性写入）是否接受？ | 接受，并在 m1a A3 记录旁注明口径收窄（无显式交互时零磁盘写入）；若拒绝，则球位置不持久化（Q2 降级为「默认右边缘居中，每次启动重置」） | Phase 1 | 待批 |

## 9. 本版合并条件（给复审者的验收口）

v0.2 可以合并为 M1b 事实源，需同时满足：

1. Q1 / Q2 / Q4 / Q8 有书面结论（或明确「按建议」），并在 decisions.md 留痕。
2. §4.4 的停止顺序与验收断言无歧义，§4.7 的两键语义不被解释成自动恢复。
3. 球位置不再依赖 SQLite；`ball-preload` 与 sender 校验写进 §3 Phase 2。
4. E2E 方案不启动真实录屏与真实 OCR。
5. 退出路径与单实例写进 Phase 1 验收（B8）。

## 10. v0.1 → v0.2 变更记录

| # | 位置 | 变更 | 依据 |
| - | - | - | - |
| 1 | §4.4 / B4 | 「视觉先切、采集异步停」→「先关闸、后切视觉」；新增 `halt()`、队列清空、临时帧删除、在途结果丢弃；补「stop 时 OCR 在途」用例 | 三轮审查 P0-1 |
| 2 | §4.7 / Q1 / B5 | 拆成两键（`capture.enabled` 当前态 / `capture.resume_on_start` 启动授权）；security.md 改写降为 Q1=B 的选项后果；Q1 改为 A/B 二选一并建议 A | 三轮审查 P0-2；decisions.md「沉默 ≠ 批准」 |
| 3 | §2 / §4.7 | `ball.*` 移出 settings 表，改 `userData/ball.json` 惰性写入 | 204326c0（A3 与只读连接冲突） |
| 4 | §3 Phase 2 / §6 / B6 | E2E 假控制器注入（仅 `GOTCHA_USER_DATA` + 非打包态）；独立 `ball-preload` + sender 校验 | e88be049 / e460d29c / 204326c0 |
| 5 | §3 Phase 0 / §4.7 | 控制器 `start/stop` 返 Promise、串行化、失败回滚、stop 完成条件、只读→写连接切换 | e88be049 / e460d29c |
| 6 | §3 Phase 1 / B8 | 退出入口提前到 Phase 1；Q4 改必选；`second-instance` 语义；退出前 `await flush()` | e460d29c / 204326c0 / 本次补充 |
| 7 | §3 Phase 1 / §6 | 窗口 64px（球 48 + 悬停 1.08）；命中检测 + 穿透开关通道（替代「仅球体外区域」） | e88be049 / 204326c0 |
| 8 | §3 Phase 1 / Q2 | 多屏运行期事件、`workArea`、display_id 缺失回退主屏 | e88be049 / 204326c0 |
| 9 | §1 / Q8 | 新增 A3 取证口径说明（惰性写 `ball.json`） | 本次补充（v0.1 未覆盖） |
| 10 | §3 Phase 1 / §4.10 / §6 | 新增单实例锁、球不进截图（`setContentProtection` 待验证） | 本次补充（三轮审查均未覆盖） |
| 11 | §6 / §7 | 修正「不 `show()` 前激活」措辞为 `showInactive()`；工期 5–7 → 6–8 天 | e460d29c / 本次 |
