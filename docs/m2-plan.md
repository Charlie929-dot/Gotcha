# M2 知识行为图谱 · 实施方案（v0.2）

> 状态：**已获书面拍板（2026-10-23）**，本文件作为 M2 事实源，收口时归档至 `docs/archive/m2-plan.md`。Q1–Q8 结论见 §8，留痕 decisions.md D17–D23。
> v0.1 → v0.2：按拍板结论修订——Q4 改为注册 `Alt+Space` 且热键可配置 + 冲突检测；Q6 改为多供应商 / 自定义 OpenAI 兼容供应商配置；Q7 改为归纳参数全部可调（不写死）；补 Phase 2 设置面板与快捷键管理。
> 上游依据：技术方案 §3 / §4 / §5.1 / §6.2 / §7（M2 行）/ §7.1；策划案 §6 模块二、§8.2、§9（V0.5）；decisions D5 / D8 / D10 / D12 / D14；security.md、testing.md、workflow.md、gotchas.md。
> 范围边界：M2 只做「L1 知识/行为节点 + 带权边 + sigma.js 力导向画布 + 点击节点看原始记录」。**不做**：L2+ 日/周/月归纳与完整 LOD 语义（M3）、解说五区块（M4）、主动弱提示（M4）、数据清理/导出/Obsidian（M5）、embedding 与向量检索（M3）、本地模型（二期）。
> 修订轨迹：v0.1 初稿（2026-10-23）。
> **2026-10-23 图谱重做（superseded）**：§0 C3/C4、§3 Phase 2、§5 图谱依赖与 §8 Q5 已被 `docs/m2-graph-redesign.md` 取代；D8 / D17 / D20 / D23 / D25 归档至 `docs/archive/graph-decisions.md`。归纳（§3 Phase 1）、隐私、供应商、设置部分仍有效。
> **2026-10-23 归纳按天（D28）**：手动归纳只处理图谱当前查看日，自动归纳只处理今天；取批按本地日 + 节点 `source_events` 去重，旧 `graph.cursor_*` 仅保留兼容、不再驱动归纳。§3 / §0 中「游标续跑」的旧描述按本条修订。

## 0. 目标与验收

**做什么**：把已采集的 L0 事件流交给云端 DeepSeek（出云前统一脱敏）归纳成 L1「知识 / 行为」节点与带权边，写入本地 SQLite；在独立图谱窗口用 sigma.js + Graphology 力导向画布展示；点击节点可看到它由哪些原始事件聚成，并跳回时间线。

**出口标准**（技术方案 §7 M2 行「图谱上能看到一天内的知识点与行为连线，可缩放平移」具体化为可复现验收）：

| # | 验收项 | 方法 |
| - | - | - |
| C1 | 出云底座与数据契约 | schema v2 迁移（`nodes` / `edges` + 索引，up/down/幂等）；统一出云函数 `buildCloudPayload` 是唯一出口；DeepSeek 客户端（超时 / 重试 / 用量记账）可注入假实现；单测全程零真实网络 |
| C2 | 归纳正确性 | 一批事件 → 严格 JSON → 校验通过才落库；每个节点 `source_events` ⊆ 本批事件且可解析回事件行；非法 JSON / 超时 / 429 时**游标不推进**、不写半成品 |
| C3 | 一天内的图 | 选定一个有采集数据的日子，归纳出 ≥1 个知识节点与 ≥1 条权重边；图谱窗口可滚轮缩放、拖拽平移、悬停高亮邻域 |
| C4 | 下钻回溯 | 点击节点 → 侧栏列出其成员事件（时间 / 应用 / 标题 / OCR 摘要 80 字）；「在时间线中查看」跳到该节点所在日期；节点↔事件全链路可溯（D7 / 风险表「LLM 编造」对策） |
| C5 | 隐私 | 出云请求体断言不含敏感原文（golden 用例）；`sensitive=1` 事件按 Q3 结论处理；日志只有事件 id / 批大小 / 耗时 / token / 错误码，无 OCR 原文与 prompt/response 原文；API key 不落库、不落日志、不进提交 |
| C6 | 总开关联动 | 暂停期间不归纳、不出网、在途请求 abort 且结果丢弃；恢复后从游标续跑、不重复落库；暂停态图谱页仍可浏览已有数据 |
| C7 | 测试闸门 | `npm test` 全绿 + `npm run typecheck` 通过 + `npm run test:e2e` 通过 + `npm run build` 通过；E2E 不启动真实录屏 / OCR / 网络（假采集 + 假 LLM） |
| C8 | 真机验收与成本 | 拍板人真机确认 C1–C4；真实调用一天的 token 与成本回写技术方案 §7.1；方案归档 `docs/archive/`；M1b 全量 E2E 无回归 |

