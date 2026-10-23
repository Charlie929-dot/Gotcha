# M1a 采集存储底座 · 实施方案

> 状态：✅ **M1a 验收通过并归档（2026-10-22）**。原批准记录：2026-10-21 拍板人批准合入（Q1 本地保留原文、Q2 六项依赖、Q4 分支策略；Q3 延后至 spike 失败时再批）。本方案为 M1a 期间的历史事实源，与代码同次提交演进。
> 上游依据：技术方案 §3/§4/§5.1/§7、workflow.md、testing.md、security.md、decisions.md、gotchas.md。

## 0. 目标与验收

**做什么**：帧差截图 + OCR + 窗口元数据 + SQLite 事件流 + 时间线只读视图 + 有效帧率埋点。

**出口标准**（技术方案 §7，具体化为可复现验收）：

| # | 验收项 | 方法 |
| - | - | - |
| A1 | 回答「昨天下午三点在干嘛」 | 开启采集跑 ≥ 2h 真实使用 → 次日打开时间线，定位 15:00 前后，可见连续事件流：时间 + 应用 + 窗口标题 + OCR 摘要 |
| A2 | 采集 CPU 占用 < 3% | 采集运行时 `Get-Process` 采样 5 分钟均值（技术方案 §8 基线） |
| A3 | 默认暂停红线 | 不带启动参数启动 → 无任何截图/OCR/写库行为（进程网络与磁盘写入可证） |
| A4 | 测试闸门 | `npm test` 全绿 + `npm run typecheck` 通过，输出附在交付说明 |
| A5 | 有效帧率埋点 | settings 中可查到当日统计：总帧数 / 帧差通过数 / OCR 执行数 / 队列丢弃数 |

**验收记录（2026-10-21 采集/A2/A3/A4/A5，2026-10-22 A1 回看）**

| # | 结果 | 证据 |
| - | - | - |
| A1 | ✅ 能力验证（15:00 段样本不足） | 2026-10-22 打开时间线切「前一天（2026-10-21）」：渲染 1572 条，时间 + 应用 + 窗口标题 + OCR 摘要齐全，按日回看能力成立。**但 15:00–16:14 只有 3 条**（15:07 一条、15:43 两条；首日该时段采集未真正工作），连续段从 **16:15** 开始（16:15–17:32、21:30–23:59、次日 00:00–01:54）。严格「15:00 前后连续」未达成：10-22 未开机、15:00 无数据；按拍板人 2026-10-22「继续」指示以能力验证收口，严格口径待补完整一天 |
| A2 | ✅（5 分钟法） | 两次 5 分钟采样：**1.58%**（Electron 1.28% + OCR 0.29%；17:14–17:19，窗口内 12 次帧变化）与 **1.24%**（0.70% + 0.54%；17:20–17:25），8 逻辑核口径。**口径提醒**：同一运行时累计 23.2 分钟（含启动）均值 **3.63%**；屏幕持续变化时 OCR 0.6–1.2s/帧，最坏约 5%。报数必须带窗口内变化次数，不能只报均值 |
| A3 | ✅ | 空 userData + 无 `--capture` 启动：仅 index.html 一个窗口；未生成 `memory.db`、无 `logs/`；时间线显示「这一天还没有记录」 |
| A4 | ✅ | `npm test` 60 通过（12 文件）、`npx playwright test` 4 通过、`npm run typecheck`、`npm run build` 全绿（PR #13） |
| A5 | ✅ | settings `stats.day.2026-10-21` = `{frames_total:2745, frames_same:2166, ocr_runs:578, queue_dropped:0, capture_errors:1}`（17:25 落盘点）；日志最长行 152 字符、OCR 原文 grep 0 命中。**已知缺陷（2026-10-22 已修）**：跨午夜时新 key 继承旧 key 累计（见 gotchas「stats 跨午夜归属漂移」；`fix/stats-midnight-rollover` 修复并补跨日回归用例） |

> A2 出现「5 分钟法达标、含启动累计 3.63%」的口径差异，原因与采样注意事项见 gotchas.md「A2 CPU 采样受屏幕变化频率影响」。
>
> **口径旁注（2026-10-22，M1b 起）**：A3 的「磁盘零写入」取证口径收窄为「**无显式用户交互时零磁盘写入**」。M1b 起球位置偏好写 `userData/ball.json`，仅在用户拖动/吸附后惰性写入，不含任何采集内容、不建库、不写日志；A3 原始验收结论（✅）不变。依据见 decisions.md D13 与 `docs/archive/m1b-plan.md` §4.7。

