# 整体架构（2026-10-29 快照）

> **用途**：一张图看清「记忆球现在是什么」，以及 `llm-call` 方案（v0.3，设计稿）加在哪。
> **事实源**：以代码为准（`src/**`、`package.json`、`electron.vite.config.ts`）；设计口径以
> `docs/agent/llm-call.md` 为准。本文与 git 实况冲突时以 git 为准，并回来改本文。
> **标记**：🟢 已实现 · 🧊 冻结 · 📝 设计稿（未实现） · 推测 / 未验证会单独标出。

---

## 1. 一句话

现状是**一条五段管道**：采集 → 证据 → 派生 → 检索 → 工具循环问答；旁边并行**第二本账**（日记记忆），
以及一套**已冻结**的旧「时刻—主题」图谱。

方案（`llm-call` v0.3）不改这条管道，而是在它**顶端**加一个「本体层」：
记忆是本体，LLM 是它的一次调用，工具是眼睛和手；再配一个调度器，让它按记忆里的时间自己醒来。

---

## 2. 分层图

```text
┌─ 系统层 ─────────────────────────────────────────────────────┐
│ 全局键鼠钩子 / 前台窗口 / UIA / Windows.Graphics.Capture / OCR │
└───────────────┬──────────────────────────────────────────────┘
                │ native addons: chain_hook / screen_grab
┌─ 采集层 ───────▼──────────────────────────────────────────────┐
│ 事件源 → 段机(确认窗/幽灵窗过滤) → 记录器                       │
│ 截图触发(3 规则) → chain_shot    内容(UIA→OCR) → chain_content  │
│ 旧管线(2s 帧差 + OCR) → events（并行，镜像/兜底）               │
└───────────────┬──────────────────────────────────────────────┘
                │ SQLite: memory.db（单库，多本账）
┌─ 派生层 ───────▼──────────────────────────────────────────────┐
│ 段向量 512d(bge) / 标签 / 双链 / chain_derive 水位              │
│ 保留期分层 hot→warm→cold→archive（归档容器 + 幂等清扫）         │
└───────────────┬──────────────────────────────────────────────┘
┌─ 检索层 ───────▼──────────────────────────────────────────────┐
│ 关键词(LIKE on text_norm) + 段向量余弦 + 时间/应用/标签/双链过滤 │
│ → RRF(k=60) 融合；跑在 utilityProcess(search-worker)，失败回主线程│
└───────────────┬──────────────────────────────────────────────┘
┌─ 代理层 ───────▼──────────────────────────────────────────────┐
│ askChain：门槛(空/同意/预算/客户端) → 工具循环(8 轮/16 调用/     │
│ 暂停续查) → 白名单解析 → 6 种结果形状                           │
└───────────────┬──────────────────────────────────────────────┘
┌─ 出口层 ───────▼──────────────────────────────────────────────┐
│ AskOutbound 端口（脱敏墙）→ 同意门 + 日预算 + 用量记账           │
└───────────────┬──────────────────────────────────────────────┘
┌─ 界面层 ───────▼──────────────────────────────────────────────┐
│ 球 / 右键菜单 / 选区问答浮层 / 问记忆窗口(含设置抽屉)            │
└──────────────────────────────────────────────────────────────┘

并行：日记 vault（仓库外）→ mem_items / mem_sources / mem_observations / mem_deleted
      召回 = 关键词打分，**没有向量**；写入 = 📝 未实现
```

---

## 3. 进程与模块地图

| 宿主 | 内容 | 入口 / 关键文件 |
| - | - | - |
| Electron 主进程 | 组合根、窗口与 IPC、采集编排、出云策略注入、设置 | `src/main/index.ts`、`src/main/ask-ipc.ts`、`src/main/graph-ipc.ts` |
| renderer（9 个页面入口） | 球、球右键菜单、问记忆、选区浮层、选区遮罩、图谱（全局/经典）、时间线、隐藏采集页 | `src/renderer/{ball,ball-menu,ask,ask-popup,region,graph,}/` |
| preload ×7 | 每窗口一份最小 API（`gotchaAsk` 等） | `src/renderer/*-preload.ts` |
| utilityProcess ×2 | 向量推理（onnxruntime）、检索 LIKE 全扫 | `src/main/embedding-host.ts`、`src/main/search-host.ts` |
| 原生 addon ×2 | `chain_hook`（键鼠/前台/`windowAtPoint`）、`screen_grab`（WGC 抓帧 + 置顶） | `native/chain-hook/`、`native/screen-grab/` |
| 外部进程 | `uia-text.ps1` 读 UIA 文本；Obsidian CLI（📝 仅方案） | `resources/chain/uia-text.ps1` |
| 构建 | 主进程 3 入口、preload 7 入口、renderer 9 页面 | `electron.vite.config.ts` |