**验收记录**：

- 2026-10-23 拍板补充（D24/D25）：真实出云须先一次性确认（`graph.outbound_consent=1`）；C3/C4 增加实用找回验收——3 个回忆问题 ≥2 题在 90 秒内靠图谱 + 下钻找回来源，`source_events` 100% 可解析回事件行。C1–C8 真机结果仍待 Phase 3 回写。
- Phase 2a（2026-10-23）：主进程归纳接线（确认门 / 暂停联动 / 供应商状态）、只读图谱查询、`hotkey.*` 注册表与设置校验、图谱窗口壳 + `graph:*` IPC 已落地。
- Phase 2b（2026-10-23）：sigma 力导向画布（懒加载）、悬停邻域高亮、节点侧栏下钻、时间线定位、设置抽屉（归纳 / 供应商 / 快捷键 / 确认门）已落地；E2E 假采集 + 假 LLM 覆盖画布、下钻、设置与暂停零请求。

## 1. 前置约束（M2 期间有效）

- **出云唯一出口**（security.md）：所有送 DeepSeek 的文本必须经过同一个函数（`src/understand/cloud/redact.ts`），业务代码不得直接 `fetch`；M2 是该边界第一次落地，新增脱敏规则要配 golden 用例（testing.md）。
- **只发必要字段**：事件 id、时间、应用名、窗口标题、截断后的 OCR 摘要；不发截图、路径、完整 OCR 原文、批外事件。
- **D14 在本方案结案**：M1b 的隐私暂停只承诺停采集；归纳/出云是否受同一总开关约束，由 Q2 拍板（建议：受约束）。
- **默认暂停延续**：归纳只在采集运行期间自动执行；采集暂停时图谱页只读浏览。无 API key 时归纳整体停用，图谱页给出明确空状态，**不静默降级、不阻塞采集与时间线**。
- **本地优先**：节点/边/游标全部落本地 SQLite；`events` 表不因归纳而删除或改写（`intent_json` 的补齐 M2 不做，归 M3）。
- **日志红线**：只记时间、模块、事件 id、批大小、耗时、token 数、错误码；不记 OCR 原文、prompt、response 正文。
- **不上全局键鼠钩子**；不新增除 §5 之外的依赖；所有测试只用合成数据。
- **量级实测**（本机真实 userData，只读核对 2026-10-23）：`events` 共 3727 条；10-21 有 1566 次 OCR；10-22 有 21566 帧 / 3591 次 OCR；10-23 截至 12:54 有 140 次 OCR。按「同应用+同标题合并时刻」后单日约数百条送入 LLM，图谱节点规模数百，远低于 sigma.js 万级设计上限。
- **成本估算（估算，待 Phase 3 实测校准）**：按官方定价页（2026-10 核对，`deepseek-flash`：输入缓存未命中 空闲 1 元 / 高峰 2 元每百万 token，输出 空闲 4 元 / 高峰 8 元每百万 token），3591 事件/日合并 + OCR 截断 200 字后约 0.1–0.2M 输入 token/日，估算 **¥0.5–2/日**；以当日账单为准回写技术方案 §7.1。

## 2. 目录与文件落点