## 1. 前置约束（摘录自规范，M1a 期间有效）

- **默认暂停，显式开启**（security.md 三条硬前提）。M1a 开启途径：启动参数 `--capture`（见 §4.6），**不持久化**——每次启动回到暂停，M1b 接 UI 总开关后才写 settings。
- **默认只存 OCR 文本，截图可选**（decisions.md 立项决策）：`shot_path` 默认空；settings 键 `capture.save_shots`（默认 `0`）开启后存 `userData/shots/`，保留策略见 §4.5。
- **三层脱敏墙**（security.md）：M1a 实现第 1 层（正则标记 `sensitive=1`）+ 第 2 层黑名单进程（只记元数据）；第 2 层「密码输入框 → 整帧丢弃」以 OCR 文本特征词简化实现（见 §4.4）。第 3 层占位展示 M1a 不涉及（无节点）。
- **本地数据不出网**：M1a 全程无任何网络请求；DeepSeek 出云是 M2。
- **日志纪律**（workflow.md §4）：只记时间、模块、事件 id、窗口元数据、错误码；不记 OCR 原文、页面内容、剪贴板文本。
- **M1 不上全局键鼠钩子**（security.md / gotchas.md）。
- **测试只用合成数据**；真实截图/OCR 临时产物进 `.tmp/`（gitignore，跑完清理）。

## 2. 目录与文件落点（M1 定稿，完成后回写 workflow.md §4）

```
src/
├─ main/
│  └─ index.ts            # Electron 入口：窗口生命周期、启动参数解析、采集装配
├─ capture/
│  ├─ scheduler.ts        # 2s 采样调度（注入时钟）
│  ├─ screen.ts           # 窗口 bounds → 视频帧裁剪区（纯几何，可单测）
│  ├─ screen-stream.ts    # 隐藏采集窗口常驻 getDisplayMedia 屏幕流（避开 getSources 阻塞主线程）
│  ├─ frame-diff.ts       # dHash 8x8 + 汉明距离阈值
│  ├─ window-meta.ts      # active-win：title / 进程名 / 应用路径
│  ├─ ocr/
│  │  ├─ engine.ts        # OcrEngine 接口（留 RapidOCR 替换点）
│  │  └── winrt-bridge.ts # WinRT OCR 实现（worker 内）
│  └─ queue.ts            # OCR 任务队列：上限 + 背压（丢帧计数）
├─ understand/
│  └─ sanitize.ts         # 第 1 层正则 + 第 2 层黑名单/密码词（golden 用例）
├─ db/
│  ├─ index.ts            # 打开库 / 跑迁移 / 导出实例
│  ├─ schema.ts           # v1：events + settings（nodes/edges 由 M2 迁移添加）
│  └─ migrations.ts       # 版本表 + 幂等 + 回滚
└─ renderer/
   ├─ timeline/           # M1a 只读时间线（无 sigma.js，M2 才上）
   └─ preload.ts
tests/
├─ unit/                  # dHash / sanitize / migrations / scheduler / 查询逻辑
└─ e2e/                   # Playwright Electron 冒烟（合成数据注入）
```

- 库文件：`userData/memory.db`（Electron `app.getPath('userData')`，security.md 暂定名）；测试用 `:memory:`。
- 埋点不建新表（四张表冻结，decisions/技术方案 §4）：写 settings 键 `stats.day.<yyyy-mm-dd>`，JSON 值。

## 3. 阶段拆分（每步独立验收，逐次提交）

### Phase 0 · 脚手架（约 0.5 天）

- package.json（scripts：`dev` / `test` / `typecheck` / `build`）、tsconfig、electron-vite 三端配置。
- `src/main/index.ts` 最小入口：开一个隐藏主窗口（M1a 无常驻 UI，时间线是 dev 工具窗口）；解析启动参数。
- vitest 就位，**至少 1 条真实行为断言，禁止空用例凑闸门**（testing.md「空用例不构成验证」）：断言不带启动参数时采集保持默认暂停（A3 的最小前置），或配置加载默认值正确。`npm test` + `npm run typecheck` 闸门从本 Phase 起生效。
- `.gitignore` 补：`node_modules/`、`.tmp/`、`dist/`、`*.db`。
- **验收**：三命令全绿；`npm run dev` 能起进程无报错退出。

### Phase 1 · SQLite 底座（约 1 天）

