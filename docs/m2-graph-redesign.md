# 图谱重做方案 v0.3 · 全局主题图 + 时刻层 + 时间筛选

> 状态：**草案 v0.3（2026-10-24）· 按拍板人 2026-10-24 决定重写 · 未动代码**
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

## 4. 数据模型（schema v3）

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

### 4.4 边

- `edges(kind='embedding')`：主题↔主题相似边，`weight=sim`，`evidence` 存 `{model, threshold, topK, mutual}`。
- 主题↔时刻的成员边**不进 edges 表**，由 `theme_moments` 现算；只在力布局/高亮时用，默认画得很淡或不可见。
- 旧 `kind='ai'` 边保留不删，查询默认 `kind='embedding'`；显式清理另开操作。

### 4.5 迁移 v3

- 建表 + 索引；up/down/幂等；文件库迁移前自动备份（沿用 Phase 0 流程）。
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

### 5.2 主归属 + 次归属

对新时刻 `m`：

1. 计算 `sim(m, 每个主题向量)`，取 top-k；
2. **主归属**：`argmax` 且 `sim ≥ 0.78`；若 top1 与 top2 差距 `<0.03`，先走 LLM 确认再落库；否则新建主题（LLM 命名）；
3. **次归属**：其他主题 `sim ≥ 0.80`，且该主题与主主题的主题间相似度 `< 0.92`（排除近重复变体），最多 2 个；
4. **模糊带**（0.76–0.80，或多个候选差距 <0.03）：LLM 批量确认，每批 20 个时刻，返回 0–3 个主题 id 或 `new`；
5. 写入 `theme_moments`：主归属 `source='owner'`，次归属 `source='secondary'`；权重 1.0（力布局等权，避免把共享时刻拉偏）。

> 存量时刻（已有 `source_events` 归属）以现有 owner 为主归属，不重跑向量；新时刻才用向量 argmax。实测事件文本的 top1 与既有 owner 只有 20.6% 一致，**不能盲信 argmax**；top1/top2 差距小或跨类型时交给 LLM。

阈值全部进 settings，初始值：

| 键 | 默认 | 说明 |
| - | - | - |
| `graph.theme_new_min_sim` | `0.78` | 低于它新建主题 |
| `graph.theme_member_min_sim` | `0.80` | 次归属最低相似度 |
| `graph.theme_duplicate_sim` | `0.92` | 与主主题达到它视为近重复，不做次归属 |
| `graph.theme_merge_sim` | `0.95` | 自动合并阈值 |
| `graph.theme_secondary_max` | `2` | 次归属上限 |
| `graph.edge_min_sim` | `0.64` | 主题间连线阈值 |
| `graph.edge_top_k` | `4` | 每主题最多邻居数 |
| `graph.edge_mutual` | `1` | 互选 |

> 这些是初值，必须在合并后的真实主题集上重新标定；不要直接套 v0.2 的 node→node 数字。

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
- 模型不可用：已有向量/边继续画，顶部黄条「新主题暂无法计算」；不把图清空。

## 8. 时间筛选

- **形态**：图谱窗口工具栏的日历 **popover**（不是独立 OS 窗口）。
- **交互**：点=单日；拖=涂抹连续范围；`Ctrl/Cmd+点`=加/减某天（支持不连续）；`Shift+点`=扩到该天；快捷「今天 / 前 3 天 / 前 7 天 / 前 1 月 / 全部」。
- **日格**：显示当天主题/时刻/事件量（热力点）；归纳未跑完的天用空心点；tooltip 给计数。
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

- 队列串行；同一主题/时刻在途则合并；暂停时本地 embedding/分配继续，LLM 调用排队，恢复后补（D18 仍零出网）；
- LLM 调用只发生在「新主题」与「模糊归属」，不逐事件；每批最多 20 个时刻；
- 预算/退避/间隔沿用 D22 settings；用量只记 calls/tokens/耗时，不记正文。

### 9.2 补历史（保留）

- 现有批量归纳（20 时刻/批，输出节点+边）保留为「补历史」工具，用于没有主题的旧日子；
- 补完后：生成 moments/memberships、embedding、全局边；旧 `ai` 边隐藏；
- 不再作为新数据的自动主路径；D28 的按日按钮保留为补历史/调试。

### 9.3 LLM 输出