```
src/
├─ understand/
│  ├─ cloud/
│  │  ├─ redact.ts          # 出云唯一出口：字段裁剪 / 截断 / sensitive 剥离 / 二次校验
│  │  ├─ llm-client.ts      # 客户端契约 completeJson() + 假实现（测试 / E2E）
│  │  ├─ providers.ts       # 多供应商配置：预设 + 自定义 OpenAI 兼容（baseUrl / model / 密钥来源）
│  │  ├─ env-file.ts        # userData/.env 手写解析（KEY=VALUE，不引 dotenv）
│  │  └─ deepseek.ts        # OpenAI 兼容客户端实现：超时、429/5xx 退避重试、用量提取
│  └─ structure/
│     ├─ schema.ts          # 归纳结果 JSON 契约 + 手写校验器（零依赖）
│     └─ prompt.ts          # system / user prompt 构造（含 schema 示例，满足 JSON Output 要求）
├─ graph/
│  ├─ batch.ts              # 取批：游标、时间窗、同应用+标题合并、敏感分流、批量上限
│  ├─ induction.ts          # 归纳作业：脱敏 → LLM → 校验 → 事务落库 → 推进游标
│  ├─ repository.ts         # nodes / edges 读写：合并去重、source_events 解析、游标
│  ├─ query.ts              # 图谱查询：时间窗、节点/边 DTO、六色与尺寸映射输入
│  └─ service.ts            # 主进程调度：定时、暂停联动、退避、手动触发、用量记账
├─ db/
│  ├─ schema.ts             # v2 DDL：nodes / edges + 索引
│  └─ migrations.ts         # v2 迁移（up / down）
├─ main/
│  ├─ graph-window.ts       # 图谱窗口（单例、lazy 创建、关闭即销毁）
│  ├─ hotkeys.ts            # 热键注册重构：可配置 + 冲突检测 + 失败提示 + 重新注册（D20）
│  └─ index.ts              # 接线：IPC、toggle 联动、退出收口
└─ renderer/
   ├─ graph/
   │  ├─ graph.html / graph.css
   │  ├─ graph.ts           # sigma 初始化、数据加载、交互接线
   │  ├─ graph-view.ts      # 纯函数：样式映射、邻域高亮、时间窗过滤（可单测）
   │  ├─ graph-panel.ts     # 节点详情侧栏：成员事件 + 跳时间线
   │  └─ graph-settings.ts  # 设置抽屉：归纳参数 / 供应商与模型 / 快捷键（D21/D22）
   └─ graph-preload.ts      # 最小权限：查询 / 状态订阅 / 手动归纳 / 设置读写 / 热键重绑
tests/
├─ unit/redact.test.ts / structure-schema.test.ts / batch.test.ts / induction.test.ts /
│       graph-repository.test.ts / graph-query.test.ts / graph-view.test.ts /
│       graph-service.test.ts / providers.test.ts / hotkeys-config.test.ts（+ migrations / timeline 既有用例扩展）
└─ e2e/graph.spec.ts
```

- **schema v2**（按技术方案 §4 原文，不改字段名）：`nodes(id, level, type, title, summary, ts_start, ts_end, source_events, meta_json)`、`edges(id, src, dst, weight, kind, evidence)`；索引 `idx_nodes_ts_start`、`idx_nodes_level`、`idx_edges_src`、`idx_edges_dst`。不新增表（`node_events` 之类不建，`source_events` 用 `json_each` 解析）。
- **settings 键**（不建新表，全部有默认值、可在图谱窗口设置抽屉里调整，D22）：
  - 归纳：`graph.cursor_ts` / `graph.cursor_id`（游标，内部维护）、`graph.auto`（`1` 默认 = 采集运行中自动归纳）、`graph.interval_minutes`（默认 `10`）、`graph.budget_tokens_per_day`（默认 `1000000`）、`graph.retry_backoff_minutes`（默认 `1,5,15`）、`graph.usage.<yyyy-mm-dd>`（JSON：calls / prompt_tokens / completion_tokens）。
  - 供应商：`llm.active_provider`（默认 `deepseek`）、`llm.providers`（JSON 数组：`{id, label, baseUrl, model, apiKeyEnv}`，默认含 DeepSeek 预设；可加自定义 OpenAI 兼容供应商；设置界面可直接填 API Key 并拉取模型清单，见 D26）。
  - 快捷键：`hotkey.toggle_capture`（默认 `Alt+P`）、`hotkey.open_graph`（默认 `Alt+Space`）；注册失败时提示冲突并引导改键。