**支撑面**：`tests/unit` 133 个文件、`tests/e2e` 9 个规格；`fake-llm` / `fake-embedding` / `fake-capture`
三条假实现通道（`src/main/fake-*.ts`），是离线验收与 E2E 的底座。

**重活不进主线程**：向量（95 MB 模型、onnxruntime）与检索（40 MB 正文全扫 ~1 s+）都在
`utilityProcess`；主进程只做编排。新功能照此办理（`docs/agent/cloud-boundary.md` §6 第 8 条）。

---

## 4. 数据层：三本账

单库 `memory.db`（`app.getPath('userData')`），三套表互不干扰：

| 账本 | 表 | 版本 | 谁写 | 状态 |
| - | - | - | - | - |
| 屏幕记忆（信息链） | `chain_segment` / `chain_event` / `chain_shot` / `chain_content` / `chain_tag` / `chain_link` / `chain_link_segment` / `chain_vector` / `chain_derive` + `chain_meta` | chain **v4** | 采集 / 派生 | 🟢 |
| 旧图谱 | `events`(+`events_fts`) / `nodes` / `edges` / `moments` / `theme_moments` / `node_embeddings` / `event_embeddings` / `theme_centroids` / `node_merges` / `node_positions` | db v1–v7 | 旧管线 | 🧊 冻结（D38） |
| 个人记忆（日记） | `mem_items` / `mem_sources` / `mem_observations` / `mem_deleted` | db v8–v9 | 同步 / 设置抽屉 | 🟢 |

### 4.1 关键约定

- **信息链有独立版本号** `chain_meta.schema_version` + `CHAIN_MIGRATIONS`。改任何 `chain_*` DDL 必须
  ① 版本 +1、② 补迁移，否则老库静默缺列（`no column named`）。建表幂等，索引与触发器在迁移**之后**建。
- **证据层只 INSERT**（段行先插后收口 UPDATE 一次）；**派生层可整表重建**（标签/双链/向量/水位）。
- **`mem_items` 的事实源是日记 Markdown**，表是可重建索引；同步按 `mtime+size` 跳过、
  按 uid 增量、删除进 `mem_deleted` 且被同步跳过（否则删掉的条目下次同步自己回来）。
- **`normalizeOcrSql` 是去空白的唯一口径**（索引侧 / 查询侧 / 迁移回填共用）：WinRT OCR 的中文
  98.9% 是「记 忆 球」逐字空格形态。

### 4.2 文件侧

证据截图按日归档（hot/warm/cold/archive，cold 起进自描述容器）；`ask-shots/` 存选区截图并 30 天清理；
`ask-history.jsonl` 存问答记录与过程 trace；`ball-state.json` 存球的位置/停靠；日志在 userData。
日记 vault 在仓库外，由用户在设置里手填目录。

### 4.3 连接规则（A3 红线）

- 只读连接**惰性打开**；库不存在返回 `null`，**不为了看一眼就建库**。
- 写操作一律 `ensureWritable()`；开写连接会**关掉只读连接**，所以调用顺序必须是
  「先查后写」或「先同步再取 `queryDb()`」（`src/main/index.ts` 的提问路径有注释守着）。
- 记忆条目的删除 / 撤销在**回答进行中一律拒绝**（会关掉正在读的只读连接）；
  其它写操作同样要守住「先读后写 / 先同步再取连接」的时序，不能边读边开写。

---

## 5. 采集链路

### 5.1 双通道

1. **旧管线**（`src/capture/pipeline.ts`）：2s tick → 先取 90×80 dHash → 变了才编码落盘 →
   OCR 队列 → `sanitize` → `events`。支持 `metadataOnly`（只记元数据，正文交给信息链）。