- migrations：`schema_version` 表 + 迁移数组（`v1: 建 events + settings`，字段按技术方案 §4 原文）；每个迁移带 up/down，重复执行幂等。
- db/index：打开 → 迁移 → 导出；WAL 模式（采集高频小写入）。
- events 写入/查询 API：`insertEvent`、`queryTimeline(from, to)`（时间线数据源）。
- **测试**：`:memory:` 库迁移幂等（跑两次）、down 后重 up 结构一致、timeline 查询边界（空区间/跨天）。
- **验收**：单测绿；`npm run dev:capture`（Phase 0 未带 `--capture-dryrun`，`electron-vite dev --capture` 会被 CLI 误解析，见 gotchas）控制台可见 `db 就绪（schema v1）`，`userData/memory.db` 生成且 WAL 生效。
- **状态**：✅ 完成（2026-10-21，`feat/m1a-p1-sqlite`）：14 条单测绿、typecheck 绿、dev 冒烟通过；`--capture-dryrun` 语义留待 Phase 2 管线落地时定义。

### Phase 2 · 采集管线（约 2–3 天，含技术验证）

- **2a · WinRT OCR spike（最先做，半天盒装）**：验证 Node 侧调 `Windows.Media.Ocr` 的路径。候选顺序：① 长驻 PowerShell 子进程（stdin/stdout JSON 协议，喂 base64 图）② koffi 直调 WinRT API。验收线：单张 1080p 截图 OCR 往返 ≤ 1.5s、中文可识别。两路都不达标 → 上报拍板人评估 RapidOCR 提前（原定二期）。**结论回写本节 + gotchas.md**。
- **2a 结论（2026-10-21，候选① 通过，②不再验证）**：长驻 `powershell.exe`（5.1，非 pwsh 7）跑 WinRT `Windows.Media.Ocr`，行式 JSON 协议（`resources/ocr/winrt-ocr.ps1`）。1920×1080 合成中文图实测：长驻稳态往返 **40–59ms（中位 43ms）**，冷启动首帧 170ms；每次新起进程 563–633ms（也达标但开销大）。中文可识别；WinRT 按字分词，CJK 之间会插空格（原样入库，M2 归纳时再处理）。
- **2b · 帧差与元数据**：dHash 8x8（灰度降采样 → 每行比较 → 64bit）、汉明距离阈值（初值 8，settings `capture.diff_threshold` 可调）；active-win 取前台窗口；隐藏窗口常驻 `getDisplayMedia` 屏幕流 → 按显示器裁窗口区域 → **OCR 输入放大 2×（上限 3840 宽，`src/capture/ocr-scaling.ts`）**。不用「每次 `desktopCapturer.getSources`」：本机实测单次 1.2–2.3s 且阻塞主进程（gotchas.md）。
- **2c · 管线串联**：scheduler（注入时钟，2s tick）→ 截屏 → 帧差未变 → 丢（计 `frames_total/frames_same`）→ 变 → 黑名单进程？只记元数据 : OCR（worker + 队列，上限 50，满则丢最新并计 `queue_dropped`）→ 正则脱敏标记 → insertEvent。
- **2d · 日志**：electron-log，文件落 `userData/logs/`；语句仅含 id/模块/元数据/错误码。
- **测试**：dHash 合成图（同图距离 0 / 微改距离小 / 换图距离大）、sanitize golden 用例（密钥/JWT/手机/身份证/卡/邮箱/IP/URL query + 密码词整帧丢弃 + 黑名单只记元数据）、scheduler 用固定时钟断言 tick 与暂停语义、队列背压。
- **验收**：`npm run dev -- --capture` 真机跑 30 分钟：events 表有数据、无 OCR 原文进日志、CPU 目测 < 3%（正式测量在 A2）。
- **状态**：✅ 完成（2026-10-22 收口；含真机缺陷修复 2026-10-21，`feat/m1a-p2-capture` + `fix/m1a-framediff-dims` + `feat/m1a-ocr-upscale` + `fix/m1a-input-lag`）：帧差/脱敏/队列/调度/截屏窗口裁剪/active-win/OCR 桥/埋点全部落地，60 条单测 + 4 条 E2E + typecheck + build 绿。**真机 30 分钟首轮验收发现帧差永不触发**（`dHash` 用了 OCR 图尺寸套 90x80 灰度，指纹恒同 → 34 分钟仅 1 条事件），已修复（指纹改由截图层按灰度尺寸算 + `dHash` 对缓冲区不足抛错 + 回归用例），隔离环境复测 30 秒 5–8 条事件且应用/标题随窗口切换正确。**同步把 OCR 输入从「≤1280 降采样」改为「2× 放大（上限 3840）」**：对照实验同一张真实截图关键词命中 11/15 → 15/15，真机验证落图尺寸确为 2×（3238×2058 / 2880×1480），单帧 OCR 99–371ms。**又修复采集模式下时间线输入冻结**：`desktopCapturer.getSources()` 本机单次 1.2–2.3s 且同步阻塞主进程 → 改隐藏窗口常驻屏幕流（`screen-stream.ts` + `renderer/capture-window.ts`），真机 12s 采样主进程 IPC 往返 max 5ms / p95 2ms，事件与 OCR 正常；同时补暗色模式按钮 hover 规则。**M1a 验收通过（2026-10-21 采集/A2/A3/A4/A5，2026-10-22 A1 回看）**：A2 两次 5 分钟法 1.58% / 1.24%、A3/A4/A5 通过；A1 以「昨天 16:15 起连续段」能力验证通过（15:00 段样本不足，见 §0）。30 分钟连续运行无崩溃。