- **API key**：只从 `process.env` 或 `userData/.env` 读取（`KEY=VALUE`，手写解析 30 行内，不引 dotenv）；供应商配置里只存环境变量名（`apiKeyEnv`），**密钥不写 settings、不落库、不落日志**；设置界面填写的密钥由主进程写入 `userData/.env`（D26，写后不回显，同名环境变量优先），仓库只提交 `.env.example`（`.env` 已在 `.gitignore`）。模型默认 `deepseek-flash`，base URL 默认 `https://api.deepseek.com`，均可在设置中改（供换供应商/换模型）；「获取模型」按需 `GET {baseUrl}/models` 填充下拉，失败可手填。
- `electron.vite.config.ts`：renderer 增加 `graph` 入口，preload 增加 `graph` 入口；时间线 preload 不追加图谱写接口。

## 3. 阶段拆分（每 Phase 独立验收，各一支短命分支）

### Phase 0 · 出云底座与数据契约（约 1.5–2 天）

- **迁移 v2**：`nodes` / `edges` + 索引；`up` 幂等、`down` 可回滚；回归用例「up → down → up 结构一致」。**文件库在 schema 落后时先自动备份**（`memory.db.bak.<yyyy-MM-dd-HHmmss>`，checkpoint 后整文件复制；备份失败则中止启动，不在无备份时改用户库）。
- **`redact.ts`（唯一出云出口）**：
  - 输入一批事件，输出只含 `{events: [{id, ts, app, title, ocr}]}` 的载荷；`app` / `title` / `ocr` **三个文本字段全部过同一脱敏函数**，分别截断 80 / 120 / 200 字、去空白。
  - `sensitive=1` 事件按 Q3 结论处理：先剥离命中片段替换为 `[已脱敏]`，再二次扫描；仍命中（或命中密码类 drop 规则）则整条不进载荷（`excludedIds`），本地记「内容已保护」占位（Phase 1 生成占位节点）。
  - 产出 `CloudPayload` 带 nominal brand：LLM 客户端只接收该类型，业务代码无法直接拼 messages 绕过脱敏；**单测断言 `JSON.stringify(payload)` 不包含任何 golden 敏感串**。
- **`llm-client.ts` / `deepseek.ts` / `providers.ts`**：契约 `completeJson(payload: CloudPayload, { signal?, maxTokens?, temperature? })`；实现含 AbortController 超时 60s、外部 `AbortSignal` 取消（暂停 D18，取消不重试）、429/5xx/网络错误指数退避重试 2 次（1s / 4s）、4xx（除 429）不重试、JSON 解析失败抛类型化错误；`response_format: {type: 'json_object'}`、`temperature: 0`、`max_tokens: 2000`；`redirect: 'error'` 禁止跟随重定向（避免 Authorization 头被 302 带走）。供应商层按 D21 支持预设 + 自定义 OpenAI 兼容配置（baseUrl / model / apiKeyEnv），**URL 仅 https，本机网关（localhost / 127.0.0.1 / ::1）允许 http；拒绝 URL 内凭据 / query / fragment**；不引 HTTP 依赖（Electron/Node 内置 fetch）。
- **key 载入**：`userData/.env` 解析 + 环境变量回退；只读不落库；缺失 → 返回「未配置」状态，不抛到采集链路。测试覆盖 `.env` 解析（注释/空行/引号/CRLF）、env 回退、多供应商选择；未知供应商 / 非法 providers JSON / 缺密钥都返回明确原因（不静默回退默认供应商，避免数据发往用户以为已替换的远端）。
- **测试**：迁移（含备份）、redact golden（含 app 字段 / 先剥离后截断）、客户端重试/超时/取消/重定向禁用/用量（假 fetch 注入）、供应商解析与 URL 策略、无 key 分支。全程零真实网络。

### Phase 1 · 归纳管线（约 2–3 天）

