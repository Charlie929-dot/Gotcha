# M1b 悬浮球壳 · 实施方案（草案 v0.1）

> 状态：**草案（2026-10-22 起草，待拍板）**。§8 的 Q 未获明确批准前，不进入其「阻塞」列标注的 Phase（decisions.md「拍板人与授权载体」：沉默 ≠ 批准）。
> 上游依据：技术方案 §6.1 / §6.3 / §7（M1b 行）、策划案 §8.1、security.md、workflow.md、testing.md、gotchas.md。
> 范围边界：M1b 只做「球壳 + 隐私总开关接线」；不做图谱画布与迷你相关面板的内容（M2 / M4）、不做剪贴板 / URL 信号（M4）、不做数据清除通道（M5）。

## 0. 目标与验收

**做什么**：常驻贴边的悬浮球（收起 / 悬停 / 拖动 / 暂停态视觉）+ `Alt+P` 隐私总开关接线 + 开关状态持久化 + 最小托盘入口。

**出口标准**（技术方案 §7 M1b 行具体化为可复现验收）：

| # | 验收项 | 方法 |
| - | - | - |
| B1 | 球常驻贴边 | 启动后球出现在屏幕边缘（默认右侧、垂直居中）：不抢焦点、不进任务栏、不挡正常操作 |
| B2 | 悬停 / 拖动 | 悬停轻微放大（「我在」）；可拖动并吸附回边缘；位置重启后恢复；多屏 / 缩放不越界 |
| B3 | 暂停/运行视觉可辨 | 运行 = 常态半透明；暂停 = 灰暗 + 斜杠图标；**首次启动无设置时为暂停态**（A3 红线延续） |
| B4 | `Alt+P` 全链路 | 运行中按下 → 停屏幕流 / 调度 / OCR、落盘 stats、球立即切暂停视觉；再按恢复；热键被占用时有可见反馈 |
| B5 | 状态持久化 | 用户显式开启/暂停写 settings；重启按 Q1 结论恢复；无设置键时仍为暂停 |
| B6 | 测试闸门 | `npm test` 全绿 + `npm run typecheck` 通过；新增球位置 / 状态机 / 采集控制器单测 + 1–2 条 E2E（球可见、`Alt+P` 切换视觉、时间线回归） |
| B7 | 真机手工清单 | 贴边 / 多屏 / DPI 缩放 / 拖动吸附 / 暂停恢复 / 退出重启各过一遍，结果回写本节 |

## 1. 前置约束（M1b 期间有效）

- **默认暂停，显式开启**（security.md 三条硬前提）：首次安装（无 settings 键）必须为暂停；只有用户显式操作（`Alt+P` / 托盘 / 球）才写 `capture.enabled=1`。M1b 起把「显式开启」持久化，需同步 security.md 表述（见 §4.7）。
- **不上全局键鼠钩子**（security.md）：只用 Electron `globalShortcut` 注册 `Alt+P`，不引 keyspy / iohook 类依赖。
- **暂停不碰数据**：只停采集链路，不删库、不清 events；数据清除通道属 M5。
- M1a 既有纪律不变：本地数据不出网、日志只记元数据、测试只用合成数据、`npm test` + typecheck 硬闸门。

## 2. 目录与文件落点

```
src/
├─ main/
│  ├─ index.ts              # 入口：装配球窗口 / 托盘 / 热键 / 采集控制器
│  ├─ capture-controller.ts # 从 startCapture 拆出：start() / stop() / status()，运行时开关
│  ├─ ball.ts               # 悬浮球窗口：创建、贴边与拖动吸附（位置计算为纯函数）、显隐
│  ├─ hotkeys.ts            # Alt+P 注册/注销 + 失败上报（注入 globalShortcut，可单测）
│  └─ tray.ts               # 托盘图标 + 最小菜单（Q4 决定是否纳入）
├─ renderer/
│  ├─ ball/                 # ball.html / ball.ts / ball.css：圆形、悬停放大、暂停态
│  ├─ preload.ts            # 追加 ball API：状态查询、切换开关、拖动位置持久化
│  └─ index.html / main.ts  # 现有时间线窗口（M1b 点击球的落地页）
tests/
├─ unit/ball-position.test.ts      # 贴边吸附、多屏 clamp、比例位置（纯函数）
├─ unit/capture-controller.test.ts # start/stop 幂等、stop 后无 tick、stats 落盘
├─ unit/hotkeys.test.ts            # 注册失败/成功、切换调用（假 globalShortcut）
└─ e2e/ball.spec.ts                # 球可见 + Alt+P 切换视觉 + 时间线仍可用
```