2. **信息链**（`src/main/chain-recording.ts`）：原生钩子给键鼠/前台事实 → 段机切段 →
   记录器落 `chain_segment` / `chain_event`；正文再镜像 4k 字进 `events`
   （`src/main/chain-events.ts`），供旧读路径与 FTS 使用。

### 5.2 四条硬规则（真机事故换来的）

| 规则 | 含义 |
| - | - |
| 单一隐私开关 | 采集总开关只有一处（Alt+P / 托盘 / `--capture`）；信息链生命周期挂在它下面 |
| 段身份 = 你做动作的那扇窗 | 前台事件降级为兜底；点击/滚轮按光标下窗口切段；幽灵窗（不可见 / 0×0 / 任务切换层）不成段 |
| 焦点确认窗 | 切窗先挂起（默认 1.5s），点击/滚轮/停满才确认；回原窗或切第三窗作废 |
| 只拍有证据的点 | 事件退为内部触发与统计原料；时间轴 / 画布只出有截图或内容的点 |

### 5.3 截图与内容

- **只拍三类时刻**：① 从 ≥2s 静默里发起的点击；② 打字被点击/滚轮打断；③ 滚轮停下 2s。
  鼠标移动永不拍，打字自己停顿也不拍。
- 同一帧出两份：证据 JPEG（1920，隐藏渲染进程直接编码）+ 2× PNG 给 OCR 兜底（读完即删）。
- 内容来源：UIA 优先（`uia-text.ps1`）、OCR 兜底；同段 15s 节流；按段 id 异步写回。

### 5.4 保留期

`chain/retention.ts`（纯计划）+ `main/chain-retention.ts`（执行器）：hot = 采集即编码 JPEG q85 原分辨率；
warm / cold / archive 逐级缩小与降质；开采集跑一轮 + 每 6h；先写新 → 事务改行 → 最后删旧；幂等。

---

## 6. 派生与检索

### 6.1 派生（`src/chain/derive/`）

段收口即入队（`onSegmentClosed` 叫醒）→ 串行扫描：先算 **512 维段向量**（模型缺失只关向量），
再在**同意门 + 日预算**下让模型抽 `{tags, links}`；名字 ≥0.95 直接复用、0.90–0.95 问模型、否则新建；
`chain_derive` 记（段, 文本指纹）水位，避免「空结果」被当成待办反复烧 token；
开采集时补最近 200 段，之后每 10 分钟扫一轮。

### 6.2 检索（`src/chain/query.ts`，只读）

三条路：

1. **关键词**：`chain_content.text_norm LIKE`（去空白），只扫最近 `limit×20`（≥200）条命中行；
2. **段向量**：与查询向量余弦，维度不符 / 坏字节计入 `skippedVectors`，不报错；
3. **过滤**：时间 / 日期 / 应用 / 标签名 / 双链名（`nameKey` 归一，双链可用别名）。

两路都有结果 → **RRF（k=60）**；命中带段行、内容 id、snippet，可顺 `getSegmentDetail()`
反查事件 / 截图 / 原文。**不建 FTS**（`chain_content` 单条可达两万字，trigram 约 4× 体积）。

`search_info` 的批量检索走 `search-worker`；worker 起不来 / 超时（20s）回主线程查，
并记一条 `stats.search.day.*` 指标。

---

## 7. 问答代理（`src/chain/agent/`）

### 7.1 一次提问的路径

```text
ask-ipc(ask:query) → askChain
  ├─ 门口判定：空问题 / 同意门(consent) / 日预算(budget) / 客户端解析
  ├─ 主路径：工具循环 loop.ts
  │    ├─ 每轮 system：人设 + 身份 + 纪律 + 当前时间 + 数据边界 + 最近段指代 + 最近 4 轮
  │    ├─ 工具：search_info / get_freshness / ask_history / read_segment
  │    │        recall_diary / read_diary / memory_profile
  │    ├─ 白名单：read_segment 只能展开 search_info 返回过的段
  │    └─ 预算：8 轮工具 / 16 次调用 / 最多 3 次「还要继续吗」
  └─ 回退路径：单发 askOnce（客户端没有循环能力时）
→ parse.ts 按白名单硬剥引用（编造 / 重复整条丢）
→ 结果：answer / clarify / continue-ask / insufficient / no-evidence / error
→ ask-history.jsonl 落盘（含 trace：每轮思考 + 工具摘要）
→ renderer 渲染：回答卡 + 引用段（点开看证据）+ 日记引用卡 + 过程折叠区
```