- **取批 `batch.ts`**：条件 `ts > cursor_ts`（同 ts 用 id 续切）且 `ts <= now - 5min`（留出事件合并窗口）；同一 `app + window_title` 且相邻 ≤90s 的事件合并为一个「时刻」（合并 OCR 摘要去重）；批内最多 20 个时刻；单时刻最多回显 40 个事件 id、单批最多回显 400 个 id（输出必须列举全部 id，超限确定性切分为相邻时刻或留给下一批，游标只推进到已消费事件）；无新事件直接跳过。
- **prompt**：system 定义知识 / 行为两类节点、输出 JSON 契约与硬约束（`event_ids` 必须来自输入、不得编造、标题 ≤24 字、摘要 ≤80 字、权重 0–1、边只连本批节点、覆盖全部输入 id）；user 传时刻 JSON 与时间范围；满足官方 JSON Output「prompt 含 json 字样 + 示例」要求。
- **校验 `structure/schema.ts`**：手写校验器；拒绝未知字段 / 未知 id / id 重复归属 / 权重越界 / 超长文本 / 零节点；首轮非法 → 用错误摘要做 1 次修复重试，仍非法则整批失败、游标不动。
- **落库 `induction.ts`（单事务）**：节点合并规则 = 同本地日 + 同 type + 归一化标题（trim、压缩空白）→ 合并 `source_events`（并集）、扩展 `ts_start/ts_end`、摘要取更长者；否则插入。边按 `(src, dst, kind='ai')` 去重，`weight` 取最大、`evidence` 保留非空；**游标推进与节点/边写入同一事务**。
- **调度 `service.ts`**：采集 `running` 后 5s 首次、之后每 10 分钟一次；同一时刻只允许一个作业在途；失败退避 1m / 5m / 15m（上限 30m）；暂停 → 停定时器 + abort 在途 + 结果丢弃（与 M1b halt 语义一致）；用量写 `graph.usage.<date>`，超 `graph.budget_tokens_per_day` 停自动归纳并在图谱页提示；**失败 / 取消 / 解析失败（空 content / 非法 JSON）批也按响应带回的 usage 记账**（未知用量不伪造精确 0，预算是事后软阈值）。
- **测试**：假客户端返回合法/非法 JSON；暂停 abort 不写库；合并不重复；失败游标不动；预算超限停跑；敏感占位节点生成。

### Phase 2 · 图谱画布（约 2–3 天）

- **依赖**：`sigma@4.0.3` + `graphology@0.26.0` + `graphology-layout-forceatlas2@0.10.1`（均 MIT，见 §5）。renderer 动态 `import()` 懒加载，时间线页不背图谱体积。
- **图谱窗口**（D20）：独立 `BrowserWindow`（1100×800，深色画布），工具栏含日期（今天/前一天/后一天）、刷新、自动归纳开关、立即归纳、设置、状态徽标、打开时间线。
- **热键（D20）**：`hotkeys.ts` 重构为注册表——`hotkey.toggle_capture`（默认 `Alt+P`）+ `hotkey.open_graph`（默认 `Alt+Space`）；启动注册、失败即冲突检测（`globalShortcut.register` 返回 false / `isRegistered`）→ 球角标 + 日志提示，并在图谱设置抽屉里标红该键要求更换；设置保存后立即重注册（先 `unregister` 旧键）；结构预留后续更多可自定义快捷键，不写死两条。
- **设置抽屉 `graph-settings.ts`（D21/D22/D26）**：归纳（自动开关 / 间隔分钟 / 每日 token 预算 / 退避分钟）、供应商（预设 + 自定义 OpenAI 兼容：名称 / baseUrl / API Key / 模型 / 高级变量名；API Key 直接填写写入 `userData/.env`、不回显，「获取模型」拉取 `/models` 填充下拉，失败可手填）、快捷键（两键编辑 + 冲突提示 + 保存重注册）；写 settings（SQLite），密钥永不进库。
- **数据**：IPC `graph:query(from, to)` 走只读连接（与时间线共用），返回节点/边 DTO；`graph:induce-now`、`graph:set-auto` 走主进程并校验 sender。
- **视觉与交互**：六色按技术方案 §6.2（M2 实际只出现知识 `#4FC3F7` / 行为 `#81C784`）；节点尺寸随度数对数增长；**边宽 ∝ weight + ForceAtlas2 `edgeWeightInfluence=1`** 双重编码（D8）；滚轮缩放、拖拽平移、悬停高亮邻域（其余降透明度）、点击节点开侧栏。
- **侧栏 `graph-panel.ts`**：节点标题/摘要/时间范围/成员事件列表（时间、应用、标题、OCR 摘要 80 字、敏感「内容已保护」徽标）；「在时间线中查看」→ 打开/聚焦时间线窗口并定位到该节点日期。
- **空状态**：未配置 key / 自动归纳关闭 / 该日无节点 / 采集中断时「归纳暂停」；均带 `data-kind` 供 E2E 断言。
- **测试**：`graph-view` 纯函数（颜色、尺寸、邻域、时间窗过滤）；热键注册表单测（自定义键、注册失败冲突检测、改键后旧键注销、`unregisterAll` 收口）；设置读写单测（非法值回退默认、密钥不落库断言）；E2E 用合成库（事件 + 节点 + 边）打开图谱、断言节点计数钩子、点击节点后侧栏出现成员事件、跳时间线；假 LLM（`GOTCHA_FAKE_LLM=1` + `GOTCHA_USER_DATA` + 非打包态）跑「立即归纳 → 图谱出现节点」全链路，**无真实网络**。