- settings 键（`settings` 表，不建新表）：`capture.enabled`（`0/1`，**缺省 = 0 暂停**）、`ball.edge`（`right` / `left`）、`ball.offset_ratio`（0–1，垂直比例）、`ball.display_id`。

## 3. 阶段拆分（每 Phase 独立验收，各一支短命分支）

### Phase 0 · 采集控制器重构（约 0.5–1 天）

- 把 `main/index.ts` 里的 `startCapture` 拆成 `CaptureController`：`start()` / `stop()` / `status()`；scheduler、屏幕流、stats flusher 生命周期都由它管，重复调用幂等。
- M1a 启动路径保留：`--capture` / `GOTCHA_CAPTURE=1` 仍可直开（只调试用，不写 settings）。
- **测试**：重复 `start/stop` 幂等；`stop()` 后 scheduler 不再 tick；停时 stats 落盘（复用 `createDailyStatsFlusher`）。
- **验收**：`npm run dev:capture` 行为与 M1a 一致；`npm test` + typecheck 绿。

### Phase 1 · 球窗口与视觉（约 1.5–2 天）

- 窗口：`frame: false` / `transparent: true` / `alwaysOnTop` / `skipTaskbar` / `hasShadow: false` / 不可缩放；尺寸约 48–56px 见方（Q2）。
- 视觉：CSS 圆 + 柔和阴影；悬停 `scale(1.08)` + 透明度提升；暂停态灰暗（`#7a7a85` 半透明）+ 斜杠徽标；运行/暂停切换有 120ms 过渡。
- 交互：`pointerdown` 拖动 → 主进程节流 `setPosition`（约 16ms）→ 松手吸附最近边缘并持久化（比例 + display id）；点击（未拖动）→ 打开/聚焦现有时间线窗口（Q3）。
- 位置计算抽成纯函数（`ball.ts` 内或独立模块）：默认右边缘垂直居中、贴边 6px；多屏与 DPI clamp；单测覆盖越界 / 负坐标 / 缩放。
- **验收**：真机可见球、悬停放大、拖动吸附、重启位置恢复；单测绿。

### Phase 2 · 隐私总开关 + Alt+P（约 1–1.5 天）

- `hotkeys.ts`：`globalShortcut.register('Alt+P', toggle)`；注册失败返回 false → 日志 + 球上「热键未生效」角标；退出时 `unregisterAll`。
- 开关语义：暂停 = `controller.stop()` + 球切灰暗/斜杠 + 写 `capture.enabled=0`；恢复 = 反向；**视觉先切、采集异步停**（目标按下 <200ms 有反馈）。
- 暂停时关闭屏幕流释放资源（Q6 结论），恢复时重建；`Alt+P` 与托盘菜单走同一个 toggle handler。
- 启动态：无 `capture.enabled` 键 → 暂停（A3 红线）；=1 → 按 Q1 结论决定是否自动恢复采集。
- 托盘（若 Q4 批准）：打开时间线 / 暂停·恢复 / 退出；图标用 `nativeImage` 内联 PNG，不新增依赖。
- **测试**：hotkeys 注册失败分支；toggle 在暂停态不启动采集；E2E 用 IPC 直调同一 handler 断言球视觉切换（真实热键留给手工清单）。
- **验收**：`Alt+P` 运行↔暂停，`settings` 值正确，屏幕流释放（无采集窗口活跃），时间线在暂停态仍可打开。

### Phase 3 · 验收与收口（约 0.5–1 天）

- 跑 B1–B7 真机清单，结果回写 §0。
- 文档同步：workflow §8 M1b 行改 ✅、AGENTS.md 阶段行、security.md 采集开关表述、decisions 新拍板留痕、gotchas 新坑、本方案归档至 `docs/archive/`。

## 4. 关键设计决策（方案内定，有异议请标出）

1. **球与采集同进程**（技术方案 §3.1）：球只展示状态与开关入口，不直接碰管线；状态经主进程 IPC 单向广播。
2. **点击落地页**：M1b 点击球 = 打开现有时间线窗口（「查看」的出口）；图谱 / 迷你面板 M2 再接（Q3）。M1b 不做 M2 的占位功能，避免伪实现。
3. **拖动不用 `-webkit-app-region: drag`**：它无法区分点击与落点；用 pointer 事件 + 节流 `setPosition`，松手吸附，位置以「边缘 + 比例」存，适应分辨率变化。
4. **暂停先切视觉**：UI 立即反馈，采集在后台停（日志留痕），避免「按了没反应」的信任裂缝。
5. **热键只接 `Alt+P`**：`Alt+Space`（技术方案 §6.1 展开图谱）M1b 不注册（系统窗口菜单键冲突风险，Q5），M2 图谱落地时再定。
6. **复用 `createDailyStatsFlusher`**：暂停 / 恢复不另起 stats 逻辑，避免跨午夜修复在 M1b 回退。
7. **持久化边界**：`capture.enabled` 只由用户显式操作写入；`--capture` / `GOTCHA_CAPTURE=1` 不写 settings，且不改变「无键 = 暂停」的默认。security.md 硬前提同步改写为「默认暂停 + 显式开启且用户选择持久化」。