### 7.2 出云边界（全仓最清晰的一处解耦）

- 核心只认识 `AskTextPolicy` / `AskOutbound`（`src/chain/agent/payload.ts`），**不 import 脱敏实现**；
- 远端策略 `createCloudAskOutbound()`（`src/understand/cloud/ask-outbound.ts`，规则源
  `src/understand/sanitize.ts`）；本机 / 测试策略 `createLocalAskOutbound()`（直通）；
- 组合根决定注入哪个；**同意门 / 日预算 / 记账都在组合根**，核心不知道原因；
- 派生层同样端口化（`DeriveOutbound`）。

### 7.3 「第一次调用」现状

**没有独立的第一次调用。** 每次工具轮都重发同一份大 system（人设 + 纪律 + 时间 + 边界 +
最近对话）；记忆只在**工具结果**里出现，从不在调用前的上下文里。

> 这正是方案 §3 要改的地方。

---

## 8. 界面与生命周期

- **常驻外壳**：球（无边框、置顶、不抢焦点）+ 自绘右键菜单（原生 `Menu.popup` 在非激活窗口收不掉）。
- **入口三处**（D51 封存图谱 / 时间线 UI）：
  - 左键球 → 选区问答：WGC 抓帧 → 遮罩选区 → 裁剪 → 屏幕中下方浮动输入框 → 打开问记忆并预填；
  - 菜单 → 问记忆 / 设置 / 记录开关 / 退出；
  - 二次启动（单实例）→ 打开问记忆。
- **问记忆窗口**是唯一主窗口：多轮对话、引用段证据、日记引用、设置抽屉
  （供应商 / 密钥 / 同意门 / 日额度 / 个人记忆目录 + 人设 / 记忆条目浏览删除撤销）。
- IPC 只认本窗口主框架（`sender.id` + `senderFrame === mainWindow`），参数在边界校验，
  异常变可读结果，不把异常抛回渲染层。
- 首次启动默认**不采集**（隐私红线），只有 `--capture` / `GOTCHA_CAPTURE=1` / 用户手动开；
  任何读路径都不为了「看一眼」建库（A3）。

---

## 9. 冻结区（只修 bug，不加功能）

`src/understand/` 的主题/时刻/归纳/回填/图谱查询（`theme-*`、`moments`、`induction`、`graph-*`）、
`main/` 里对应的 `*-runtime`、`renderer/graph/` 的全局图页 —— 代码与数据全留，UI 入口全部摘除。
新能力写进 `src/chain/`，表结构与不变量以信息链契约为准（AGENTS 第 12 条、D38、D51）。

---

## 10. 方案：`llm-call` v0.3（📝 设计稿，未实现）

详见 `docs/agent/llm-call.md`。一句话：**ta 是一个独立的人，记忆系统是本体，LLM 是它的一次调用，
工具是眼睛和手**。

### 10.1 六个机制与现状的落点

| # | 机制 | 方案内容 | 与现状的关系 |
| - | - | - | - |
| 1 | 本体论 / 四类记忆 | episodic / semantic / procedural / identity；屏幕是「世界」不是本体 | 新增概念层；现有 `persona` 只是 identity 的一半 |
| 2 | perceive → act | 每次任务 / 线程的第一次调用先产 300–500 字自状态；快照 8–10k 字 | **替代**现在「每轮重发大 system」 |
| 3 | 向量回想 | `mem_vectors`，本地 bge 索引日记/对话/观测，每轮 top 6–8 + 时间衰减 + MMR；CoT 不做 | 已落地：`recall.ts` 排序 + `vectors.ts` 增量索引（schema v10，组合根后台排队）；**act / `recall_diary` 还没接向量路**，`recall_diary` 仍是关键词打分 |
| 4 | 任务记忆 + 调度 | `routine.md` + `mem_tasks`，30s 查到期；`schedule_task` 等工具；调用后 follow-up review；10 分钟合流窗口 | **完全新增**；现有 scheduler 只有采集 2s / 保留期 6h |
| 5 | 夜报 / 周报 / 成长 | 23:30 读当天日记 → 评论 0–2 → 写自己；周日 22:00 reflect 更新 `self.md` / observations | 现在只有 `mem_observations(source='stats')` 统计观测，无写入路径 |
| 6 | 写入安全 / 标记契约 | ta 自己写的行走 `[❤️]()` 空评论格式，评论 `[❤️](正文)`、回复 `[💬](正文)`；备份 + 原子写 + mtime 冲突重试 + read 门白名单 | 已落地纯本地一半：`marks.ts` 解析标记、`write.ts` 只追加 / 插评论 / 备份 / 原子写（`vault.ts` 自身仍不写盘）；read 门白名单待工具层 |