### Phase 3 · 验收与收口（约 1–1.5 天）

- 拍板人真机跑 C1–C8（真实 key + 有数据的一天），成本与 token 回写技术方案 §7.1；`npm test` / typecheck / `test:e2e` / `build` 全绿。
- 文档同步：workflow §8 M2 行、AGENTS.md 阶段行、security.md（出云规则落地）、decisions（Q1–Q8 结论编号化）、gotchas 新坑；本方案归档 `docs/archive/m2-plan.md`。
- 顺带复核 M1a A1 严格口径：需要「一个 15:00 前后连续工作」的完整采集日；10-22 实测覆盖为 00:00–02:00 与 18:00–23:00（当日 15:00 段无事件），仍不满足，继续挂账、不阻塞 M2。

## 4. 关键设计决策（方案内定，有异议请标出）

1. **出云唯一出口 + 字段最小化**：`redact.ts` 是唯一构造上云载荷的地方；`CloudPayload` 带 nominal brand，LLM 客户端只接收该类型且 prompt 由客户端拼装，业务代码无法注入自由文本（PR #23 审查修复）。测试以「序列化后不含敏感串」为硬断言，而不是只测函数返回值。
2. **JSON Output 契约**：`response_format=json_object`、prompt 含 json 示例、`temperature=0`、`max_tokens=2000`；官方文档提示 JSON 模式可能返回空 content（2026-10 核对），按「空 content = 非法输出」走修复重试，不静默接受。
3. **游标幂等**：以 `(ts, id)` 为游标、只在落库事务内推进；同一批事件重复处理只会合并、不新增重复节点；失败不推进，下一次退避后重试同批。事件不因归纳删除或改写。
4. **节点合并**：同本地日 + 同 type + 归一化标题合并（并集 `source_events`、扩展时间范围、摘要取更长）；跨批的同一主题因此收敛为一个节点，避免图谱被同一话题刷屏。
5. **边**：只在本批节点间生成（`kind='ai'`），跨批相关靠节点合并自然连起来；M2 不做「AI 找历史旧节点连边」，避免无界检索与成本（M3/M4 再议）。
6. **归纳在主进程异步执行，M2 不引 worker**：调用是 IO 密集型、批 ≤20 时刻、JSON 很小，主进程 await 不阻塞 UI；技术方案 §3.1 的「归纳走 worker + 队列」留到 M3 上量后再评估（届时补队列与背压）。
7. **图谱窗口独立 + 可配置热键**（D20）：不改时间线页结构，回归面最小；sigma 懒加载；窗口关闭即销毁。热键走「注册表 + settings」，`Alt+P` / `Alt+Space` 默认值可在设置里改，注册失败做冲突检测并提示更换；球点击默认开图谱，时间线入口保留在工具栏/侧栏。
8. **布局与编码**：ForceAtlas2 布局、权重作吸引强度、线宽另映射 weight（D8「双重编码」）；M2 不做 LOD 完整语义，日期筛选承担「只看某天」。
9. **用量记账**：`graph.usage.<date>` 存 JSON（calls / prompt_tokens / completion_tokens），成本按官方价格常量（可改）在 UI 展示；不新增表，避免 schema 膨胀。
10. **暂停联动**（D18）：暂停 = 采集停 + 归纳停 + 在途 abort；恢复后按游标续跑，不补采、不重复。
11. **供应商抽象**（D21）：`LlmProvider` 只要求 OpenAI 兼容（baseUrl / model / apiKeyEnv），预设 DeepSeek；自定义供应商零代码接入。不直接读取 DSH harness 配置文件——只采用同形配置（多供应商 + 自定义 base URL），避免与宿主隐式耦合和密钥扩散；密钥名存配置、值只放 `.env` / 环境变量。URL 只允许 https（本机网关 localhost/127.0.0.1/::1 允许 http），拒绝 URL 内凭据 / query / fragment，客户端禁止跟随重定向（PR #23 审查修复）。
12. **参数可调**（D22）：间隔、预算、退避、超时、批量上限都有默认值并存 settings，设置抽屉可改；代码不写死数字（默认值集中在一个常量模块，测试引用同一常量）。