### Phase 3 · 时间线视图 + 埋点（约 1–1.5 天）

- 时间线只读视图（renderer，无图谱）：按日分组列表，行 = 时间 · 应用 · 窗口标题 · OCR 摘要（截 80 字）；顶部日期切换 + 跳转当前时刻。
- 埋点：scheduler 内计数器，每日一 settings 键（见 §2），`stats.day.<date>` 累加写回。
- Playwright 冒烟 E2E：预置合成 events（固定时间戳）→ 启动 → 时间线渲染出对应行。
- **验收**：A1/A2/A5 按上表逐条过；M1a 收口：workflow.md §8 进度表更新、gotchas 补 OCR spike 结论、decisions 若有新拍板（如 OCR 实现路径）追加。
- **状态**：✅ 代码完成（2026-10-21，`feat/m1a-p3-timeline`）：时间线只读视图（按日分组、时间/应用/标题/OCR 摘要 80 字、前/后一天/今天）、preload IPC 只读查询（暂停模式用只读连接，不建库）、Playwright Electron 冒烟 2 用例（合成 events + 日期切换/空态）全绿；43 条单测 + typecheck + build 绿。**M1a 收口（2026-10-22）**：A1–A5 全部过（A1 为能力验证，口径见 §0）；workflow §8 已改 ✅、本方案已归档至 `docs/archive/`。

## 4. 关键设计决策（方案内定，有异议请标出）

1. **表分批建**：v1 只建 `events` + `settings`；`nodes`/`edges` 由 M2 迁移 v2 添加——「schema 变更必须写迁移」的第一次实践，避免空表漂移。
2. **OCR 文本先标记后剥离**：正则命中 → `sensitive=1`，M1a **本地保留原文**（本地数据不出网，剥离反而破坏「忠实还原」）；M2 出云前才剥离。**已拍板（2026-10-21）：本地保留原文**（decisions.md D10）；如需翻案走 decisions.md 规则并补 golden 用例。
3. **密码框检测简化**：OCR 文本命中特征词（`密码/password/passwd/PIN`）→ 整帧丢弃（不 OCR 入库）。视觉级检测（IME/DOM 级）超出 M1a 范围。
4. **队列上限 50、丢最新**：OCR 积压说明机器忙，保采集轻量优先；丢弃计数进埋点，供 M2 校准。
5. **截图保留**：`capture.save_shots=1` 时存 `userData/shots/`，文件名 `<event_id>.jpg`，7 天滚动清理（启动时扫）；默认关。
6. **采集开关**：`--capture` 启动参数（或 `GOTCHA_CAPTURE=1` 环境变量）为 M1a 唯一开启途径；不持久化，重启即回暂停态。M1b 接 Alt+P + UI 总开关后改为 settings 持久化（届时更新 security.md 表述）。
7. **时间线不是图谱**：纯 DOM 列表，不引 sigma.js（M2 范围），避免依赖提前。

## 5. 依赖报备（workflow.md §4 要求，需拍板）