### 10.2 数据模型（v10）

```sql
mem_vectors(item_type, item_id, model, vector, text_hash, updated_at)   -- PK(item_type,item_id,model)
mem_tasks(id, uid, title, instruction, kind, due_at, recurrence,
          next_due_at, status, source, last_run_at, surfaced_at, ...)  -- pending→due→coalesced/surfaced→done/skipped
mem_reflections(day_key, status, started_at, wrote_at, error, model)   -- 夜报幂等
```

`mem_vectors` **已随 schema v10 落地**（2026-10-29）；`mem_tasks` / `mem_reflections` 仍是设计（第 6 步）。

`mem_items` 不变（作者由 `[❤️](…)` 推导：空正文 = ta 自己写的行，带正文 = 评论；用户行尾裸 ❤️ 不算标记）；`mem_observations` 增 `source='reflect'` 与
`status` active/superseded；`mem_thoughts` 暂不做。

### 10.3 与现有不变量的关系

- 夜报 / 周报 / 任务调用都是**新增出网路径**：必须走 `AskOutbound` + 同一份同意门 / 日账；
- 调度器**不能挂在采集开关下**（采集是隐私线，不是存活线），但 app 不常驻就没有 24/7；
- 写入只追加 / 插评论，不删用户正文；删除仍走设置抽屉回收站；
- 冻结的信息链 / 图谱不动，新能力落在 `src/memory/` 与组合根。

---

## 11. 差距与风险

| # | 差距 | 现状 | 方案要求 | 风险 / 建议 |
| - | - | - | - | - |
| 1 | 第一次调用 | 无 perceive，每轮重发大 system | 两段式 + 8–10k 快照 | 多一次 LLM 调用（成本/延迟）；建议先「本地拼快照」再决定要不要模型压缩 |
| 2 | 记忆向量 | `recall_diary` 关键词打分；`mem_vectors` + 后台增量索引已落地 | `mem_vectors` + 余弦 + MMR；act 注入 | 基建现成（bge 512、host 进程）；真机 2 382 条 / 120 天副本上全量索引 5 档 202 ms（假 32 维），真 bge 待重启后看 `main.log` |
| 3 | 调度器 | 只有采集 / 保留期 / 旧管线 runtime | 30s 查到期、重启不重复、错过 30 分钟不补 | 需与采集开关解耦；24/7 依赖开机自启（待拍板） |
| 4 | 写入 | vault 解析 + 只读同步 | 备份 / 原子写 / 冲突重试 / 只追加 | **最高风险项**（碰用户正文）；先副本 vault 验收再碰真日记 |
| 5 | 出网 | 只有显式提问（+ 派生），过同一端口 | 夜报/周报/任务/review 无人值守出网 | 全部走同一端口 + 同意门 + 日账；还要定后台任务的额度优先级 |
| 6 | 合流 | 无全局队列；ask 是窗口内一次请求 | 单 runtime 队列，用户优先、任务让路、10 分钟窗口 | 需要新的一致层；现有 resume 检查点不能替代队列 |
| 7 | 标记契约 | `marks.ts` 认 `[❤️]()` / `[❤️](正文)` / `[💬]`，`write.ts` 已有只追加 / 插评论 / 备份 / 冲突重试；uid 由正文推导，标记留在 `text`、`text_norm` 仍含标记 | 行内线程解析 + 原子重写 | uid 含正文/起始行，插评论会改行号 → 后续要定「插评论后 uid 换不换」（现口径：换，按新文本重解析）|
| 8 | Obsidian CLI | 未接；本机 1.10.6 < 要求 1.12.4 | 仅生成当天模板，失败跳过 | 升级与 spike 均未做（文档标未验证）；中文卡住 / 抢焦点是已知问题 |
| 9 | 文档口径 | decisions 已补 **D57**（v0.3 十条 + 上午五条拍板）；信息链契约不动（个人记忆是另一套系统） | 接个人记忆前先定口径（AGENTS 第 12 条） | 口子已定；夜报 / 周报 / 任务的无人值守出网仍要过同一端口 + 同意门 + 日账（未实现） |
| 10 | 版本号漂移 | db v9 / chain v4 / 契约 v0.10 / 代码注释 v0.5 | — | 实施前对齐一次，别把 v10 迁移和契约修订混在一起 |