## 5. 依赖报备

| 包 | 版本 | 许可 | 用途 | 体积（unpacked） | 备注 |
| - | - | - | - | - | - |
| `sigma` | 4.0.3 | MIT | 2D 力导向图谱渲染（技术方案 §3 已选型） | ~3.4 MB | 仅图谱窗口懒加载 |
| `graphology` | 0.26.0 | MIT | 图数据结构（节点/边/属性） | ~2.7 MB | sigma 的配套数据结构 |
| `graphology-layout-forceatlas2` | 0.10.1 | MIT | 力导向布局 | ~79 KB | 权重作吸引强度 |

- 不新增 HTTP 依赖（Node 内置 fetch）；不引 dotenv（手写 `.env` 解析）；不引图标/图表库。
- 新增依赖仅 3 个、均 MIT、浏览器侧打包，不进主进程运行时依赖。

## 6. 风险与对策

| 风险 | 对策 |
| - | - |
| LLM 编造节点/摘要 | 校验器强制 `event_ids` ⊆ 本批、覆盖全部输入 id；节点必须可下钻；标题/摘要长度上限；无法通过校验就整批失败，不落库 |
| 敏感原文出云 | 唯一出口 + 二次扫描 + golden 断言「序列化后不含敏感串」；无法安全剥离的整条不出云并本地占位 |
| JSON 非法 / 空 content / 超时 | 1 次修复重试 → 失败退避重试；游标不推进；UI 显示「上次归纳失败」而不暴露正文 |
| 限流 / 429 / 网络抖动 | 指数退避（1s/4s），单批上限、单作业在途；失败不影响采集与时间线 |
| 成本失控 | 每日 token 预算（默认 1M）+ 用量记账 + 自动归纳开关；超限停自动归纳并提示 |
| 暂停期间仍出网 | 暂停 → 停定时器 + abort 在途 + 丢弃结果；单测覆盖「暂停中触发的归纳不写库」 |
| 图谱性能 | 单日节点数百、sigma 万级设计；布局在渲染进程；M3 再上 LOD；E2E 只断言计数不测像素 |
| 真实 API 依赖拖慢验收 | 单测/E2E 全用假客户端 + 假 LLM 注入；真实调用只在 C8 手工验收 |
| 时间线/球回归 | 不改时间线页结构（独立图谱窗口）；M1b 19 条 E2E 全量回归 |

## 7. 工期与提交计划

- 总量 **8–10 个工作日**：P0 1.5–2 / P1 2–3 / P2 2.5–3.5（含热键与设置抽屉）/ P3 1–1.5，缓冲 0.5–1。
- 分支（workflow §3.1）：`feat/m2-p0-llm-foundation`、`feat/m2-p1-induction`、`feat/m2-p2-graph-ui`、`feat/m2-p3-acceptance`，每 Phase PR squash 合入；PR 标题 `feat: M2 Phase N ...`。
- 代码与文档同一次提交；M2 收口时本方案归档。

## 8. 待拍板清单（已批结论）

> 拍板人：项目所有者；来源：2026-10-23 对话（M2 方案 v0.1 复审）；留痕：decisions.md D17–D23。下表为**已批结论**，无「待批」项。