| 依赖 | 用途 | 为何不用别的 | 许可/体积/风险 |
| - | - | - | - |
| electron | 外壳（技术方案 §3 定案） | — | MIT；~100MB dev 依赖 |
| electron-vite | 主/preload/renderer 三端构建 + 热重载 | 手写 tsc+html 配置维护成本高；vite 生态成熟 | MIT；dev 依赖 |
| better-sqlite3 | 存储（§3 定案） | — | MIT；**原生模块**：锁 13.0.3（≥13 已 N-API 化，Node/Electron 共用 prebuilds，2026-10-21 实测无需 rebuild） |
| active-win | 前台窗口元数据（§3 定案） | — | MIT；小 |
| electron-log | 文件日志（纪律要求日志可追溯） | console 无落盘；自写轮转不值当 | MIT；小 |
| vitest / playwright | 测试（testing.md 定案） | — | MIT；playwright 需下 Electron 二进制 |
| koffi | 备选：直调 WinRT（仅 spike 2a 用） | — | MIT；仅当 PowerShell 桥不达标才保留 |

无出网运行时依赖；`DEEPSEEK_API_KEY` M1a 完全不涉及。

## 6. 风险与对策

| 风险 | 对策 |
| - | - |
| WinRT OCR 无成熟 Node 绑定 | Phase 2a 半天盒装 spike，两候选 + RapidOCR 升级路径，结论先报备再动工 |
| better-sqlite3 ABI 不匹配（gotchas 已记） | v13 已 N-API 化，Node/Electron 同一二进制（2026-10-21 验证）；仍锁 13.0.3，升级 Electron 后先跑冒烟 |
| desktopCapturer 拿不到窗口区域（多屏/DPI） | 裁剪失败 fallback 全帧降采样；DPI 缩放用 `scaleFactor` 换算，spike 一并验 |
| 真实管线无法纯自动化测试 | 自动化全合成数据；真机验收走 §0 手工清单，产物进 `.tmp/` |
| 埋点写 settings 高频写放大 | 计数器内存累加，每 60s 或退出时落盘一次 |

## 7. 工期与提交计划

- 总量 **5–7 个工作日**（P0 0.5 / P1 1 / P2 2–3 / P3 1–1.5 / 缓冲 0.5–1），对齐技术方案 §7 的 1–1.5 周。
- 每 Phase 一次以上提交，均过闸门；按 workflow.md §3.1 Vibe 分支规范：每个 Phase 一支短命分支（`feat/m1a-p0-scaffold`、`feat/m1a-p1-sqlite`…），PR squash 合入即清；同 Phase 内想试险招（如 OCR 桥接两种候选）拉 `vibe/` 分支验证。
- M1a 收口（✅ 2026-10-22）：workflow.md §8 进度表已改 M1a ✅、本方案已归档至 `docs/archive/`。

## 8. 待拍板清单（显式批准制）

> **沉默 ≠ 批准**（decisions.md「拍板人与授权载体」）：下表「建议方案」仅供拍板人参考，**不构成默认授权**。任一 Q 未记录明确批准前，不得开始其「阻塞」列标注的 Phase；批准记入 decisions.md「拍板记录」表（日期、来源、结论、适用范围）。

| # | 问题 | 建议方案 | 阻塞 | 状态 |
| - | - | - | - | - |
| Q1 | OCR 命中敏感词：本地保留原文只标记（§4.2），还是本地也剥离？ | 保留原文 + `sensitive=1` | Phase 2（sanitize 与入库） | ✅ 已批准（2026-10-21 对话：本地保留原文，→ decisions.md D10） |
| Q2 | 依赖报备（§5 六项） | 全部批准 | **Phase 0 起全部**（脚手架即需 electron / electron-vite / vitest） | ✅ 已批准（2026-10-21 对话：六项全部批准，按 Phase 需要逐项引入，→ decisions.md D11） |
| Q3 | OCR spike 两候选都不达标时，是否允许 RapidOCR 提前到 M1a？ | 允许，但需重新报备体积（onnxruntime ~100MB+） | 不阻塞开工；仅 2a 失败触发时需批 | 待批（可延后） |
| Q4 | M1a 分支策略：按 workflow.md §3.1，每 Phase 一支 `feat/m1a-p<n>-*` 短命分支 | 每 Phase 一支（vibe 规范落地首例） | — | ✅ 已批准（2026-10-21 对话，随 PR #1 规范合入 main） |
| Q5 | 是否改用**云端视觉模型 OCR**（截图出网），替代/前置本地 WinRT OCR？ | 按 `docs/cloud-ocr-vlm-draft.md`：先做形态 A 影子对比，用数据决定是否进形态 B；本地 OCR 保留兜底 | Phase 2 收尾前（影响 A2/A5 口径与 security.md 硬前提） | ✅ 已拍板（2026-10-21：M1a 维持本地 2× OCR，多模态划归 M2 并采用自适应动态频率架构，→ decisions.md D12） |