---

## 12. 建议的落地切口（推测，待拍板）

方案里真正的新子系统只有两个：**调度 + 写入**；其余都能复用现成零件。为了不把核心
（`src/chain/`）和日记耦死，建议照 `AskOutbound` 的做法端口化：

```ts
MemorySnapshotPort   // 组合根拼快照（人设 + self + 日记 + 观测 + 到期任务）
RecallPort           // 向量回想（memory embedder profile，复用 embedding-host）
TaskStorePort        // routine.md ↔ mem_tasks 双向
OutboundPort         // 已是 AskOutbound，夜报/周报复用
```

核心只依赖端口；脱敏 / 文件系统 / 时钟都在组合根或 `src/memory/`。顺序建议：

1. ✅ 纯本地、零 LLM：作者/线程解析（`marks.ts`）、写入器（`write.ts`：备份 / 原子写 / 冲突重试）已落地；`routine.md` 解析、快照拼装未做；
2. 固定钟 + 假 LLM 跑通调度器与夜报（`fake-llm` / `fake-embedding` 现成）；
3. ✅ 向量索引 + 回想（2026-10-29）：`mem_vectors`（v10）+ 增量索引 + 孤儿清理 + 后台排队已落地；act 注入待第 4 步；
4. perceive/act 接真模型（此时才有新增出网调用，需先过同意门）；
5. 周报 reflect、`self.md`；
6. Obsidian CLI spike（用户升级后）；
7. 真日记写入（最后一步，需用户点头）。

---

## 13. 关键文件索引

| 想改什么 | 先看哪里 |
| - | - |
| 组装 / 注入 / 窗口 / 生命周期 | `src/main/index.ts` |
| 问记忆 IPC 边界与校验 | `src/main/ask-ipc.ts` |
| 工具循环与预算 | `src/chain/agent/loop.ts`、`ask.ts` |
| 工具实现与参数钳制 | `src/chain/agent/tools.ts` |
| 载荷协议与出云端口 | `src/chain/agent/payload.ts` |
| 提示词与人设注入 | `src/understand/cloud/deepseek.ts` |
| 检索 / RRF | `src/chain/query.ts`、`main/search-host.ts` |
| 段机 / 记录器 | `src/chain/segmenter.ts`、`recorder.ts` |
| 截图 / 内容 / 保留期 | `src/main/chain-shot.ts`、`chain-content.ts`、`chain-retention.ts` |
| 派生 | `src/chain/derive/runner.ts` |
| 日记解析 / 同步 / 召回 / 人设 | `src/memory/{vault,store,persona,schema}.ts` |
| 日记标记 / 写入（只追加 / 插评论 / 备份） | `src/memory/{marks,write}.ts` |
| 日记向量（索引 / 回想排序） | `src/memory/{vectors,recall}.ts` |
| 表结构 | `src/db/schema.ts` + `src/db/migrations.ts`、`src/chain/schema.ts`、`src/memory/schema.ts` |
| 设计稿 | `docs/agent/llm-call.md` |

**阅读顺序建议**：`AGENTS.md` → 本文 → `docs/agent/progress.md`（最近三条流水）→
`docs/agent/llm-call.md` → `src/main/index.ts` 的 `askOptionsFor()` 与 `registerAskIpc()`。

---

## 14. 待办（文档口径）

- [x] decisions 补 `llm-call` 的拍板条目（合流窗口、夜报时间、成长 L2/L3、`[❤️]()` 标记格式）—— 2026-10-29 已落 **D57**。
- [ ] 信息链契约版本号与代码注释对齐（AGENTS 说 v0.10，`chain/schema.ts` 头部还写 v0.5）。
- [ ] 本文「方案」部分在实施后逐条改成 🟢，并把 gap 表逐行划掉。