| # | 问题 | 结论（2026-10-23 拍板） | 阻塞 | 状态 |
| - | - | - | - | - |
| Q1 | M2 范围边界 | 只做 L1 知识/行为节点 + 边 + 画布 + 下钻；L2 日/周/月与 LOD 完整语义归 M3；解说五区块 / 主动提示归 M4 | Phase 1 | ✅ 已批（D17） |
| Q2 | 隐私暂停是否约束归纳/出云（D14 结案） | **A**：暂停 = 采集停 + 归纳停 + 在途请求 abort 且结果丢弃；恢复后从游标续跑，不补采、不重复（D18 结案 D14 悬置） | Phase 1 | ✅ 已批（D18） |
| Q3 | `sensitive=1` 事件出云策略（D10 落地） | **A**：命中片段替换为 `[已脱敏]` 后可出云；无法安全剥离（含密码类命中）整条不出云，本地生成「内容已保护」占位节点 | Phase 0/1 | ✅ 已批（D19） |
| Q4 | 图谱入口与 `Alt+Space` | **B（拍板人要求）**：独立图谱窗口；球点击默认打开图谱；**注册 `Alt+Space`**；两个热键都可由设置修改，注册失败自动冲突检测并提示更换；结构上支持后续扩展更多自定义快捷键 | Phase 2 | ✅ 已批（D20） |
| Q5 | 新增依赖（sigma / graphology / ForceAtlas2） | 批准：3 个 MIT 依赖，懒加载；技术方案 §3 已选 sigma.js | Phase 2 | ✅ 已批（对话 2026-10-23） |
| Q6 | 模型与密钥 | **多供应商 + 自定义 OpenAI 兼容供应商**（参照 harness 模型配置形态：provider 预设 / 自定义 baseUrl+model）；预设 DeepSeek（`https://api.deepseek.com` + `deepseek-flash`）；供应商配置存 settings，密钥只从环境变量 / `userData/.env` 读，不入库、不入日志；仓库提交 `.env.example` | Phase 0 | ✅ 已批（D21） |
| Q7 | 归纳触发与预算 | 默认按建议（每 10 分钟 / 每日 1M token / 退避 1m·5m·15m），但**参数不写死**：间隔、预算、退避、超时、批量上限均可配置（settings + 设置抽屉） | Phase 1 | ✅ 已批（D22） |
| Q8 | 验收数据与真实调用 | 同意：真实 key + 10-22 有数据的一天跑 C1–C8；成本从拍板人账户扣（估算 ¥0.5–2/日）；结果由拍板人真机确认 | Phase 3 | ✅ 已批（D23） |

## 9. 合并条件核对（v0.2）

1. ✅ Q1–Q8 全部书面拍板，留痕 decisions.md D17–D23。
2. ✅ Q2/Q3 结论已同步改写 security.md（暂停语义 / 出云剥离与占位）。
3. ✅ Q4/Q5/Q6/Q7 结论已写入 §2/§3/§4/§8（独立图谱窗口、热键注册与冲突检测、多供应商配置、参数可调）。
4. ✅ 本文件已更新为 v0.2 并标注拍板日期；无遗留「待批」项。

后续任何改动走 PR + decisions.md 留痕，不直接改本文件结论。

## 10. 变更记录

| # | 位置 | 变更 | 依据 |
| - | - | - | - |
| 1 | 全篇 | v0.1 初稿：范围、C1–C8、Phase 0–3、Q1–Q8 | 技术方案 §7 M2 行 / 策划案 §6 模块二 / 2026-10-23 本机数据核对 |
| 2 | 全篇 | v0.2 拍板落定：Q4=B（注册 Alt+Space + 热键可配置 + 冲突检测，D20）、Q6 多供应商/自定义供应商（D21）、Q7 参数可调（D22）、其余按建议（D17–D19、D23）；Phase 2 增加热键注册表与设置抽屉，工期 7–9 → 8–10 天 | 2026-10-23 对话拍板 |
| 3 | §0 验收 / 决策 | Phase 2 开工前补充 D24（真实出云一次性确认门）与 D25（C3/C4 实用找回验收）；Phase 2 拆 P2a 主进程闭环 / P2b 图谱 UI，P2a 已落地 | 2026-10-23 对话拍板 / 评估稿 §八 |
