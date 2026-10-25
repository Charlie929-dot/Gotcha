# 图谱重做方案 v0.3 · 全局主题图 + 时刻层 + 时间筛选

> **2026-10-25 架构 v2 标注：本文的「主题节点 + 时刻点」图谱模型已由 `docs/memory-orb-architecture-v2.md` 取代。** 新模型只画窗口球与双链球，事件/截图留在窗口内部，主题图退为 legacy 视图。本文件保留为 M2 实施记录、旧主题管线参考与迁移依据；新图的数据模型、迁移与验收以架构 v2 为准。
> 状态：**实施中（2026-10-25）**——P0（Foam 内核 F1–F13）✅、P1（schema v3 + 数据层 + 向量回填）✅、P0.5（主题合并 + 次归属，schema v4）✅、P3-a（`graph:global` IPC + 默认全局 Foam 页 + 日历调暗 + 旧 sigma 页开关）✅、P3-b 已落 日格计数 ✅ / 模型缺失黄条 ✅ / 阈值控件 ✅ / 撤销合并入口 ✅ / 未归纳空心点 ✅ / 自动归纳后画布刷新 ✅ / 「时刻过多」收窄提示 ✅；P2 在线化 已落 S1 时刻在线化 ✅ / S2 归属引擎 ✅ / S3 增量向量维护 ✅（schema v6：文本/成员指纹）/ S4 命名与模糊确认两条 LLM 调用 ✅ / S5 串行队列与暂停零出网 ✅ / S6 接线（在线归属运行时 + 开关 + 与「补历史」共存）✅ / S7 在线路径 E2E（假向量注入 + 采集→时刻→归属/命名→画布刷新一条链）✅；LOD（归 M3）与打包待做。
> 已定方向（拍板人）：① 不做 3D，保留 Foam 2D 与其活布局/惯性/粒子动效；② 只保留一张全局图，时间只做筛选/调暗；③ 主题节点 + 时刻点，时刻可同时属于多个主题；④ LLM 只做新主题命名、模糊归属确认与提示文案，不再批量归纳节点/边；⑤ 主题圈（韦恩背景）不做。
> 事实源：本文件；D27 的内核（Foam + 本地向量 + 距离编码）保留，D27 的「按日构图」由本文件修订（「事件默认不上画布」仍成立：原始事件不上，新增时刻点层）；D28 的按日归纳降级为补历史/调试；新增 **D29**。
> v0.2 已归档至 `docs/archive/m2-graph-redesign-v0.2.md`（ONNX 实测数据仍有效，见 §10）。

## 0. 一句话

**事件先聚成「时刻」，时刻被本地向量分到「主题」里；一个时刻可以同时属于多个主题；所有主题和时刻放在同一张全局图里，时间只是滤镜；主题之间的线由本地向量相似度决定，Foam 负责活的力布局。**

## 1. 与 v0.2 的差异

| 维度 | v0.2 | v0.3 |
| - | - | - |
| 图的范围 | 按本地日构图 | **一张全局图**；时间只筛选/调暗 |
| 时间控件 | 前一天/后一天/今天 | **日历 popover**：单日、涂抹范围、Ctrl 加减、前 3/7/30 天、全部 |
| 画布上的点 | 概念节点；事件默认不上 | **主题节点 + 时刻点**；原始事件仍不上，侧栏看 |
| 多归属 | 无 | **时刻可多归属主题**；共享时刻是「交集」 |
| 主题圈 | 无 | **不做**（否决韦恩背景圆） |
| LLM 职责 | 批量归纳节点 + 边 | **只命名新主题、确认模糊归属、写提示文案**；边全本地 |
| 渲染 | Foam + M1–M9 | Foam + **F1–F13**；保留粒子/标签动效；控制面板隐藏 |
| 布局 | 未定 | **活布局**（拖动/惯性/碰撞）；位置 seed + 保存，不冻结 |
| 验收 | G1–G10 | **G1–G13** |

## 2. 目标与非目标

**目标**

- 一张全局图：主题节点（大）与时刻点（小）常驻；时间筛选只调暗，不删数据；
- 一个时刻可属于 2–3 个主题；共享时刻在主题之间形成桥，作为「交集」的可视化；
- 主题之间自动连线：本地 `bge-small-zh-v1.5` 余弦相似度，阈值/top-k/互选可配，距离编码，线宽统一；
- 保留 Foam 的活布局：拖动一个点会牵动邻居、碰撞排斥、惯性；
- 新增主题只在「新簇/模糊带」调用 LLM；记忆层全量本地，提示层才用 LLM 判断；
- 模型缺失/加载失败时显式提示，不阻塞时间线与采集；已有向量仍能画图。

**非目标（本版不做）**

- 不做 3D（3D 的标签/拾取/找东西成本高于收益，Foam 2D 已够）；
- 不做主题背景圆/严格韦恩几何（已否决）；
- 不做事件级点（原始事件不上画布；时刻点下钻到事件）；
- 不做跨设备/云同步、L2/L3 完整分层（M3）、ANN 索引（万级再上）；
- 不做 UIA/进程内存采集（采集层另立方案；本方案只消费现有 OCR 事件）；
- 不替换 OCR（结构化采集是另一条线，见对话记录，不在本文件验收）。

## 3. 总体架构

```text
events（L0，采集/OCR）
   │  按 app + 标题 + ≤90s 合并
   ▼
moments（时刻）
   │  本地 embedding（bge-small-zh-v1.5）
   ├─ 与主题向量比：主归属 + 高置信次归属（0–2 个）→ theme_moments
   ├─ 新簇/模糊带 → LLM 命名/确认（脱敏，D24 门）
   └─ 主题标题+摘要 → 向量 → 全局 top-k/互选 → edges(kind='embedding')
   ▼
themes（主题节点） + moments（时刻点） + memberships + edges
   │  graph:query（全局/窗口）
   ▼
Foam <foam-graph>：活布局、时间 dimmed、主题/时刻两层
```

- 主进程只多一个**本地** embedding 服务；LLM 只做语义命名/确认，出网仍走唯一出口（`redact.ts`）与 D24 确认门。
- SQLite 仍是唯一事实源；模型文件不进库、不进 git。

## 4. 数据模型（schema v4；v5 另有检索索引 `events_fts`，见 `docs/memory-orb-design-proposal.md` §3；v6 给两张派生向量表加输入指纹列，见 §4.3）

### 4.1 时刻

```sql
CREATE TABLE IF NOT EXISTS moments (
  id           INTEGER PRIMARY KEY,
  start_ts     INTEGER NOT NULL,
  end_ts       INTEGER NOT NULL,
  day_key      TEXT NOT NULL,          -- 本地日期 yyyy-mm-dd
  app          TEXT,
  window_title TEXT,
  ocr_summary  TEXT,
  event_ids    TEXT NOT NULL,          -- JSON 数组，原始事件 id
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moments_day ON moments(day_key);
```

- 时刻 = 同 app + 同标题 + 相邻 ≤90s 的事件组（沿用 `batch.ts` 的合并口径）；`ocr_summary` 去重后截断。
- `event_ids` 必须可解析回事件行；原始事件仍是 L0，不因时刻/主题改写。

### 4.2 主题成员（多对多）

```sql
CREATE TABLE IF NOT EXISTS theme_moments (
  theme_id   INTEGER NOT NULL,
  moment_id  INTEGER NOT NULL,
  weight     REAL NOT NULL DEFAULT 1.0, -- 归属置信度，力布局用
  source     TEXT NOT NULL,             -- 'owner' | 'secondary' | 'manual'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (theme_id, moment_id)
);
CREATE INDEX IF NOT EXISTS idx_theme_moments_moment ON theme_moments(moment_id);
```

- 主归属恒有；次归属 0–2 个；同一时刻可出现在多行。
- `nodes.source_events` 保留为「并集」兼容字段，不再作为权威来源；新查询走 `theme_moments`。

### 4.3 主题向量与位置