- 命名：`{title≤24, summary≤80, type: knowledge|activity}`（单主题）；校验器复用/裁剪 `structure/schema.ts`；
- 模糊确认：`{assignments: [{moment_id, theme_ids[0..3], new_title?}]}`；只给候选主题与时刻摘要；
- 提示文案（后续 M4）：一句话「你 X 天前也做过类似的 Y」；不决定是否入图。

## 10. 向量运行时（沿用 v0.2 实测）

- 模型：`bge-small-zh-v1.5`，512 维，CLS pooling + L2；`model.onnx` 94.8 MB；vocab 无英文子词（DeepSeek/API/GUI 等会 `[UNK]`），中文摘要仍提供信号。
- 运行时：`onnxruntime-node`（N-API 预编译）在 Electron 45 主进程实测 3 条短文本 7.2 ms；首次加载约 0.47 s；打包 `asarUnpack`、只留 win32-x64；失败回退 WASM。
- 进程：优先主线程懒加载 + 分块（121 主题/天约 0.3–0.9 s，带进度）；worker_threads 作为可选优化，不作为 P1 前置。
- 模型路径：`graph.embedding_model_dir` → `%APPDATA%/Gotcha/models/...`；不自动下载；缺失时明确提示。
- 日志：只记模型名/维度/批大小/耗时/失败码；不记节点文本、向量、路径。
- 详见 `docs/archive/m2-graph-redesign-v0.2.md` §5、§10。

## 11. 隐私与安全

- 向量计算全本地，零新增出网；主题命名/模糊确认仍走 `redact.ts` 唯一出口 + D24 确认门 + D18 暂停；
- 日志红线：不记时刻/主题正文、不记向量、不记 prompt/response；
- 模型文件是用户本地文件，不进 git/提交；BAAI BGE 许可在第三方声明注明；
- 本方案不引入 UIA/进程内存采集；若后续加，必须另立方案与隐私边界（密码框跳过、离屏范围、剪贴板默认关）；
- 主题合并/回填是本地数据修改：先备份、可撤销（`node_merges`）、不物理删除源节点。

## 12. 性能与规模

| 项 | 当前/估算 |
| - | - |
| 主题 | 210（2026-10-24 快照，仍在增长） |
| 时刻 | 由 2,689 个成员事件生成，约 500–800（估算） |
| 主题边 | 216（0.64/k4/互选；72 跨天；34 孤立） |
| 活布局 | 210 主题 + ~800 时刻 + ~1k 成员边：目标 ≥30 fps；P0 实测 |
| 一年 | 按 121 主题/天估算约 4.4 万主题、93 万事件；主题向量约 90 MB/年 |
| 上限 | >2k 时刻提示收窄/上 LOD；万级主题再上 ANN |

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

- 主题/时刻计数；「只看主题」切换；
- 单击聚焦/双击侧栏/背景退出；
- 日历单日、涂抹、快捷、Ctrl 加减；dimmed 数量正确，节点不消失；
- 多归属时刻在侧栏显示「也属于」；
- 模型缺失：扭节点 + 黄条 + 不崩；
- 暂停：零新增 LLM 请求；本地分配不阻塞；
- 原有 26 条 E2E 回归，选择器 `#graph-container` / `foam-graph`。

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
- 进度：P0 ✅（#36）；P1 数据层 ✅（v3 schema + 回填编排 + 全局查询 DTO，#37）；P1 剩余 = 向量回填 + 启动接线；P0.5 依赖向量运行时。
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
- 首屏默认「全部」的节点上限（2k/3k）与 LOD 文案；
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

# 采集层（另立方案，仅记录）
UIA 本机探针：焦点 Document，TextPattern=True；全文 37,349 字符 vs 可见 4,401 字符（83 段）
```

## 18. 变更记录

| # | 日期 | 变更 | 依据 |
| - | - | - | - |
| 1 | 2026-10-23 | v0.1：Foam 兼容 Sigma 草案 | 拍板人 |
| 2 | 2026-10-23 | v0.2：Foam 内核 + 本地向量连线 + 距离编码 + 事件默认不上画布 | 对话 / D27 |
| 3 | 2026-10-24 | v0.3：全局图 + 主题节点/时刻点 + 多归属 + 时间 popover；撤销 3D/主题圈/批量 LLM 边；保留 Foam 活布局；新增 D29 | 2026-10-24 对话 |