## 5. 依赖报备

无新增运行时依赖：`globalShortcut` / `Tray` / `screen` / `nativeImage` 均为 Electron 内置；球体视觉纯 CSS。若后续引入动画 / 托盘资源库，再单独报备。

## 6. 风险与对策

| 风险 | 对策 |
| - | - |
| 透明窗口鼠标穿透 / 悬停丢失 | 仅球体外区域 `setIgnoreMouseEvents(true, { forward: true })`；球体保持可交互；真机在 Win11 缩放 / 多屏下验 |
| 多屏 / DPI 坐标漂移 | 位置存 `display.id` + 边缘比例，`screen.getAllDisplays()` clamp；单测覆盖越界与负坐标 |
| `Alt+P` 被其他应用占用 | `register` 返回 false → 球上角标 + 日志；托盘菜单提供同一开关入口 |
| 重构采集生命周期引入 M1a 回归 | Phase 0 只搬移不改语义、保留旧启动路径；跑 M1a 单测 + 65s 真机冒烟 |
| 真实热键无法在 E2E 验 | 开关 handler 与热键注册解耦：E2E 走 IPC 触发同一 handler，热键注册用假 `globalShortcut` 单测 |
| 「默认暂停」被持久化悄悄破坏 | 空 settings 单测断言不启动采集；B3 手工清单检查首启视觉；security.md 措辞同步 |
| 球挡窗口 / 抢焦点 | `focusable: false` + `skipTaskbar` + 不 `show()` 前激活；点击只在拖动结束时生效 |

## 7. 工期与提交计划

- 总量 **5–7 个工作日**（对齐技术方案 §7 的 1–1.5 周）：P0 0.5–1 / P1 1.5–2 / P2 1–1.5 / P3 0.5–1 / 缓冲 0.5–1。
- 分支（workflow §3.1）：`feat/m1b-p0-controller`、`feat/m1b-p1-ball`、`feat/m1b-p2-switch`、`feat/m1b-p3-acceptance`，每 Phase PR squash 合入。
- 代码与文档同一次提交；M1b 收口时本方案归档至 `docs/archive/m1b-plan.md`。

## 8. 待拍板清单（显式批准制）

> **沉默 ≠ 批准**（decisions.md「拍板人与授权载体」）。下表「建议方案」仅供拍板人参考，不构成默认授权。

| # | 问题 | 建议方案 | 阻塞 | 状态 |
| - | - | - | - | - |
| Q1 | 采集开关持久化语义：重启恢复上次开启态，还是每次启动都回到暂停？ | 持久化 `capture.enabled`；**首次无键 = 暂停**（仍满足「默认暂停」：默认=未显式开启），重启恢复用户上次选择 | Phase 2 | 待批 |
| Q2 | 球体形态与默认位置：直径 / 贴边距离 / 默认边缘与垂直位置 / 是否记忆多屏位置？ | 直径 48px、贴边 6px、屏幕右边缘垂直居中、半透明；按 `display.id` + 垂直比例记忆 | Phase 1 | 待批 |
| Q3 | M1b 点击球的行为：打开现有时间线窗口，还是先做「迷你面板」占位？ | 打开时间线窗口（M2 图谱落地后替换），不做占位伪功能 | Phase 1 | 待批 |
| Q4 | 托盘是否纳入 M1b？ | 纳入最小托盘（打开时间线 / 暂停·恢复 / 退出），作为热键失效时的兜底退出入口 | Phase 2/3 | 待批 |
| Q5 | `Alt+Space`（展开图谱）是否 M1b 注册？ | 不注册（与系统窗口菜单键冲突），M2 再定 | — | 待批（不阻塞开工） |
| Q6 | 暂停时是否关闭屏幕流释放资源？ | 关闭，恢复时重建；要求视觉 <200ms、采集异步停 | Phase 2 | 待批 |
| Q7 | 「隐私暂停」范围：M1b 只停采集，还是表述为全链路静默（M2 起含归纳队列 / LLM）？ | 定位为全链路总开关，M1b 实现=停采集，文档写明 M2 起扩展口径 | Phase 2 | 待批 |