```sql
CREATE TABLE IF NOT EXISTS node_embeddings (
  node_id    INTEGER PRIMARY KEY,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,            -- Float32Array，已 L2 归一化
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS node_positions (
  node_id    INTEGER PRIMARY KEY,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- 主题向量 = `title + "。" + summary` 的 CLS pooling + L2（与 v0.2 一致）；成员变化/合并/改名后重算。
- 时刻向量不落库：分配时临时计算；若后续要做事件级回忆，再单独评估存储（int8/窗口）。
- `node_positions` 只存坐标，用于下次 seed；活布局会继续移动，不冻结。

**实施（2026-10-24，PR #38）**：主题向量 = `title + "。" + summary`，写 `node_embeddings`（model=`bge-small-zh-v1.5`、dim=512、已 L2 归一化）；`embedThemeVectors` 只补缺失、失败返回错误码不抛；真实库 229 个主题 3.6 s 跑完，重跑 0 次推理。

**v4 追加（P0.5 / §5.1）**：

```sql
CREATE TABLE IF NOT EXISTS event_embeddings (   -- 成员事件向量缓存（合并/次归属用）
  event_id INTEGER PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL,
  vec BLOB NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS theme_centroids (    -- 主题成员事件质心
  node_id INTEGER PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL,
  vec BLOB NOT NULL, member_events INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

- 事件向量逐条缓存、只补缺失（中断可续）；质心按 owner 归属重算，**只在成员变了时**（见 §5.2 S3）。
- `node_embeddings` 只放 `title+summary`（连线），`theme_centroids` 只放成员事件均值（合并判定），口径不同不混存。

**v6 追加（P2 · S3，2026-10-25）**：两张派生表各加一列「输入指纹」，让增量维护能判断「谁真的变了」：

```sql
ALTER TABLE node_embeddings ADD COLUMN text_hash TEXT;      -- 标题+摘要的指纹
ALTER TABLE theme_centroids ADD COLUMN members_hash TEXT;   -- 参与求均值的事件 id 集合指纹
```

- 两列都可为空：老库升级后是 `NULL` → 视为「不知道能不能复用」，第一次维护各自重算一次把指纹补上（自愈）；
- 只用于本地判断「变了没有」，不进日志、不出网；down 直接 `DROP COLUMN`，不影响 L0 事件与归属。



### 4.4 边

- `edges(kind='embedding')`：主题↔主题相似边，`weight=sim`，`evidence` 存 `{model, threshold, topK, mutual}`。
- 主题↔时刻的成员边**不进 edges 表**，由 `theme_moments` 现算；只在力布局/高亮时用，默认画得很淡或不可见。
- 旧 `kind='ai'` 边保留不删，查询默认 `kind='embedding'`；显式清理另开操作。

### 4.5 迁移 v3 / v4

- v3：时刻层 / 多归属 / 主题向量与位置；建表 + 索引；up/down/幂等；文件库迁移前自动备份（沿用 Phase 0 流程）。
- v4：`node_merges`（合并审计，每源节点一行、共享 `group_id`）+ `nodes.merged_into` + `event_embeddings` + `theme_centroids`；`ALTER TABLE` 前后做列存在性检查，down 用 `DROP COLUMN`（SQLite ≥3.35，本项目 3.53）；down→up 后结构快照与首次一致（已测）。
- 回填（一次性/可重入）：
  1. 从 events 生成 moments（按本地日 + 合并口径）；
  2. 由 `nodes.source_events` 生成 `theme_moments`（source='owner'）；
  3. 计算主题向量；布局后写 `node_positions`；
  4. 全局 top-k/互选生成 embedding 边。
- 回填期间图谱可只读展示旧 `ai` 边或空边，不阻塞采集/时间线。

**实施（2026-10-24，PR #37；P1 数据层）**

- 建表：`src/db/schema.ts` + `src/db/migrations.ts` v3（`moments` / `theme_moments` / `node_embeddings` / `node_positions` 及索引；up/down/幂等，文件库迁移前自动备份沿用 Phase 0）。
- 编排：`src/understand/graph-backfill.ts#backfillGraphStructures` = 时刻 → 主归属 →（有向量时）embedding 边，每步幂等可重入。
- 时刻：`src/understand/moments.ts`。对**全部** events 生成（含还没进主题的事件），给 P2 的 assigner 留池子；分组条件在 batch 的「同 app+标题、≤90s」之上**加 day_key**，时刻不跨本地日。`queryGlobalGraph` 默认只返回有归属的时刻（悬空点不画），`includeOrphanMoments` 可显式取。
- 归属：`src/understand/theme-membership.ts` 以 `source_events` 回填 owner；`INSERT OR IGNORE` 幂等，缺失事件 id / 悬空时刻如实计数。
- 边：`src/understand/graph-edges.ts` 纯函数（余弦 → 阈值 → top-k → 互选 → 无向去重），全量重写只碰 `kind='embedding'`，旧 `ai` 边不动；向量 BLOB 小端 Float32。
- 查询：`queryGlobalGraph` 出全局 DTO（主题 / 时刻 / 归属 / 边 / 位置 + stats），旧 `queryGraphDay` 保留给当前 UI。
- **未做（需拍板）**：主题向量与 embedding 边要本地向量运行时（`onnxruntime-node` + bge 模型文件，属依赖与模型分发决策）；启动/后台接线（把回填写进应用生命周期）与 UI 切全局图放 P1 尾部 / P3。


## 5. 主题合并与多归属

### 5.1 主题合并（先做，否则多归属是假的）

实测（2026-10-24 凌晨只读快照，210 个主题 / 2,689 个成员事件）：

- 主题两两相似度 **≥0.90 有 473 对，≥0.95 有 127 对**（GUI 修复、时间线各有一串近重复）；
- 事件文本 vs 主题标题：只有 **20.6%** 的事件，其所属主题是相似度 top1；标题是抽象概括，和原始 OCR 有距离；
- 主题「成员均值质心」更糟：top1 升到 71.5%，但 0.78 阈值下 **95% 的事件同时匹配 ≥2 个主题**——均值把主题抹平了。

结论：**先合并近重复主题，再谈多归属**。

- `≥0.95` 且同 type：自动合并（可撤销）；`0.90–0.95`：只提示，不自动；
- 合并 = 并集 `theme_moments`、扩展 `ts_start/ts_end`、摘要取更长/LLM 合并一次、重算向量、重连边；
- 留 `node_merges(from_node, into_node, at, reason)` 审计/回滚；合并后源节点标记 `merged_into`，不物理删除，避免旧引用断链；
- 合并后重新跑一次多归属统计，阈值再标定。

**标定（2026-10-24，真实库 229 主题 / 3,141 成员事件，`bge-small-zh-v1.5`；PR #38）**

| 向量来源 | ≥0.99 | ≥0.95 | 0.90–0.95 | ≥0.95 连通分量 | 涉及主题 |
| - | - | - | - | - | - |
| 主题 `title+summary`（存 `node_embeddings`） | 1 | 13 | 29 | 6 个（4/4/2/2/2/2） | 16 |
| 成员事件质心（成员向量均值再 L2） | 41 | **174** | 429 | 22 个（12/11/11/9/8/8/7/7/5…） | **108** |

- **合并候选必须用成员事件质心，不能只看 `title+summary` 向量**：文本向量只认出 16 个主题，质心能认出 108 个（「审查草案」家族一串 0.998+）；v0.2 的 127 对也是质心口径。
- 质心口径下 ≥0.95 的分量有大有小（最大 12），合并要按分量处理、能撤销；0.90–0.95 只提示。
- 代价：质心要把成员事件都过一遍模型（3,141 条 / 单线程 192 s）；P0.5 应截断到 256 token + 多线程 + 后台跑，并考虑把质心另存（`node_embeddings` 只放 title+summary 向量，二者用途不同：连线 vs 合并判定）。

**P0.5 实施与复测（2026-10-24，schema v4）**

- 表：`event_embeddings`（事件向量缓存，只算 owner/manual 时刻引用且有文本的事件；本库 3,137 条，另有 4 条空文本永远不算、不计入缺失）+ `theme_centroids`（主题质心 + 参与均值的事件数）。标题向量与事件/质心向量分表存，用途不混。
- 合并固定点：合并会改变存活主题质心（成员并集），可能贴近新的主题，所以一轮回填内循环到收敛（上限 8 轮；实测 2 轮）。实测第 1 轮 34 组 / 65 个源节点，第 2 轮 3 组 / 6 个，**229 → 158 个主题**；成员事件并集不变（3,141），5 个时刻与目标已有归属冲突（保留目标那条，不重复写）。
- 摘要先按「取更长」确定性合并（标题保留存活节点）；LLM 合并摘要留到 P2（要过 D24 确认门），不在后台自动调。
- 撤销：`node_merges` 每个源节点一行、同一次计划共享 `group_id`；`revertThemeMerge` 按组恢复字段与归属。副本上把 37 组全部回滚后回到 229 个主题、owner 828 条、成员事件 3,141 条。
- 撤销入口（P3-b，2026-10-25）：设置抽屉「合并记录」列出**未撤销**的合并组（`存活主题 ← 源主题、时间`），逐条「撤销」。**撤销即否决该对**：回填的合并步骤用 `isMergeVetoed`（看这对最近一次 `node_merges` 记录是否已撤销、方向无关）跳过它，否则下次回填会按 ≥ 阈值把刚拆开的主题立刻合回去——那样「撤销」等于没做。回填循环在「本轮一条都没合上」时直接停（固定点），不空转 8 轮。撤销后渲染层再按当前阈值 `graph:recompute` 一次并重新拉图；模型未就绪时只回填结构（向量/连线等下次带模型回填重建）。
- 复测相似度（256 token 事件向量）：质心 @0.90/0.95/0.99 = **378/100/21 对**；`title+summary` = **40/13/1 对**。结论不变：合并用质心。
- 事件向量耗时：256 token / 4 线程 / batch 32 ≈ **42–45 ms/条**；本库一次约 **2 分 10 秒**（后台、一次性）。8 线程 65.7 ms/条反而更慢；128 token 20.4 ms/条但会丢正文信息，未采用。
- 次归属标定：质心口径 0.80 时 **787/822** 个时刻都有非主归属候选（95%+ 命中，与 v0.2「均值抹平」同病）；0.92 且近重复 ≥0.92 排除后 **78/823 个时刻、103 行**；0.93 为 45/57。默认取 0.92 / 0.92，上限 2。
- 合并后 embedding 边（158 主题，0.64/k4/互选）**171 条**。第二次运行：0 合并、0 新向量、次归属 0 增 0 删、边 171→171（幂等）。
- 只在质心完整（所有有文本的 owner 事件都有向量）时进入合并；事件向量没算完（模型缺失/中断/首次后台未跑完）时只重建边并标 `deferred`，下次打开继续。


### 5.2 主归属 + 次归属

对新时刻 `m`：

1. 计算 `sim(m, 每个主题向量)`，取 top-k；
2. **主归属**：`argmax` 且 `sim ≥ 0.78`；若 top1 与 top2 差距 `<0.03`，先走 LLM 确认再落库；否则新建主题（LLM 命名）；
3. **次归属**：其他主题 `sim ≥ 0.80`，且该主题与主主题的主题间相似度 `< 0.92`（排除近重复变体），最多 2 个；
4. **模糊带**（0.76–0.80，或多个候选差距 <0.03）：LLM 批量确认，每批 20 个时刻，返回 0–3 个主题 id 或 `new`；
5. 写入 `theme_moments`：主归属 `source='owner'`，次归属 `source='secondary'`；权重 1.0（力布局等权，避免把共享时刻拉偏）。

> 存量时刻（已有 `source_events` 归属）以现有 owner 为主归属，不重跑向量；新时刻才用向量 argmax。实测事件文本的 top1 与既有 owner 只有 20.6% 一致，**不能盲信 argmax**；top1/top2 差距小或跨类型时交给 LLM。

阈值全部进 settings（默认值已在 2026-10-24 合并后的真实主题集上重新标定）：

| 键 | 默认 | 说明 |
| - | - | - |
| `graph.theme_new_min_sim` | `0.78` | 低于它新建主题（P2 在线 assigner 用，待重标） |
| `graph.theme_member_min_sim` | `0.92` | 次归属最低相似度（质心口径；0.80 会 95% 命中） |
| `graph.theme_duplicate_sim` | `0.92` | 与主主题达到它视为近重复，不做次归属 |
| `graph.theme_merge_sim` | `0.95` | 自动合并阈值（质心、同 type） |
| `graph.theme_secondary_max` | `2` | 次归属上限 |
| `graph.edge_min_sim` | `0.64` | 主题间连线阈值 |
| `graph.edge_top_k` | `4` | 每主题最多邻居数 |
| `graph.edge_mutual` | `1` | 互选 |

> 已按 §5.1 的标定更新 `theme_member_min_sim`（0.80→0.92）；其余沿用，但换模型/大规模增量后要重新标定，不要直接套 v0.2 的 node→node 数字。

**2026-10-25 重标 `theme_new_min_sim`（真机只读快照：431 个存活主题 / 3,289 个时刻 / 8,979 条事件向量，`memory.db` 在线备份，原库未写）**

口径与 `theme-centroids.ts` 一致：时刻质心 = 成员事件向量均值再 L2，主题质心取 `theme_centroids.vec`（已 L2），相似度 = 余弦。基准用 `theme_moments.source='owner'` 的现有归属——那是 LLM 结的果，**只作对照，不是真值**。

| 量 | p10 | p50 | p90 |
| - | - | - | - |
| 时刻质心 vs 自己的 owner | 0.836 | 0.953 | 0.996 |
| top1 相似度 | 0.888 | 0.960 | 0.996 |
| top1 − top2（gap） | 0.004 | 0.028 | 0.105 |

按阈值扫（`themeNewMinSim` 从 0.70 到 0.95，步长 0.01）：

| T | 被判给已有主题 | 其中 argmax ≠ owner | 判新主题 |
| - | - | - | - |
| 0.78 | 98.4% | 29.2% | 1.6% |
| 0.85 | 95.3% | 28.0% | 4.7% |
| 0.92 | 79.6% | 23.4% | 20.4% |

- **绝对阈值几乎不起作用**：top1 中位 0.96，0.78 时 98.4% 的时刻都「像某个已有主题」；抬到 0.92 也只是多判 20% 新主题，argmax ≠ owner 只从 29.2% 降到 23.4% → **`theme_new_min_sim` 保留 0.78**。它管「像不像任何主题」，不该兼职管「归得对不对」。
- **真正分得开的是 gap**（gap 分档，n=2,181 有 owner 的时刻）：

| gap 区间 | 占比 | argmax ≠ owner |
| - | - | - |
| < 0.005 | 12.2% | 61.1% |
| 0.005–0.01 | 11.4% | 51.0% |
| 0.01–0.02 | 17.4% | 40.3% |
| 0.02–0.03 | 11.2% | 28.6% |
| 0.03–0.05 | 14.9% | 19.9% |
| 0.05–0.1 | 21.9% | 10.9% |
| ≥ 0.1 | 11.0% | 7.5% |

- 结论①：模糊带应以 **gap** 为主判据；§5.2 的绝对区间 `0.76–0.80` 实测只覆盖 0.7% 的时刻，几乎碰不到。
- 结论②：照 §5.2 原样（`gap < 0.03` 送 LLM）＝ **52% 的时刻都要出网确认**，在线路径省不出多少调用；收到 `gap < 0.01`（占 23.6%）时自动归属里约 16% 与 LLM 现归属不一致（含「LLM 自己也错」的，光看这个数分不开）。
- 结论③：owner 只有 70.3% 被 argmax 复现，根因不是阈值太低，而是 431 个主题里仍有大量近重复变体（同一个 `moment` 的 top1 / top2 常是「同一件事的两个主题」）→ 要提准确率先治主题碎片化（合并阈值 / 命名重复），不要往上抬相似度阈值。
- 结论④：**65.9% 的时刻，它自己的 top1 / top2 就是近重复主题**（两者主题间相似度 ≥ `themeDuplicateSim` 0.92）。这批时刻「选谁」在语义上等价，出网确认纯属浪费。把「top1/top2 近重复」排除在确认之外后：

| 确认规则 | 需出网 | 自动归属占比 | 自动归属里 argmax≠owner |
| - | - | - | - |
| `gap<0.03`（§5.2 原样） | 52.2% | 47.8% | 13.0% |
| `gap<0.02` | 41.0% | 59.0% | 15.9% |
| `gap<0.01` | 23.6% | 76.4% | 21.5% |
| `gap<0.03` 且 top1/top2 非近重复 | **10.3%** | 89.7% | 26.2% |
| `gap<0.02` 且 top1/top2 非近重复 | 8.0% | 92.0% | 26.8% |

  最后一行的「26.2% 不一致」不能直接当错误率读：其中大部分是 argmax 选了同簇的另一个主题（与 owner 近重复），语义上是同一件事。**要判真错得人工抽样**，这点留给 P2 验收。

> 脚本与原始输出留在 `.tmp/calibrate-theme-new-min-sim.cjs` / `.tmp/calib-out.json`（未入库；要复现就照上表口径重写一遍，约 20 行 SQL + 向量点积）。

**S2 归属引擎 实施（2026-10-25，P2 第 2 步；纯本地，只读不写）**

`src/understand/theme-assign.ts`：`assignMoment()` 是纯函数，输入时刻质心 + 存活主题质心，输出 `{ reason, owner, secondaries, top1, top2, gap, nearDuplicateTop }`；`reason` 三态 `assigned` / `ambiguous` / `new-theme`，调用方拿 `ambiguous` 去排 LLM 确认队列（写库与排队在 S5/S6 接）。

判定顺序（照上面标定结论，不是拍脑袋）：

1. top1 `< themeNewMinSim`（0.78）→ `new-theme`；
2. top1 / top2 **互为近重复**（主题间 ≥ `themeDuplicateSim` 0.92）→ 直接取 argmax，`assigned`，**不出网**；
3. 其余 `gap = top1 − top2 < themeGapConfirm`（**新设置键 `graph.theme_gap_confirm`，默认 0.02**）→ `ambiguous`；
4. 次归属：`sim ≥ themeMemberMinSim`、排除与 owner 近重复的主题、上限 `themeSecondaryMax`；`protected` 主题既不当候选也不做次归属。

注意：默认阈值下**次归属很稀有**——`themeMemberMinSim` 与 `themeDuplicateSim` 都是 0.92，候选要「离时刻 ≥0.92」又「离 owner <0.92」在几何上几乎不可能（真库实测 823 个有归属时刻里只有 78 个有次归属）。想放宽次归属，先调小 `themeDuplicateSim`，不要只降 `themeMemberMinSim`。

另：相似度并列时按 id 升序取，保证同一份库上结果确定。单测 9 条（`tests/unit/theme-assign.test.ts`：归属 / 模糊 / 近重复豁免 / 新主题 / 维度与 protected 过滤 / 次归属阈值与上限 / 并列确定性 / DB 端到端 / 缺向量缺图状态）。

**S3 增量向量维护 实施（2026-10-25，P2 第 3 步；纯本地，零出网）**

要解决的问题：向量是派生数据，但旧口径只看「**有没有这一行**」（`onlyMissing`）。归纳批量路径会**原地改摘要**（`induction.ts`：同日 + 同 type + 同标题 → `UPDATE nodes SET summary = ?`），主题成员也是追加写的——于是过期向量永远留着，重算又只能整表重算。

做法：给输入算指纹，**只重算指纹变了的行**。

- `src/understand/vector-fingerprint.ts`：64 位 FNV-1a（两个种子拼 16 位十六进制），确定性、不依赖随机盐；事件 id 集合**先排序去重**再算（追加顺序不同不该触发重算）。只回答「变了没有」，不是安全哈希。
- 标题向量（`theme-embeddings.ts`）：`planThemeTextVectors()` 每行比对 `node_embeddings.text_hash`；旧 = `{ all, stale, reused, skippedEmpty }`。`embedThemeVectors` 只把 `stale` 送模型，报告新增 `reused` / `skippedEmpty`；`onlyMissing: false` 仍可强制全量（调试 / 换模型）。
- 主题质心（`theme-centroids.ts`）：`computeThemeCentroids` 顺手给每行算 `membersHash`（实际参与求均值的去重事件 id）；`planThemeCentroids()` 只回 `{ stale, reused, dropped, pending }`——`pending` = 有归属但事件向量还没算出来（**不删旧行**，等下一轮），`dropped` = 成员已经没了（主题被合并 / 归属被清）。
- 编排（`vector-maintenance.ts`）：`syncThemeCentroids()` 只重算 `stale`（并按 `dropped` 删行），返回同步后的**全量**质心 + 操作计数；`refreshThemeCentroid(db, themeId)` 是「新时刻归到这个主题」后的最小增量（只动一行）；`maintainMomentVectors(db, momentIds)` 只算这些时刻自己的质心，不碰主题质心。
- 接线（`graph-backfill.ts`）：质心同步改走 `syncThemeCentroids`（合并固定点的每一轮也只重算被碰过的主题）；次归属的时刻向量只算**有归属的时刻**，不再遍历全部时刻。

验证（真库**只读副本** `.tmp/s3-check*/memory.db`，431 个存活主题 / 444 个 L1 节点 / 8,979 条事件向量；原库只导出未写）：

| 场景 | 结果 |
| - | - |
| v5 → v6 迁移 | 成功，两列传为 NULL |
| 第一次 `syncThemeCentroids` | `stale 431 / recomputed 431 / reused 0`，80–87 ms（含读 8,979 条事件向量 + 求均值） |
| 第二次（没改数据） | `stale 0 / recomputed 0 / reused 431`，**19–21 ms** |
| `planThemeTextVectors` 首跑 | `444 stale`（老行没有指纹，需重算一次；其中 13 个主题没有质心/向量，与 §5.2 标定的 431 对上） |

代价与边界：升级后**第一次**打开图谱会把 444 个主题的标题向量重算一遍（自愈过期摘要，一次性，后台分批跑）；之后文本没变就 0 次推理。指纹只覆盖「输入是否一致」，不保证向量本身正确（模型换了靠 `model` + `dim` 判断，`dim` 不同即重算）。

单测 15 条：`tests/unit/vector-fingerprint.test.ts` 4 条（确定性 / 同前缀不同长度 / 集合顺序无关 / 坏值忽略）、`tests/unit/vector-maintenance.test.ts` 9 条（改标题 / 改摘要只重算一行、老库 NULL 自愈、强制全量、质心首次全算第二次全复用、新增归属只重算该主题、成员清空删行、pending 不误删、`refreshThemeCentroid` 只动一行、新时刻只算自己）、`tests/unit/migrations.test.ts` +2 条（v6 加列 / 只回滚列）。

### 5.3 存量数据

- 现有 210 个主题作为种子，不重新聚类；`theme_moments` 由 `source_events` 回填为主归属；
- 合并 ≥0.95 后，再按 5.2 补充次归属（只加高置信、排除近重复）；
- 敏感时刻单独成 `protected` 占位主题（「内容已保护」），不调 LLM、不出云。

## 6. 全局边、距离、布局、位置

### 6.1 边

- 默认 `0.64 / top-4 / 互选`：203 个主题时 **216 条边**（其中 **72 条跨天**、34 个孤立）；top-8 = 421 条，太密。
- 阈值 0.60→0.68 只从 222 变 204 条：**密度主旋钮是 top-k，不是阈值**；UI 把 k 放前面，阈值放高级。
- 增量：新主题只与存量主题算 top-k；主题改标题/摘要/成员后重算它自己的边；换模型/调阈值才做一次全量重链（当前规模可接受，万级再上 ANN）。
- 主题间边按 `(src,dst)` 去重，`weight` 取较大；无向图。

### 6.2 距离与线宽

- `distanceFromSim(sim, t, dMin, dMax)`：`sim=t` 最远，`sim=1` 最近；`dMin/dMax` 在 Foam 坐标里 P0 重新标定，**不要直接搬 v0.2 的 45–220**（sigma 坐标不同）。
- 线宽统一 `style.lineWidth * linkWidthMultiplier`（Foam 已经是常数），不再乘 weight；`strength` 常数，避免和距离双重编码。
- 成员边用固定短距离（或由锚点/主题位置推），不走相似度距离；默认低透明度，高亮时才显。

### 6.3 活布局

- 保留 Foam/d3-force 的活模拟：拖动节点 → 相连节点跟随、碰撞排斥、松手有惯性；拖动时 force-graph 自动 reheat。
- `cooldownTicks` 让图先沉降再暂停；`velocityDecay`/`alphaDecay` 调到「有惯性但不飘」，P0 手感调。
- **碰撞按节点半径**：Foam 现在是固定 `forceCollide(4 * collide)`，要 patch 成按 `properties.size`（主题大、时刻小）；主题锚点排除或给单独半径。
- 不冻结；位置从 `node_positions` seed，关闭/沉降后保存；给「锁定布局」开关备用。

### 6.4 位置 seed

- 新时刻：放在主归属主题的位置附近（小抖动）；
- 新主题：放在 top-k 邻居的质心附近；
- 首次无位置：跑一次力布局再写回；
- 不因时间筛选重新布局；时间只改 dimmed 状态。

## 7. 渲染：Foam 2D

### 7.1 来源与依赖（已核对源码）

- `packages/foam-graph`，版本 0.40.0，commit `3a3662d1fff122e2701d7fb43adb70d9087d9bc3`（2026-10-23），MIT；
- vendor 到 `src/renderer/foam/`，保留 MIT + `foam/UPSTREAM.md`（commit、复制清单、patch 清单）；
- 依赖：`lit ^3`、`force-graph ^1.51`、`d3-force ^3`、`d3-scale ^4`、`d3-color ^3`；
- 组件是纯 Lit，`foam-graph.ts` 不 import VS Code；`main.ts` 只是 VS Code webview 启动器（有浏览器 mock），不需要。

### 7.2 数据映射

- 主题节点：`t:<id>`，`type` = knowledge/activity/protected；`title`；`properties.size` = `sourceCount` 对数 6–22；`tags: []`；
- 时刻节点：`m:<id>`，`type='moment'`；`properties.size` = 2–3；标题悬停/放大才显示；
- 主题边：`source/target = t:<id>`，`weight = sim`，`kind='embedding'`；
- 成员边：`t:<id> → m:<id>`，`kind='membership'`，默认很淡/不可见，仅参与力与高亮；
- 原始事件不上画布；点时刻 → 侧栏列出 `event_ids` 的事件行。

### 7.3 Foam 补丁清单

| # | 位置 | 改动 |
| - | - | - |
| F1 | `lib/types.ts` / `protocol.ts` | `GraphModelLink` 增加可选 `weight`、`kind`；`GraphData.links` 类型同步（运行时 `{...link}` 已保留） |
| F2 | `components/graph-canvas.ts` | `forceLink(...).distance(l => distanceFromSim(l.weight, t))`；`updated()` 里改 forces 时保持函数，不要重置成常数 |
| F3 | `components/graph-canvas.ts` | `getNodeSize` 从 `info.neighbors.length` 改为 `properties.size`（回退度数） |
| F4 | `lib/types.ts` / `lib/colors.ts` / `lib/graph-utils.ts` / `foam-graph.ts` | 新增 `dimmed` 状态（透明度约 0.16–0.20）；`computeGraphStates` 接 `focusNodeIds`；边按「两端都在范围内/一端/都不在」分档 |
| F5 | `components/graph-canvas.ts` / `foam-graph.ts` | `_updateGraphData` 建节点时 seed `x/y`（来自位置表）；沉降/关闭时回传坐标 |
| F6 | `components/graph-canvas.ts` | `forceCollide` 改成按节点半径；主题节点排除或单独半径 |
| F7 | `foam-graph.ts` / wrapper | 双击：canvas 只有 `onNodeClick`，wrapper 300ms 计时；单击=聚焦/调暗，双击=侧栏 |
| F8 | `components/graph-canvas.ts` / `foam-graph.ts` | 暴露 `zoomToFitNodes(ids)`（按子集包围盒），用于时间筛选后相机适配 |
| F9 | `components/graph-canvas.ts` | **保留** `linkDirectionalParticles(1)`、标签淡出、hover 高亮；不要按 v0.2 M8 删粒子 |
| F10 | `foam-graph.ts` | `showControls=false`；关闭 Foam 26KB 控制面板，改用 Gotcha 设置抽屉 |
| F11 | `lib/defaults.ts` 调用方 | 主题色/背景/行色全部覆盖成 Gotcha 暗色，不依赖 `--vscode-*` CSS 变量 |
| F12 | wrapper | 重实现 `__gotchaGraphView`（count/select/position/visibleCounts/filters/focusDays）；position 用 canvas transform 或 `graph2ScreenCoords` |
| F13 | `foam-graph.ts` | 局部聚焦优先用「选中 + 调暗」而不是 `graphScope` 删节点，避免布局跳；`graphScope` 仅备用 |

### 7.4 UI

- 默认：主题节点 + 时刻点都显示；工具栏「只看主题」切换时刻层；
- 单击主题：聚焦它 + 成员/邻居，其他调暗；双击：侧栏；单击时刻：侧栏事件；背景点击：退出聚焦；
- 计数：`N 个主题 · M 个时刻 · K 条相似连线`；
- 空状态分开：无主题 / 无模型 / 回填中 / 计算失败；
- 模型不可用：已有向量/边继续画，顶部黄条「新主题暂无法计算」；不把图清空。**已实现（2026-10-25，PR #54）**：`InductionSnapshot.embeddingsReady`（缺省 true）→ `status-view.ts#modelWarningText` → 全局页 `#model-warning` 黄条；黄条只切 `hidden`，图与计数完全不动。

**P3-a 实施（2026-10-24；默认页已切全局图）**

- 窗口默认加载 `graph/global.html`（Foam）；`graph:global` 一次取 `queryGlobalGraph` DTO，`toGlobalGraphInput` 映射成 `t:<id>` 主题 / `m:<id>` 时刻，主题相似边 + 默认隐藏的成员边。主题半径按 `sourceCount` 6–22、时刻 2.4（多归属 3）。
- 时间：日历 popover 实现 §8 的单击 / 涂抹 / Ctrl 加减 / Shift 扩展 / 快捷范围；只改 `dimmedNodeIds` 并按 focused 子集 `zoomToFitNodes`，**节点数不变**；空范围给提示、不移动相机。
- 弹层自身：交互期间只重刷日格 class、不重建 DOM（`renderCalendar` 建格子 / `paintCalendar` 刷 `.on`），否则冒泡到 `document` 时 target 已游离、外部点击判断误判成「点在外面」→ 一碰日期就关；外部点击判断改捕获阶段；头部新增 `×` 只关弹层、不关图谱窗口。
- 侧栏：主题 → `graph:node-events`；时刻 → 新增 `graph:moment-events`（`moments.event_ids` → events 行）+「也属于」其它主题（主归属排第一）。时刻单击直接开侧栏，主题单击聚焦 / 双击开侧栏。
- 位置：Foam 沉降后只回写主题坐标（`graph:positions:save` → `node_positions`，时刻不存）；下次打开作 seed。无库时跳过写，守 A3。
- 旧 sigma 按日页保留为 `graph.html`，工具栏「经典视图 / 全局视图」互切；P0 harness 页移除（`harness*.ts/html/css`）。
- 真机副本冒烟（`better-sqlite3 backup()` 复制用户库）：230 主题 / 1,047 个有归属时刻（总 2,113）/ 1,151 条归属 / 171 条相似边；画布 1,277 节点 + 1,322 连线，沉降 3.1–4.9 s；230 条主题坐标回写到副本。
- 日格热力（P3-b 第一项，2026-10-24/25，PR #52 已合并，`src/renderer/graph/day-stats.ts`）：**连续变化**——当天事件数 ÷ 满量（默认 4000 条/天，设置抽屉「视图」可调）＝百分比，映射成 `rgba(79,195,247,α)`，α ∈ 0.06–0.45、中间走 `ratio^0.6`；tooltip「N 条事件（P%）· M 个时刻 · K 个主题」。事件量来自主进程 `graph:global.dayActivity`（按本地日统计 `events` 全量，**含未成时刻的积压**），时刻按 `day_key`、主题按 `[tsStart, tsEnd]` 铺天。
- 未归纳空心点（P3-b，2026-10-25，`feat/calendar-pending-dot`）：日格在热力之外再标一个**空心点**＝这天有**时刻还没归属主题**（归纳没跑完），tooltip 末尾补「N 个时刻待归纳」。**口径刻意选「时刻 → 主题」**：事件 → 时刻是本地分组，`backfillAllMoments` 一跑就补齐（真库 13,217 条事件里只有当天 83 条没成时刻），真正会长期积压的是**悬空时刻**（同一份库 1,079 个，10-22 402 / 10-23 605 / 10-24 57 / 10-25 15，正是 D28 只自动归纳今天造成的）；按事件算的话空心点几乎永远不出现。数据来自 `dayActivity.pending`（`moments` 在 `theme_moments` 查不到行、按 `day_key` 计数）；渲染是格子右下角的空心环（`var(--accent)`），与「今天」底部实心点错开位置，同一天两者都在也看得清；`pending = 0` 时不加任何标记。
- 阈值控件（P3-b，2026-10-25，`feat/graph-threshold-controls`）：设置抽屉「视图」段暴露 `graph.theme_merge_sim`（自动合并阈值）/ `graph.edge_min_sim`（主题连线阈值）/ `graph.edge_top_k`（每主题连线数，0–32），只在全局图页出现（经典页共用面板，按 `querySelector` 判空、缺省不带 `thresholds`）。保存后渲染层显式调新通道 `graph:recompute`（仅图谱窗口主 frame）→ 主进程 `runGraphBackfill({ minIntervalMs: 0 })` 按库里阈值**重建 embedding 边**并再跑合并固定点，返回 `{ edges, merges, embeddings }`；`embeddings:false`（模型未就绪）时只回填结构、UI 明说「本次没有重算连线」，在途回填返回 `busy`。**合并阈值只影响之后的新主题**，已合并的不会自动拆开（撤销入口 `revertThemeMerge` 仍未接 UI）。
- 撤销合并入口（P3-b，2026-10-25，`feat/graph-merge-revert`）：设置抽屉「合并记录」段，数据来自新通道 `graph:merges:list`（只列未撤销组，按组聚合 `存活主题 ← 源主题、时间`，最多 20 组）；每条一个「撤销」按钮 → `graph:merges:revert`（校验正整数 groupId）→ `revertThemeMerge` 按组恢复字段与归属。撤销后这一对不再自动合并（`isMergeVetoed`），渲染层随即 `graph:recompute` + `load()`；失败原因如实翻译（记录不存在 / 已撤销 / 快照损坏 / 有更新的合并要先撤销）。按钮必须 `type="button"`——抽屉在 `<form>` 里，默认 submit 会把「撤销」变成一次设置保存。
- 自动归纳后的画布刷新（P3-b，2026-10-25，`feat/graph-auto-refresh`）：归纳落库后主进程推 `graph:changed`（`InductionRuntime.onGraphChanged`；只有节点 / 边 / 占位真的变了才推，失败 / 跳过 / 取消不推），渲染层收到后**就地刷新**——不点「立即归纳」、不重开窗口，新主题自己出现。与 `load()` 的区别是**不把 `graphData` 置空**：同 id 节点沿用画布上的当前坐标，新节点才用库里 seed，相机与时间 / 文字筛选都不重置；700 ms 防抖合并连续批次，手动归纳 / 保存设置刚拉过图的 1.5 s 内不重复拉；窗口不可见时先记下、重新可见再拉。已知边界：新主题的**时刻归属**要等下一次回填（打开图谱 / 改阈值）才出现，这次刷新只保证主题节点与连线是最新的。
- 「时刻过多」收窄提示（P3-b，2026-10-25，`feat/graph-scale-hint`）：可见时刻数**超过阈值**时，顶部出现一条蓝色提示「已显示 N 个时刻（提示阈值 M 个）：时刻层较多时画布可能偏卡，可切「只看主题」」，右侧按钮一键切「只看主题」（时刻层隐藏、提示自动收起）。阈值存设置 `graph.scale_hint_moments`（默认 **2000**＝§12 口径，抽屉「视图」段可调 1–20000），所以 §16 里「2k 还是 3k」不用硬编码——默认 2k，拍板人可以直接在抽屉里改。**文案刻意不推荐「收窄日期」**：时间筛选只调暗不删节点（§8），收窄日期并不会减少画布上的时刻数。纯逻辑在 `src/renderer/graph/scale-hint.ts`（`scaleHintText`，可单测）；「只看主题」时不再提示。
- 未做（P3-b 余下）：>2k 时刻的 LOD（归 M3 分层记忆；本轮只做提示，不降级渲染）。

## 8. 时间筛选

- **形态**：图谱窗口工具栏的日历 **popover**（不是独立 OS 窗口）。
- **交互**：点=单日；拖=涂抹连续范围；`Ctrl/Cmd+点`=加/减某天（支持不连续）；`Shift+点`=扩到该天；快捷「今天 / 前 3 天 / 前 7 天 / 前 1 月 / 全部」。
- **开合**：弹层内的一切操作（点 / 拖 / 加减 / 快捷范围）都不关闭弹层；关闭走头部 `×`、工具栏「日期」按钮、`Esc`、或点弹层外。`×` 只关弹层，不动图谱窗口。
- **日格**：显示当天主题/时刻/事件量（热力点）；归纳未跑完的天用空心点；tooltip 给计数。**v1（2026-10-24）**：热力 + tooltip 已实现（口径见 §7.4「日格计数」）。**v1.1（2026-10-25）**：空心点 = 这天有时刻还没归属主题（按时刻 → 主题算，不按事件 → 时刻，理由见 §7.4），不作为筛选条件、只做提示。
- **语义**：
  - 主题：`[ts_start, ts_end]` 与所选日期相交即 focused；
  - 时刻：`day_key` 在所选集合内；
  - 边：两端 focused 正常；一端 focused 中等；都不在很淡；
  - 相机：切范围后 `zoomToFitNodes(focusedIds)`；范围为空显示空状态，不移动相机。
- **数据**：M2 一次性加载全部主题/时刻/成员/边（当前 210 + ~800），日历只在客户端改 focus，不重新查库；归纳完成后再刷新。
- **默认**：全部；超过约 2k 个时刻时提示收窄，或 M3 上 LOD；不做「按天重新构图」。
- 旧的「前一天/后一天/今天」保留为快捷单日步进；「立即归纳」改为「补历史/补今天」（D28 仅补数据，不改图的范围）。

## 9. 归纳管线

### 9.1 在线路径（新）

1. `moment-builder`：取新事件 → 合并时刻 → 落 `moments`（幂等）；
2. `theme-assigner`：本地 embedding → 主/次归属（§5.2）；
3. `theme-labeler`：新主题/模糊归属 → LLM（脱敏、D24 门）→ 标题/摘要/type；失败则用代表事件标题兜底，主题仍建；
4. `theme-consolidator`：≥0.95 合并（§5.1），可手动触发；
5. `edge-builder`：主题向量变化 → 增量重连（§6.1）；
6. `positioner`：新节点 seed 坐标；沉降后保存。

- 队列串行；同一主题/时刻在途则合并；暂停时零出网：在途 abort、结果丢弃，恢复后按序补（D18）；本地归属只在采集运行中跑（暂停时没有新事件，定时器一并停掉省 CPU），但**不会因为 LLM 退避 / 缺 key / 未授权而停**——这才是 D18 要保的；调度层实现在 `src/understand/theme-queue.ts`（S5），接线在 `src/main/theme-online-runtime.ts`（S6）；
- LLM 调用只发生在「新主题」与「模糊归属」，不逐事件；每批最多 20 个时刻；
- 预算/退避/间隔沿用 D22 settings；用量只记 calls/tokens/耗时，不记正文。

**S1 时刻在线化 实施（2026-10-25；P2 第 1 步，只做第 1 段 `moment-builder`）**

新增 `src/main/moment-runtime.ts`：采集进入 `running` 时起 60 s 定时器（`paused` / `stopping` / 退出即清掉），把稳定下来的事件本地补成时刻；零出网、不依赖向量模型，所以**不受 D24 出网门约束**。A3 口径：库还没建（一次都没跑过采集）时不起定时器，不为定时器建库。

两条防「半成品时刻」的闸（`backfillMomentsForDay` 的幂等键是 `(day_key, start_ts, event_ids)` 全等，同一个组在 90 s 合并窗口里长个子会变成第二个时刻）：

1. 只处理 `ts < now − 3 min` 的事件；
2. 每个窗口再传 `settleMs = 90 s`（`backfillMomentsForDay` 新选项，**缺省 0，打开图谱的全量回填行为不变**），结束时间贴到窗口末尾的组留到下一轮。

水位（`processedUpTo`）成功一轮才推进，且**留 90 s 重叠**——推迟的组下一轮还能被看到；失败只记 `warn`（不记事件内容），下一轮重试。单测 7 条：稳定成时刻 / 未收口不落库 / 失败不推水位 / 重启从库内最后时刻接着走 / 跨午夜按日分段 / 定时器只起一个 / 收口后整组一次落库。

边界：采集迟到（事件在 `ts + 3 min` 之后才落库）仍可能把同一组拆成两个时刻——与打开图谱时的全量回填是同一性质的老问题，本轮不做删除清理（避免误删已有 `theme_moments` 归属）。

### 9.2 补历史（保留）

- 现有批量归纳（20 时刻/批，输出节点+边）保留为「补历史」工具，用于没有主题的旧日子；
- 补完后：生成 moments/memberships、embedding、全局边；旧 `ai` 边隐藏；
- 不再作为新数据的自动主路径；D28 的按日按钮保留为补历史/调试。
- **S6 起**：在线开关打开且本地模型就绪时，**自动**批量归纳让位（手动入口保留）；两条路径互相跳过对方处理过的数据——批量归纳跳过 `theme_moments` 已归属的事件，在线路径跳过事件已进节点 `source_events` 的时刻（详见 §9.1 的 S6 实施段）。

### 9.3 LLM 输出

- 命名：`{title≤24, summary≤80, type: knowledge|activity}`（单主题）；校验器复用/裁剪 `structure/schema.ts`；
- 模糊确认：`{assignments: [{moment_id, theme_ids[0..3], new_title?}]}`；只给候选主题与时刻摘要；
- 提示文案（后续 M4）：一句话「你 X 天前也做过类似的 Y」；不决定是否入图。

**S4 LLM 只剩两件事 实施（2026-10-25，P2 第 4 步；两条新调用，尚未接线）**

- 命名 `src/understand/theme-naming.ts`：`validateThemeName()` 手写校验（title / summary 按**存库硬上限 40 / 80** 确定性截断，24 / 80 仍是 prompt 建议；未知字段忽略——命名失败的代价只是标题不好看，为多写一个无害字段丢掉一次成功命名不划算）；`fallbackThemeName()` 用代表时刻的窗口标题 → app →「未命名主题」，摘要显式写「本地兜底命名」；`nameTheme(client, moments)` 返回 `{ name, source: 'llm'|'fallback', reason, usage }`：**没客户端（D24 门 / 缺 key）、载荷被敏感规则剔空、输出非法、请求失败都只兜底、不抛错、不阻塞建主题**；只有 `LlmAbortError`（暂停 / 退出）照旧外抛。
- 模糊确认 `src/understand/theme-confirm.ts`：`validateAssignments()` 逐条校验——未知 `moment_id` / 非候选 `theme_id` 丢弃，主题 id 去重并裁到 3 个（`trimmed` 计数），`new_title` 裁到 24 字，既没主题也没新标题的条目等于「不归属」；只有根结构非法才作废这一次调用。`confirmThemeAssignments(client, moments, themes)` 单批最多 20 个时刻，**请求失败 / 输出非法 / 没有候选 → 整批进 `pendingMomentIds` 留到下一轮**，不整批失败、不写库；敏感时刻 / 敏感主题在载荷层就剔掉（`blockedMomentIds` / `blockedThemeIds`）。两条路径都**不做修复重试**：失败代价是「兜底标题」或「延后一轮」，与批量归纳「整批卡死」不同，多调一次既贵又不可靠（`temperature=0` 的教训）。
- 出云仍走唯一出口：`redact.ts` 新增 `buildThemeNamingPayload()` / `buildThemeAssignmentPayload()`（brand 在类型层），命名只带代表时刻，确认只带时刻文本 + 候选主题的标题 / 摘要；候选 id 由本地 embedding 给出（`assignMoment()` 的 top-k），模型不能自由挑。`LlmClient` 相应新增 `completeNaming()` / `completeAssignments()`，DeepSeek 客户端与两个假客户端都已实现；prompt 与批量归纳同规格（`temperature=0`、`json_object`、错误文案不含正文），三条路径共用同一套重试 / 退避 / 取消语义。
- 单测 30 条：`theme-naming` 12（校验 / 截断 / 未知字段 / 兜底三级 / 输出非法 / 请求失败 / 未配置 / 敏感剔空 / 取消外抛 / 载荷脱敏）、`theme-confirm` 13（升序 / 去重裁剪 / 未知 id / 空归属 / new_title 裁剪 / 根非法 / 成功 / 请求失败 / 输出非法 / 未配置 / 敏感剔除 / 20 条上限 / 取消外抛）、`redact` +3（两类载荷的脱敏与 blocked）、`llm-client` +2（两条 prompt 不串线、候选 id 原样进 prompt）。接线（串行队列 / 暂停零出网 / 开关与「补历史」共存）在 S5 / S6。

**S5 队列 / 暂停 / 恢复 实施（2026-10-25，P2 第 5 步；只做调度层，尚未接线）**

- `src/understand/theme-queue.ts`：`createThemeQueue()` 只做调度、不写库。两类任务——命名（`themeId` + 代表时刻）、模糊确认（时刻 + 候选主题）——**串行**执行（任何时刻最多一个请求在途），按入队顺序；`drain()` 等到跑不动为止（空 / 暂停 / 等客户端 / 销毁），给用例与优雅退出用。
- **合并**：同一主题还在排队 → 覆盖代表时刻（调用方每次传当前代表时刻，最后一份最准，返回 `merged`）；同一主题正在命名 → 忽略（`duplicate`，在途响应会覆盖标题，再排一次没意义）；同一时刻不重复排队（排队 + 在途都算，`skipped`）；新的确认时刻并进还没发出的最后一批（`CONFIRM_BATCH_MAX = 20` 一批），少一次请求就少一次出网。`accepted / skipped / dropped` 如实回给调用方，调用方据此决定下一轮。
- **暂停零出网（D18）**：`pause()` 立刻 abort 在途请求，`LlmAbortError` 把任务放回**队首**、结果丢弃（`abortedCalls`），暂停期间只入队不发；`resume()` 按原顺序补，不重扫库、不重复落库。
- **没有客户端 ≠ 请求失败**：请求失败走 `nameTheme()` 的兜底 / `confirmThemeAssignments()` 的 pending，回调照发（主题照建、时刻留到下一轮）；没有客户端（D24 门没确认 / 缺 key）则任务留在队首、零请求（`waitingClient`），等调用方 `wake()`——否则会给主题落一个**永远补不回来**的兜底标题。
- **上限**：排队时刻数默认 200（`THEME_QUEUE_DEFAULTS.maxPendingMoments`，命名按代表时刻数算），满了只收放得下的、其余如实返回 `dropped`，由调用方下一轮再试；回调抛错只记一行日志，不拖垮后面的任务。
- 计数只供日志 / 状态行（不记正文）：`calls / promptTokens / completionTokens / skippedMoments / droppedMoments / mergedJobs / failures / abortedCalls`。预算 / 退避沿用 D22，S6 接线时套在这一层外面。
- 单测 13 条（`tests/unit/theme-queue.test.ts`：串行与顺序 / 回调容错 / 暂停零请求与恢复补发 / 在途取消丢弃并重做 / 暂停期间继续入队仍按序 / 同主题命名合并 / 同时刻排队与在途去重 / 20 条分批 / 上限 dropped / 缺客户端留住 + wake / 请求失败只影响一条 / 销毁后不再发）。

**S6 接线 / 开关 / 与「补历史」共存 实施（2026-10-25，P2 第 6 步；在线闭环真正跑起来）**

- **运行时** `src/main/theme-online-runtime.ts`：采集 `running` 时每 60s 一轮（与时刻补跑同频），只跟采集状态走（暂停即停定时器）。一轮 = ① 给还在等命名的主题重排队（进程重启后靠库里的标记补回来）② 选最近 2 天、`theme_moments` 里还没有归属的时刻 ③ 只给这些时刻的成员事件补事件向量（`event_embeddings` 里已有的不重算）④ `assignMoment()` 本地判定 ⑤ 按结果落库 / 建主题 / 排队确认 ⑥ 刷新派生数据。A3：没建过库不为定时器建库。embedding 是主进程开销，一轮最多 20 个时刻（`ONLINE_MAX_MOMENTS_PER_TICK`）。
- **业务层** `src/understand/theme-online.ts`（不碰 Electron、便于单测）：`selectOnlineMoments()` / `persistAssignment()` / `createOnlineTheme()` / `applyNamingToNode()` / `applyAssignmentDecision()` / `refreshOnlineThemeCentroid()`。三条硬约束：**不重复**（`theme_moments` 有行谁也别再写）、**不丢追溯**（主归属写入时同步扩展 `nodes.ts_start/ts_end` 并把成员事件并进 `source_events`；次归属只写关系）、**命名可补**（新主题先落本地兜底标题 + `meta_json.namePending`，模型命名回来覆盖；重启后 `selectPendingNameThemes()` 还能捞回来——队列只在内存里，不能只靠它）。已合并主题的候选会跟随到存活根；确认结果里给了 `new_title` 就直接当名字用，不再多花一次命名调用。
- **开关**：settings `graph.online_themes`（默认 `1`），设置抽屉「新数据即时归主题（在线）」复选框。「在线路径可用」= 开关开 **且** 本地向量模型就绪（模型没装时算不出向量，自动批量归纳仍是唯一建主题路径，G5 不变）。
- **与「补历史」共存**：在线路径可用时**自动**批量归纳让位（`InductionService.shouldAutoRun` → `status='skipped', reason='online'`），手动「立即归纳」保留为补历史 / 调试（D28/D29）。两条路径互相跳过对方处理过的数据：在线路径跳过「事件已进节点 `source_events`」的时刻（自动归纳前一步先到），批量归纳跳过「`theme_moments` 已有归属」的事件（`cloud/batch.ts` 新增 `readAssignedEventIds`）——同一天不会被两条路径各建一次主题。
- **暂停 / 授权 / 预算 / 退避（D18 / D22 / D24）**：采集暂停 → 在途 abort + 定时器停；撤销出网授权 → `pauseEgress()` 立刻 abort 在途、本地归属继续；没有客户端（未授权 / 缺 key）→ 队列把任务留住、零请求，每个 tick `wake()` 重试；每日预算（与批量归纳同一份 `readUsage` 记账）用完 → 同样留住、零请求；请求失败 / 输出非法 → 按 `graph.retry_backoff_minutes` 退避并**暂停队列**（只钳制入队不够，已排的会继续打满），退避期间只做本地归属。用量经 `recordUsage` 记进同一份日账。
- **派生数据**：归属写入后只重算被碰过的主题质心（只读该主题自己的成员事件向量，不拉全表）、按文本指纹补标题向量、重建 embedding 边；命名回写同一套。主题 ≥0.95 合并仍只在打开图谱时的回填里做（在线路径不抢跑合并，新主题可能短暂近重复）。
- **单测 26 条**：`tests/unit/theme-online.test.ts` 15（选时刻 / 翻页不被覆盖时刻堵死 / 待命名标记 / 命名回写与合并保护 / 代表时刻 / 主次归属与追溯并集 / 幂等 / 合并跟随 / 确认落库 / new_title / 什么也不给 / 时刻质心 / 单主题质心 / 无向量不写假质心 / 增量事件向量）；`tests/unit/theme-online-runtime.test.ts` 11（无客户端照建主题 + 补 key 后补名 / 命名回写并通知画布 / 同主题一次命名 / 暂停零出网与恢复 / 撤销授权留住任务 / 预算耗尽 / 失败退避不再发 / 模型未就绪仍可命名 / 开关关闭 / 跳过批量已覆盖 / 模糊确认落库）；另 `batch` +1（`theme_moments` 过滤）、`induction-service` +1（online 让位）、`graph-settings` +1（开关读写）。
- **E2E 口径**：`tests/e2e/graph.spec.ts`（旧 sigma 按日页 + 批量归纳）显式 `graph.online_themes=0`——模型随仓库分发后在线路径会抢在「立即归纳」前把种子时刻归好，请求数不再等于批量归纳的 1 次；这条 spec 测的是批量路径，在线路径走 `tests/e2e/graph-online.spec.ts`（S7，见下）。
- **已知边界**：① 一轮并发出现多个「新主题」时刻时各建一个主题（在线聚类粒度 = 一轮一批），后续相似时刻会归进来，近重复等打开图谱时的 ≥0.95 合并收拾；② 在线归属会持续把成员事件并进 `source_events`（兼容字段），长期会变大；③ 模型就绪后的历史积压按 20 个时刻/分钟消化，一天几百个时刻要跑一阵；④ 时刻若被批量归纳部分覆盖（事件交集），在线路径整条跳过，留作「待归属」空心点。

**S7 在线路径 E2E 实施（2026-10-25，P2 第 7 步；全链路验收闭环）**

- **假向量注入** `src/main/fake-embedding.ts` + `GOTCHA_FAKE_EMBEDDING=1`：与假采集 / 假 LLM 同一套三条件门（显式开关 + 临时 userData + 非打包态）。实现 `Embedder` 契约（512 维、L2 归一化、确定性）；文本去空白后按字符二元组散列，同一段内容（含 OCR 逐字空格形态）得到同一向量，共享内容越多越相似。模型名 `fake-embedding-v1` 刻意与 `bge-small-zh-v1.5` 分开——库里按 `model` 过滤，假向量不会被当成真向量复用。
- **接线** `src/main/index.ts`：注入后 `readEmbeddingsReady()` 按就绪处理（`onlineThemesActive` 才会让自动批量归纳让位）、`loadGraphEmbedder()` 直接返回假实现（不加载 95 MB 模型）、图谱回填 / 重算经 `createEmbedder` 用同一份假向量；测试钩子新增 `__gotchaTest.onlineTick()`——60s 定时器对用例太慢，直接跑一轮 `runOnce()`，不绕过暂停 / 授权 / 预算门。
- **E2E** `tests/e2e/graph-online.spec.ts`（3 条，独立临时库 + 假采集 + 假 LLM + 假向量；`graph.embedding_model_dir` 故意指向不存在的路径，证明「就绪」来自注入而不是真模型）：
  1. 采集 `running` → `moment-runtime` 补出 2 个时刻 → 在线路径各建 1 个主题、写 `theme_moments`（owner）与 `source_events`；命名经串行队列交给假 LLM 后标题 / 摘要被覆盖、`namePending` 清掉；`event_embeddings` / `node_embeddings` 只有 `fake-embedding-v1`，请求总数恰为 2（两次命名，没有批量归纳抢跑）。
  2. 打开图谱（2 主题 / 2 时刻、无模型缺失黄条）→ 再落一个与时刻 1 文本相同的新时刻 → `onlineTick()` 直接归到已有主题（`assigned:1 / created:0 / ambiguous:0`、请求数不变、`source_events` 并集），主进程推 `graph:changed` → 画布**就地刷新**成 2 主题 / 3 时刻（不重开窗口）。
  3. 暂停采集后再跑一轮 → `skipped: paused`、零请求、新时刻保持待归属（D18）。
- **边界**：命名失败兜底、模糊带确认、预算 / 退避、队列合并等分支仍由 `theme-online-runtime` / `theme-queue` / `theme-naming` 单测覆盖；E2E 只钉「一条链能跑通 + 已有主题归属不再花钱 + 暂停零出网」。测在线路径别拿真模型做断言（见 gotchas）。

## 10. 向量运行时（沿用 v0.2 实测）

- 模型：`bge-small-zh-v1.5`，512 维，CLS pooling + L2；`model.onnx` 94.8 MB；vocab 无英文子词（DeepSeek/API/GUI 等会 `[UNK]`），中文摘要仍提供信号。
- 运行时：`onnxruntime-node`（N-API 预编译）在 Electron 45 主进程实测 3 条短文本 7.2 ms；首次加载约 0.47 s；打包 `asarUnpack`、只留 win32-x64；失败回退 WASM。
- 进程：优先主线程懒加载 + 分块（121 主题/天约 0.3–0.9 s，带进度）；worker_threads 作为可选优化，不作为 P1 前置。
- 模型路径（**2026-10-25 改，D37**）：模型随应用分发，不再是「用户本地资产 + 手工放置」。查找顺序：设置 `graph.embedding_model_dir` → 打包资源 `<resourcesPath>/models/bge-small-zh-v1.5` → 仓库 `<appPath>/resources/models/bge-small-zh-v1.5`（dev）→ `%APPDATA%/Gotcha/models/`（历史位置，兼容）；第一个「就绪」的胜出（`src/understand/embedding/paths.ts`）。仍不自动下载；缺失时顶部黄条明确提示。
- 日志：只记模型名/维度/批大小/耗时/失败码；不记节点文本、向量、路径。
- 详见 `docs/archive/m2-graph-redesign-v0.2.md` §5、§10。

**实施（2026-10-24，PR #38；真机实测）**

- 依赖：`onnxruntime-node@1.30.0`（MIT，N-API 预编译，unpacked ~301 MB 含各平台二进制）；主进程 `await import()` 懒加载，打包时 `asarUnpack`、只留 win32-x64（打包步骤 P3 补）。
- 模型：`Xenova/bge-small-zh-v1.5` 的 `onnx/model.onnx`（fp32，94,851,877 B）+ `vocab.txt`/`config.json`；**2026-10-25 起随仓库分发**：`resources/models/bge-small-zh-v1.5/`（`model.onnx` 走 git-lfs，`vocab.txt` / `config.json` 普通提交；`model.onnx` 仍在目录根，**不是** `onnx/` 子目录）。打包用 electron-builder `extraResources` 带进安装包（M5 落地）；仍不自动下载；BAAI BGE 为 MIT，第三方声明补在打包阶段。
- 分词：自写 `BertTokenizer`（vocab.txt + WordPiece），按 `tokenizer_config.json` 的 `do_lower_case=false`、`tokenize_chinese_chars=true`；不引第三方 tokenizer，用例覆盖中文按字、`##` 续词、截断 512、`[UNK]`。
- 池化：`last_hidden_state` 第 0 位（CLS）+ L2；向量以 Float32 小端 BLOB 存 `node_embeddings`。
- 实测（本机 Windows / Node 24 / 单线程 ORT）：会话加载 357 ms；229 个主题（title+summary）3.6 s（约 16 ms/条，batch 16）；3,141 个成员事件 192 s（约 61 ms/条，OCR 文本长）。
- Electron 45 主进程实测（2026-10-24，临时 E2E）：打开图谱后后台完成 2 个合成主题的 512 维向量 + 1 条 embedding 边——`onnxruntime-node` 在 Electron 里可用，不只是 plain Node。
- 触发：打开图谱窗口时后台跑一次（结构回填永远跑，向量只补缺失），同进程 60s 节流；模型缺失只回填结构、不报错。


## 11. 隐私与安全

- 向量计算全本地，零新增出网；主题命名/模糊确认仍走 `redact.ts` 唯一出口 + D24 确认门 + D18 暂停；
- 日志红线：不记时刻/主题正文、不记向量、不记 prompt/response；
- 模型文件是用户本地文件，不进 git/提交；BAAI BGE 许可在第三方声明注明；
- 本方案不引入 UIA/进程内存采集；若后续加，必须另立方案与隐私边界（密码框跳过、离屏范围、剪贴板默认关）；
- 主题合并/回填是本地数据修改：先备份、可撤销（`node_merges`）、不物理删除源节点。

## 12. 性能与规模

| 项 | 当前/估算 |
| - | - |
| 主题 | 229（v3 回填）/ 230（P3-a 副本，仍在增长） |
| 时刻 | 823 有归属（v3 回填）/ 1,047（P3-a 副本；总池 2,113，含未归纳积压） |
| 主题边 | 216（203 主题，0.64/k4/互选）；171（合并后 158 主题） |
| 活布局 | P3-a 实测 1,277 节点 / 1,322 连线：沉降 3.1–4.9 s；布局中 56–60 fps（P0 2k 数据） |
| 一年 | 按 121 主题/天估算约 4.4 万主题、93 万事件；主题向量约 90 MB/年 |
| 上限 | >2k 时刻顶部提示收窄（阈值可调，默认 2k；已做）/ 上 LOD（M3）；万级主题再上 ANN |

## 13. 测试与验收

### 13.1 单测（全部假向量/假 LLM，零真实模型/网络）

- `moment-builder`：合并窗口、去重、事件 id 可解析；
- `theme-assigner`：主/次归属、近重复排除、模糊带、阈值边界；
- `theme-consolidator`：≥0.95 合并、并集、撤销、幂等；
- `edge-builder`：top-k/互选/阈值/无向去重/增量；
- `graph-distance`：sim↑ distance↓、夹取；
- `graph-states`：dimmed/高亮/时间 focus 组合；
- `calendar`：单日/范围/不连续/预设/空范围（纯函数）；
- `migrations`：v3 up/down/幂等/备份；
- `graph-query`：只返回 embedding 边、degree/成员计数正确、旧 ai 边不出现。

### 13.2 E2E（假采集 + 假 LLM + 假 embedding）

- 全局页（`tests/e2e/graph-global.spec.ts`，2026-10-24）：主题/时刻/相似连线计数；主题下钻成员事件；多归属时刻「也属于」+ 原始事件；日历 `setDays` 调暗后节点数不变、空范围提示；日历真实鼠标（点日期不关弹层 / 拖拽涂抹连续范围 / 快捷范围不关弹层 / `×` 只关弹层）；「只看主题」；沉降后主题坐标回写 `node_positions`；全局页 ↔ 经典页互切。
- 经典页（`tests/e2e/graph.spec.ts`）：确认门、立即归纳落库、下钻 + 时间线定位、设置抽屉、类型显隐、单击/双击语义、暂停零请求。**S6 起这条 spec 显式 `graph.online_themes=0`**：模型随仓库分发后在线路径会在确认出网后抢先归主题，`立即归纳` 不再是唯一的建主题路径；本 spec 测的是批量路径，在线路径走 `graph-online.spec.ts`（S7）。
- 在线路径（`tests/e2e/graph-online.spec.ts`，2026-10-25，S7）：`GOTCHA_FAKE_EMBEDDING=1` 注入确定性假向量（真模型完全不加载，`graph.embedding_model_dir` 故意指到不存在的路径），假采集 + 假 LLM 跑「采集 → `moment-runtime` 落时刻 → 在线归属 / 命名 → 打开图谱 → 新时刻归到已有主题（零额外 LLM）→ 画布就地刷新 → 暂停零出网」。
- 日历 `Ctrl/Cmd+点` 加减、`Shift+点` 扩展：语义由 `calendar.ts` 纯函数用例覆盖；真实鼠标只测了单点与涂抹，这两个组合键的真机手感留 P3-b。
- 模型缺失黄条 / 新主题待算：P3-b → **已上线（#54，2026-10-25）**，E2E 见 `graph-global.spec.ts`「模型缺失：顶部黄条提示…」。
- 阈值控件（合并阈值 / 连线阈值 / 连线数）：E2E 见 `graph-global.spec.ts`「相似度阈值：抽屉可调，保存后落库；模型未就绪时如实说「没重算连线」」+ 经典页「保存不覆盖阈值」断言（2026-10-25）。
- 合并记录撤销：E2E 见 `graph-global.spec.ts`「合并记录：撤销后拆回独立主题，这一对不再自动合并」（种子库里预置一条 `node_merges`：节点 3 → 1；撤销后画布从 4 节点变 5 节点、2 主题变 3 主题，列表清空）；否决语义与「固定点提前退出」单测见 `tests/unit/theme-merge.test.ts`「撤销过的一对不再自动合并」。`tests/unit/graph-ipc.test.ts` 另钉住 5 条通道行为（主 frame 透传 / 非整数 groupId 不落数据层 / 非图谱窗口拒绝 / 抛错降级）。
- 自动归纳后画布刷新：E2E 见 `graph-auto-refresh.spec.ts`「不点「立即归纳」，新主题也会自己出现；时间筛选不被重置」（独立种子库：1 已归纳主题 + 1 条够旧未归纳事件；先 `toggle()` 开假采集、再 `setConsent(true)`，**不点立即归纳**；5s 后调度自己跑完 → 主题 1→2、节点 2→3，且「昨天」筛选与调暗状态原样保留）。主进程侧回调在 `tests/unit/induction-runtime.test.ts`「落库后通知画布刷新」：成功落库才回调，跳过 / 失败不回调。
- 「时刻过多」收窄提示：E2E 见 `graph-global.spec.ts`「时刻过多提示：阈值可调，点「只看主题」后消失」（默认 2k 不提示 → 抽屉把阈值调到 1 → 顶部提示「已显示 2 个时刻（提示阈值 1 个）」→ 点「只看主题」后提示收起、时刻层隐藏 → 阈值改回 2000 后不提示）；纯函数与「渲染层默认＝主进程默认」由 `tests/unit/scale-hint.test.ts` 钉住，设置读写 / 越界拒绝 / 坏值回退见 `tests/unit/graph-settings.test.ts`。
- 原有 26 条 E2E 回归全绿（2026-10-24：33 条）。

### 13.3 验收口径

| # | 验收项 | 方法 |
| - | - | - |
| G1 | 主题可溯 | 10-21 主题仍在；`theme_moments → moments → events` 100% 可解析 |
| G2 | 全局连线 | 同输入重跑边集合一致；存在跨天边（如「任务切换」对） |
| G3 | 距离编码 | 单测 sim↑ distance↓；渲染层不读 weight 改线宽 |
| G4 | 密度可调 | k=3/4/8 边数变化符合预期；阈值滑块次要 |
| G5 | 模型缺失 | 已有向量/边仍画；新主题待算；采集/时间线正常 |
| G6 | 零出网 | embedding 路径无 fetch；LLM 只在确认门后 |
| G7 | 图层 | 默认主题+时刻；原始事件不上画布；「只看主题」生效 |
| G8 | 找回 | 3 个回忆问题 ≥2 题 90 秒内靠主题/时刻/侧栏/日历找回 |
| G9 | 性能 | 210+800 活布局 ≥30 fps；首屏 ≤2 s；1k/2k 有记录 |
| G10 | 闸门 | `npm test` + `typecheck` + `build` + `test:e2e` 全绿 |
| G11 | 主题合并 | 127 对 ≥0.95 处理完；无成员丢失；可撤销 |
| G12 | 多归属 | 共享时刻连 2 主题；次归属不含近重复；侧栏可见 |
| G13 | 时间筛选 | 单日/涂抹/不连续/预设；只调暗不删；空范围有提示 |

## 14. 阶段与工期

| 阶段 | 内容 | 工时 |
| - | - | - |
| P0 | Foam vendor + F1–F13；210 主题 + ~800 时刻的活布局/碰撞/时间 dimmed/日历原型；性能对比 203/1k/2k | 3–4 天 |
| P0.5 | 主题合并（≥0.95）+ 次归属回填 + 重新标定阈值 | 1 天 |
| P1 | schema v3、moments/memberships/embeddings/positions、回填、全局边、查询 DTO | 3–4 天 |
| P2 | 在线 assigner/labeler/consolidator、LLM 新簇/模糊确认、暂停/队列 | 3–4 天 |
| P3 | 主题/时刻 UI、日历、设置、E2E、验收、文档 | 3–4 天 |

- 先做 P0+P0.5+P1+P3（用现有归纳数据出图），7–9 天；P2 再 3–4 天。
- 进度：P0 ✅（#36）；P1 ✅（数据层 #37；向量回填 + 打开图谱后台回填 #38）；P0.5 ✅（合并固定点 + 次归属 + 阈值重标定，schema v4）；P3-a ✅（2026-10-24：`graph:global` / `graph:moment-events` / `graph:positions:save`、默认全局 Foam 页 + 日历调暗 + 时刻「也属于」、旧 sigma 页开关）；P3-a 追加 ✅（#50：日历内嵌时段滚轮 + 输入即筛图谱、点「检索」才出卡片）；P2 在线化 S1 ✅（#67 时刻在线化）、S2 ✅（#68 归属引擎）、S3 ✅（#69 增量向量维护，schema v6）、S4 ✅（2026-10-25 命名 + 模糊确认两条 LLM 调用与兜底）、S5 ✅（2026-10-25 串行队列 / 暂停零出网 / 恢复补发）、S6 ✅（2026-10-25 在线归属运行时接线 + `graph.online_themes` 开关 + 与补历史共存）、S7 ✅（2026-10-25 在线路径 E2E：假向量注入 + 采集→时刻→归属/命名→画布刷新一条链）。
- 检索（提案门一）✅ v1（#48）：`events_fts`（trigram，归一化文本）+ 三触发器同步 + v5 迁移回填，双路查询（MATCH ≥3 字 / LIKE 兜底），结果按时刻卡片呈现；未归纳事件同等可查。
- 仍需补：打包 `asarUnpack` 与第三方声明、P3-b 余下的 LOD（归 M3，当前只做「时刻过多」提示 + 阈值可调）、门一 20 题回忆基线真机验收（协议 / 模板 / 计分脚本已备：`docs/gate-one-recall-baseline.md`、`scripts/recall-baseline.mts`；20 题题集与 A/B 两轮真机跑待拍板人，跑完才谈门一验收）。
- **开工前**：先合 PR #34（`feat/graph-interactions`，含 D28 与单击/双击语义），再从 main 切 `feat/graph-foam-global`；不要从当前 main 直接切（缺 D28）。

## 15. 风险与回退

| 风险 | 影响 | 缓解 |
| - | - | - |
| Foam patch 多、位置/碰撞/调暗互相影响 | 高 | P0 先 harness；F1–F13 分小提交；UPSTREAM + 测试 |
| 活布局 + 2.7k 事件卡顿 | 中 | 点用时刻（500–800）；默认关原始事件；>2k 提示收窄 |
| 主题近重复导致多归属失真 | 高 | 先合并 ≥0.95；次归属排除 ≥0.92；合并后可撤销 |
| 事件/时刻向量信号弱 | 中 | 主归属优先；次归属高置信；LLM 只确认模糊带 |
| LLM 调用变多 | 中 | 只在新主题/模糊带；20 个时刻/批；预算沿用 D22 |
| 迁移/回填破坏用户库 | 高 | 迁移前备份；up/down/幂等；回填可重入；不物理删节点 |
| 旧 ai 边残留 | 低 | 查询过滤；显式清理另开操作 |
| Foam 升级分叉 | 低 | 固定 commit；补丁标记；不追上游 |

**回退**：主题/时刻/边在本地库；渲染层可回退到旧 sigma 读同一份 nodes/edges；embedding 表不影响采集/时间线；P2 未上线时批量归纳仍可用。

## 16. 已拍板与待定

**已拍板（2026-10-24）**

| # | 决定 |
| - | - |
| 1 | 不做 3D；保留 Foam 2D 与活布局/惯性/粒子/标签动效 |
| 2 | 单一全局图；时间只筛选/调暗，不按天换图 |
| 3 | 主题节点 + 时刻点；时刻默认显示，可切「只看主题」 |
| 4 | 时刻可多归属；不做背景主题圈/韦恩几何 |
| 5 | 点 = 时刻；主题合并 ≥0.95 自动（可撤销）；次归属 ≥0.80 且排除近重复 |
| 6 | LLM 只做新主题命名/模糊确认/提示文案；不做批量节点/边 |
| 7 | 日历 popover；单日/涂抹/Ctrl 加减/前 3/7/30 天/全部 |
| 8 | 控制面板隐藏；用现有设置抽屉 |

**待定（P0 决定）**

- 局部聚焦：选中+调暗（默认）还是 `graphScope` 删节点；
- ~~首屏默认「全部」的节点上限（2k/3k）与 LOD 文案~~ → 2026-10-25 结案：上限做成设置 `graph.scale_hint_moments`（默认 2k），「时刻过多」提示上线；LOD 文案随 M3 分层视图一起定；
- 主题-主题边是否默认显示，还是只在「只看主题」时显示；
- 成员边默认透明度（不可见 vs 0.05）。

**另立方案**：采集层 UIA / 进程内存读取（不属本文件；内存读取仅实验性/可选，不进默认路径与验收）。

## 17. 核对记录

```text
# 数据（2026-10-24 凌晨只读快照；应用仍在归纳，数字会变）
主题：203–210 个（10-21 121 / 10-22 41 / 10-23 25 / 10-24 新增）
成员事件：2,689 个（被主题 source_events 引用）
全局边（203 主题，0.64/k4/互选）：216 条；跨天 72；孤立 34；平均度 2.13
全局边（k8）：421 条；跨天 160；孤立 16
阈值 0.60/0.62/0.66/0.68（k4）：222/219/213/204
主题近重复：≥0.90 473 对；≥0.95 127 对（主题质心）
事件 top1 = 所属主题：20.6%
主题均值质心：0.78 阈值下 95% 事件匹配 ≥2 主题（不可用）

# Foam
commit 3a3662d1fff122e2701d7fb43adb70d9087d9bc3（2026-10-23）
@foam/graph-view 0.40.0，MIT；lit ^3 / force-graph ^1.51 / d3-force ^3 / d3-scale / d3-color
links 类型只有 source/target；createGraphModel 用展开复制，运行时 weight 可保留
lineWidth 已是常数；lessened 透明度 0.05；节点尺寸按 degree；无双击；无位置 seed

# P0 harness 实测（2026-10-24，本机 Windows / Electron 45；合成数据；.tmp/harness-check.mjs）
base 210 主题 + 800 时刻：1010 节点 / 1344 连线，沉降约 3.1 s，布局中 60 fps
1k（500 + 500）：沉降约 3.0 s，布局中 60 fps
2k（1000 + 1000）：沉降约 3.4 s，布局中 56 fps
日历单日（10-23：8 主题 / 17 时刻）：调暗 985 / 1010 个节点，节点数不变；双击主题开侧栏；「只看主题」剩 210 节点
调暗/高亮只改透明度、不删节点；相机按 focused 子集包围盒适配（空范围不移动）

# v3 回填预演（2026-10-24，真实库只读副本 .tmp/realdb，只跑结构回填、未算向量）
events 7,423；level=1 主题 229；旧 ai 边 201
时刻 1,949（4 个本地日；含未被任何主题覆盖的事件）；owner 归属 828；缺失事件 id 0
全局 DTO：主题 229 / 有归属时刻 823 / 归属 828 / embedding 边 0（未算向量）/ 位置 0
悬空时刻 1,126（10-21~10-24 未归纳的积压，D28 只自动归纳今天）
首次回填 536 ms（含迁移）；重跑新增 0（460 ms）
> 时刻数 1,949 明显高于 §12 的 500–800 估算：那是我按 2,689 个「成员事件」估的，实际池子是全部事件。画布上默认只画有归属的 823 个时刻，仍在 §12 目标内。

# 模型（沿用 v0.2）
bge-small-zh-v1.5 512d；model.onnx 94,851,877 B；Electron 45 主进程 3 条 7.2 ms；首次加载约 0.47 s

# 向量回填 + 边实测（2026-10-24，真实用户库就地回填，备份 .tmp/userdb-backup-*；PR #38）
模型：Xenova/bge-small-zh-v1.5 的 fp32 ONNX（94,851,877 B）+ vocab.txt；onnxruntime-node 1.30.0
会话加载 357 ms；229 个主题（title+summary）3.6 s（约 16 ms/条，batch 16，单线程）
首跑总耗时 4.4 s（含结构回填 1,949 时刻 + 828 归属）；重跑 661 ms、0 新增、边替换 247→247
embedding 边（0.64/k4/互选）：247 条；跨天 87；孤立 40
k3/k4/k8：178 / 247 / 500；阈值 0.60/0.62/0.66/0.68/0.70（k4）：248/247/244/234/221
相似度：中位 0.5024；top 0.9966（「GUI按钮悬停与卡顿修复草案」vs「…讨论」）
近重复（≥0.95）：title+summary 13 对 / 16 主题；成员事件质心 174 对 / 22 个分量 / 108 主题（合并用质心，见 §5.1）
事件级 embedding：3,141 条 192 s（约 61 ms/条，OCR 文本长，单线程）

# P0.5 合并/次归属（2026-10-24，真实库副本 `.tmp/realdb-merge`，schema v4）
副本：229 主题 / 3,141 成员事件 / 823 个有归属时刻；事件向量 3,137 条（4 条空文本不算）
事件向量：256 token / 4 线程 / batch 32 ≈ 42–45 ms/条，约 2 分 10 秒一次性后台（8 线程更慢 65.7 ms）
合并相似度（256 token 质心）：@0.90 378 对 / @0.95 100 对 / @0.99 21 对；title+summary 为 40 / 13 / 1
合并固定点：2 轮，37 组 / 71 个源节点，229 → 158 主题；成员事件并集仍 3,141；owner 828 → 823（5 个冲突时刻保留目标那条）
撤销：37 组全部回滚后回到 229 主题 / owner 828 / 成员事件 3,141
次归属：0.80 时 787/822 个时刻有非主归属候选；0.92+0.92 排除后 78/823 个时刻、103 行（0.93 为 45/57）
合并后 embedding 边（158 主题，0.64/k4/互选）171 条；第二次运行 0 合并、0 新向量、次归属 0 增 0 删、边 171→171
全流程（不含首次事件向量）约 3.8 s；第二次约 5.4 s（含边全量替换）

# P3-a 全局页真机副本冒烟（2026-10-24；better-sqlite3 backup() 复制用户库，未碰原库）
副本：230 主题 / 2,113 时刻（其中 1,047 个有归属、画布默认只画这些）/ 1,151 条归属 / 171 条相似边
画布：1,277 节点 / 1,322 连线；沉降 3.1–4.9 s；230 条主题坐标回写 node_positions（副本）
说明：用户库仍在增长，副本数字每次会变；只读浏览不要求密钥 / 模型

# 采集层（另立方案，仅记录）
UIA 本机探针：焦点 Document，TextPattern=True；全文 37,349 字符 vs 可见 4,401 字符（83 段）
```

## 18. 变更记录

| # | 日期 | 变更 | 依据 |
| - | - | - | - |
| 1 | 2026-10-23 | v0.1：Foam 兼容 Sigma 草案 | 拍板人 |
| 2 | 2026-10-23 | v0.2：Foam 内核 + 本地向量连线 + 距离编码 + 事件默认不上画布 | 对话 / D27 |
| 3 | 2026-10-24 | v0.3：全局图 + 主题节点/时刻点 + 多归属 + 时间 popover；撤销 3D/主题圈/批量 LLM 边；保留 Foam 活布局；新增 D29 | 2026-10-24 对话 |
| 4 | 2026-10-24 | v0.4：P0.5 主题合并固定点 + 次归属回填 + schema v4（事件向量/质心/合并审计）；阈值重标定 | §5.1 标定 / 真实库副本 |
| 5 | 2026-10-24 | P3-a：默认全局 Foam 页（`graph:global`）、时刻下钻 / 「也属于」（`graph:moment-events`）、沉降坐标回写（`graph:positions:save`）、日历调暗、旧 sigma 页保留互切；移除 P0 harness | §7.4 / §8 / §13.2 实施 |
| 6 | 2026-10-24 | 日历 popover 交互修复：点日期不再关弹层（外部点击判断改捕获阶段）、拖拽涂抹稳定（构建/重绘分离）、头部新增 `×` 只关弹层；补真实鼠标 E2E | §8 / §13.2 |
