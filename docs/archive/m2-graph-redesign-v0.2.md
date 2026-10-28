# 图谱重做方案 v0.2 · Foam 内核 + 本地向量连线

> 状态：**草案 v0.2（2026-10-23）· 按拍板人当日指令重写 · 未动代码**
> 已定方向（拍板人）：① 图谱按 Foam 重做，Foam 源码可以改；② 连线由本地 `bge-small-zh-v1.5` 向量相似度计算；③ 相关度只用**距离**编码，不用线宽；④ 旧图谱决策全部归档，重新设计。
> 事实源：本文件；决策 D27。v0.1（Foam 兼容 Sigma 的草案）已归档至 `docs/archive/m2-foam-graph-draft-v0.1.md`。

## 0. 一句话

**LLM 只负责把事件归纳成节点；节点之间的线由本地向量模型算相似度，相似的靠得近、不相似的分得开；画布用 Foam 的 graph-view，事件节点默认不画，点开节点看成员事件。**

这是一次**数据源 + 视觉编码 + 渲染内核**三处同时换，不是给 Sigma 打补丁：

| 维度 | 旧方案（已归档） | 新方案 |
| - | - | - |
| 画布 | sigma.js + Graphology + FA2 | Foam `@foam/graph-view`（Lit + force-graph，可改源码） |
| 连线依据 | LLM 在归纳 JSON 里输出边 | 本地向量余弦相似度，LLM 不再输出边 |
| 相关度编码 | 线宽 + 布局距离双重编码（D8） | **只用距离**；线宽统一，不再编码 |
| 事件节点 | 全量事件叶节点上画布 | 默认不画；侧栏下钻 / 可选开关 |
| 节点尺寸 | log(degree) 6–22px | 证据量 `sourceCount` 对数映射 6–22px |
| 隐私 | 出云归纳（D24 确认门） | 节点归纳仍出云；**向量计算全本地** |

## 1. 为什么重做（旧方案的真实问题）

1. **LLM 连边不可控**：边是 LLM 在一次 JSON 里顺带判断的，受批窗口、prompt、模型随机性影响；同一批事件重跑可能得到不同边，且无法解释「为什么这两点相关」。
2. **线宽不是好通道**：D8 的「线宽 ∝ weight」在人眼上是弱定量通道，9 档 weight 映射到 1.8–4.2px，差异既不明显又容易被误读；真正适合表达「远近」的是布局距离。
3. **事件全量上画布是负担**：10-22 有 2,029 个事件、0 个概念节点，旧实现会画 2k 个孤立点；这些点没有语义连线，对「找东西」帮助很小。
4. **Sigma 的自绘逻辑越堆越厚**：hover reducer、标签、相机、尺寸、边宽都在 `graph.ts` 里手写；Foam 已经把这些做成组件，而且源码可改。

新方案把「相关」从 LLM 手里拿走，交给**确定、可复现、全本地**的向量模型；LLM 只做它擅长的「把事件概括成节点」。

## 2. 目标与非目标

**目标**

- 每天归纳出的概念节点之间自动连线；相似度越高，布局距离越近；
- 连线完全本地计算，零出网、零 API 成本、可复现；
- 画布按 Foam 重做，保留 1 跳邻域高亮、点击下钻、局部图、类型过滤；
- 事件默认不上画布，性能与可读性同时解决；
- 模型缺失/加载失败时**显式提示**，不静默降级、不阻塞时间线与采集。

**非目标（本版不做）**

- 不替换 LLM 节点归纳（仍由 DeepSeek 产出 L1 知识/行为节点）；
- 不做事件级 embedding、不做事件之间连线；
- 不做跨天节点合并/别名（相似节点先以「靠近的簇」呈现，合并留 M3）；
- 不做跨天全局图：M2 仍按本地日构图，边只在同一天的节点之间计算；跨天连线/全局视图留 M3；
- 不做 ANN 向量索引（63–几百节点暴力算足够；万级再上 sqlite-vec）；
- 不做 L2/L3 分层记忆（仍归 M3）。

## 3. 总体架构

```
采集事件 events
   │
   ├─(出云，D24 确认门) LLM 归纳 → nodes（只出节点，不出边）
   │
   └─ 本地向量服务（worker，ONNX）
         nodes.title + summary → bge-small-zh-v1.5 → node_embeddings(vec BLOB, 512d)
                                                        │
                                     cosine + top-k + 阈值 + 互选
                                                        ▼
                                              edges(kind='embedding', weight=sim)
                                                        │
                              按日只读查询（kind='embedding'）│
                                                        ▼
                                    graph-adapter → FoamGraphData
                                                        ▼
                             <foam-graph>：distance = f(sim)，线宽固定
```

- 主进程只多一个**只读/本地**的 embedding 服务，不新增出网；
- `graph:query` IPC 契约不变，只改返回的边来源（kind 过滤）；
- SQLite 仍是唯一事实源，模型文件不进库、不进 git。

## 4. 数据与 schema（v3）

### 4.1 新表

```sql
CREATE TABLE IF NOT EXISTS node_embeddings (
  node_id    INTEGER PRIMARY KEY,    -- 不加 FK：库未开 foreign_keys，节点删除时显式清理
  model      TEXT NOT NULL,          -- bge-small-zh-v1.5
  dim        INTEGER NOT NULL,       -- 512
  vec        BLOB NOT NULL,          -- Float32Array，已 L2 归一化
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
```

- 512 × float32 = 2 KB/节点；1 万节点约 20 MB，可接受。
- `vec` 存归一化后的向量，余弦 = 点积，省一次除法。
- 当前没有删除节点的产品路径；将来加删除时，在同一个事务里 `DELETE FROM node_embeddings WHERE node_id = ?`（不依赖未开启的 FK）。
- 迁移 v3：建表 + 索引；up/down/幂等；文件库迁移前自动备份（沿用 M2 Phase 0 的备份流程）。

### 4.2 边

- 新边写入 `edges`：`kind='embedding'`，`weight=sim`（0–1），`evidence` 存 `{model, threshold, topK, mutual}`。
- 旧 `kind='ai'` 边**保留不删**，`queryGraphDay` 只读 `kind='embedding'`；这样可回滚、可对比，也不会破坏旧数据。
- `degree` 按新边重算；`source_events`、`evidence` 等原有字段不动。
- 后续如需清旧边，走单独的显式确认操作，不在迁移里删。

### 4.3 settings（新增，全部有默认值）

| 键 | 默认 | 说明 |
| - | - | - |
| `graph.embedding_model_dir` | 空（首次引导选择） | 模型目录；含 `model.onnx` / `tokenizer.json` / `config.json` |
| `graph.edge_min_sim` | `0.64` | 余弦阈值，低于不连 |
| `graph.edge_top_k` | `4` | 每个节点最多保留的邻居数 |
| `graph.edge_mutual` | `1` | 是否要求互选（双方都在对方 top-k） |
| `graph.show_events` | `0` | 是否把事件叶节点画上画布 |

## 5. 本地向量服务

### 5.1 运行时（已在本机验证）

| 方案 | 组成 | 结论 |
| - | - | - |
| **A（推荐）** | `onnxruntime-node` + `@huggingface/tokenizers`（纯 JS） | 已在 **Electron 45 主进程**实测：加载 `model.onnx`，3 条短文本一次推理 **7.2 ms**；Node 24 下 6.1 ms |
| B（回退） | `onnxruntime-web`（WASM）+ 同一 tokenizer | 不引原生模块，但慢一些、wasm 文件要随包分发；A 不通过时再用 |
| C（否决） | 调 AI_Companion 的 Python/venv | 需要 Python 运行时，打包与进程管理都不可接受 |

补充实测：

- 模型：BERT 4 层、hidden 512、`last_hidden_state`，输入 `input_ids` / `attention_mask` / `token_type_ids`，输出取 `[:,0,:]`（CLS pooling）+ L2 归一化；
- `onnxruntime-node@1.30.0` 解包约 **301 MB**（含多平台二进制），模型 **94.8 MB**；打包需只保留 win32-x64 并 `asarUnpack`，这是本方案最大的体积项；
- tokenizer 用 `@huggingface/tokenizers`（Apache-2.0，约 8 KB gzip），传 `tokenizer.json` + 最小配置（`model_max_length: 512`、`pad_token: '[PAD]'`）即可，不依赖 `tokenizer_config.json`；补齐/截断在代码里做；
- **已知限制**：bge-small-zh 的 vocab 没有英文子词，`DeepSeek` / `API` / `GUI` / `RustDesk` 会变 `[UNK]`（已实测）；中文摘要仍能提供信号，但纯英文标题的向量质量会下降。长期可换 bge-m3，本版先接受并记录。

### 5.2 进程模型

- **worker_threads**（主进程内）而不是主线程直接跑：模型加载/批量推理不阻塞 IPC 与窗口；
- worker 加载原生模块失败时回退主线程串行（63 节点仍 <1 s），并在日志记一次 `embedding_worker_fallback`；
- 队列串行，批量 ≤32 条；同一 node 已在队列中则合并；
- 模型懒加载：第一次需要 embedding 时加载，失败置 `error`，不反复重试；
- 关闭应用时 `worker.terminate()`，不残留 ONNX session。

### 5.3 模型路径与降级

1. 读 `graph.embedding_model_dir`；
2. 为空则查 `%APPDATA%/Gotcha/models/bge-small-zh-v1.5`；
3. 仍为空则图谱页显示「未配置向量模型」+ 设置入口；**不自动去 HuggingFace 下载**（零出网）；
4. 文件缺失 / 维度不是 512 / 加载异常：状态 `error`，图谱只画节点不画边，顶部黄色提示原因；采集、时间线、归纳不受影响；
5. 本机现有目录 `C:\Users\HP\AI_Companion\models\bge-small-zh-v1.5` 只作为**首次配置的推荐值**，不硬编码进代码。

### 5.4 日志

只记：模型名 / 维度 / 批大小 / 耗时 / 失败码；**不记节点文本、不记向量、不记模型路径**。

## 6. 连线算法

### 6.1 文本

```
text = title.trim() + "。" + summary.trim()
```

- `title` 为空则用 summary；`summary` 为空则只用 title；都空则跳过（不造边）。
- 截断到 512 token（在代码里做；tokenizer 只负责分词）。
- 不加 BGE 的检索 instruction：这里是**对称相似度**（节点对节点），不是 query→passage。

### 6.2 相似度与边策略

- 余弦相似度 `sim = dot(v1, v2)`（向量已归一化）。
- 候选：每个节点取 `sim` 最高的 `topK` 个邻居，且 `sim >= minSim`。
- **互选**（默认开）：只有双方都把对方排进各自 top-k 才保留，能明显压掉「单向蹭热度」的边。
- 无向去重：`(a,b)` 与 `(b,a)` 只留一条，`weight` 取较大值。
- 全量重算（当前 63 节点，O(n²) 可忽略）；**M2 按本地日构图**：只对同一天的节点两两计算，跨天边留 M3；节点新增/标题摘要变更时触发；设置变更时可手动「重新连线」。

### 6.3 阈值标定（真实 63 节点，2026-10-23 实测）

把 63 个节点的 title + summary 用本机模型编码，1,953 个节点对：

| 指标 | 值 |
| - | - |
| 最小 / 中位 / p95 / 最大 | 0.281 / **0.516** / 0.702 / 0.959 |
| 最高的一对 | 「GUI按钮悬停与卡顿修复草案」↔「GUI按钮悬停与卡顿修复讨论」= **0.959** |

> 注意：BGE 中文相似度整体偏高，**不能拿 0.5 当阈值**，否则 63 个节点会连出 1,131 条边（平均 36 度），直接变毛球。

不同策略的边数（63 节点）：

| 阈值 | top-k | 互选 | 边数 | 平均度 |
| - | - | - | - | - |
| 0.60 | 3 | 是 | 48 | 1.52 |
| **0.64** | **4** | **是** | **67** | **2.13** |
| 0.64 | 5 | 是 | 89 | 2.83 |
| 0.66 | 4 | 是 | 65 | 2.06 |
| 0.68 | 4 | 是 | 61 | 1.94 |
| 0.70 | 4 | 是 | 57 | 1.81 |

默认取 **0.64 / top-4 / 互选**：67 条边，平均 2.1 度，肉眼可读；设置里可调，调完即时重算。

### 6.4 距离映射（唯一的相关度编码）

```ts
// t = minSim；dMin / dMax 是图坐标距离，spike 里调
function distanceFromSim(sim: number, t: number, dMin = 45, dMax = 220): number {
  const x = Math.max(0, Math.min(1, (sim - t) / (1 - t)))
  return dMax - (dMax - dMin) * x
}
```

- `sim = t` → 220；`0.8` → 约 142；`0.95` → 约 69；`1.0` → 45；
- `forceLink.distance(link => distanceFromSim(link.weight, t))`；
- `forceLink.strength` 保持常数，**不再用 weight 加吸引**，避免和距离重复编码；
- 线宽统一 `0.8`，透明度 `0.45`；高亮时变色/加亮，但不加粗；
- 低于阈值的边不写入、不渲染。

## 7. 渲染：Foam 内核 + 允许改源码

### 7.1 直接用的能力

Foam 的 `@foam/graph-view`（MIT，`packages/foam-graph`）已经提供：force-graph 画布、1 跳邻域高亮、局部图 `graphScope`、类型显隐、分组、标签淡出、`zoomToFit` / `centerOnNode` / `selectNote`、`node-click` 事件。这些不重写。

### 7.2 要改的地方（源码可改）

| # | 改动 | 原因 |
| - | - | - |
| M1 | `linkWidth` 固定 0.8，不再乘 style/weight | 相关度只走距离 |
| M2 | `forceLink.distance(link => distanceFromSim(link.weight, t))` | 相似度 → 距离 |
| M3 | `forceLink.strength` 常数 | 避免双重编码 |
| M4 | 节点尺寸读 `properties.size`（`sourceCount` 对数 6–22） | 体积表示证据量，不表示相似度 |
| M5 | 事件节点默认 `showNodesOfType.event=false`；开关打开才画 | 2k 事件不上画布 |
| M6 | 事件标签仅 highlighted 时画 | 防止糊屏 |
| M7 | `<foam-graph>` 暴露 `fit()` / `hoverNode()`，透传 `background-click` | 切日、E2E、关侧栏 |
| M8 | 去掉粒子动画，控制面板不 vendor（或中文化后作为「外观」） | 克制、减少维护面 |
| M9 | 主题固定为 Gotcha 暗色，不依赖 VS Code CSS 变量 | 视觉一致 |

- vendor 固定 commit（本机核对：GitCode 镜像 `a7d70d1` / GitHub `3a3662d`，`packages/foam-graph` 文件一致）；
- 保留 MIT 声明 + `foam/UPSTREAM.md`（commit、复制清单、改动清单），改动处用 `// GOTCHA PATCH Mn:` 标记；
- 用户明确允许改源码，因此不再追求「与上游零 diff」；但每次升级仍按 `UPSTREAM.md` 复核。

补丁核心（示意）：

```ts
// graph-canvas.ts（改后）
const t = style.edgeMinSim ?? 0.64
this.graphInstance
  .linkWidth(() => 0.8) // M1：不再乘 weight / multiplier
  .d3Force(
    'link',
    forceLink(this.rs.data.links as any)
      .distance((l: any) => distanceFromSim(l.weight, t)) // M2
      .strength(0.3) // M3：常数，避免双重编码
  )
```

### 7.3 数据适配

- 概念节点：`c:<id>`，`type` = knowledge/activity/protected，`title`，`properties.size`，`tags: []`；
- 事件节点：`e:<id>`，默认不加入 `graphData`（`show_events=1` 时才加）；
- 边：`source` / `target` 为 `c:` / `e:`，`weight = sim`，`kind = 'embedding' | 'sub'`；
- 子边（概念→事件）只在事件层打开时加，`weight` 固定 0.25，不参与相似度；
- 无父事件：事件层打开时才画，不伪造 hub。

### 7.4 UI

- 默认：概念图（63 节点 / 67 条线），工具栏计数改为「N 个节点 · M 条相似连线」；
- 点击概念：复用现有侧栏（成员事件 / 敏感徽标 / 跳时间线）；
- 可选「显示事件」开关：打开才画事件叶节点；
- 设置抽屉新增「图谱外观 / 向量连线」：模型目录 + 状态、阈值滑块、top-k、互选、重新连线；
- 模型不可用：顶部黄条 + 「去设置」按钮，图仍可看节点；
- 空状态：无节点 / 无模型 / 计算中 / 计算失败，文案分开。

## 8. 归纳管线改动

1. **LLM 只出节点**：prompt / schema 去掉 `edges`；校验器只校验节点、`source_events`、标题/摘要长度；少一段输出，token 成本下降。
2. **落库后触发 embedding**：新节点插入事务提交后，入队 `embedNodes(ids)`；完成后对该日/窗口重算边。
3. **节点合并**：现有「同本地日 + 同 type + 归一化标题」合并保留；合并后 title/summary 可能变化 → 重新 embedding + 重算边。
4. **旧 AI 边**：保留、隐藏；`queryGraphDay` 增加 `kind` 过滤（默认 `embedding`），旧 E2E 夹具需要给边加 `kind`。
5. **事件按需拉取**：`show_events=0` 时 `graph:query` 不再 `includeEvents: true`，避免把 10-22 的 2,029 条事件白传渲染进程；打开开关时再按日拉事件（第二次查询）。
6. **失败处理**：embedding 失败不回滚节点、不阻塞归纳；记状态，下一轮重试；图谱仍显示节点。

## 9. 隐私与安全

- **零新增出网**：模型、tokenizer、ONNX 运行时全部本地文件；不调 HuggingFace Hub，不下载模型；
- **节点归纳仍出云**：仍受 D24 一次性确认、D18 暂停即停约束；向量计算不改变这些门；
- **日志红线**：不记节点文本、不记向量、不记 prompt/response；只记计数/耗时/错误码；
- **模型文件**：用户本地文件，不进 git、不进提交；许可随模型卡（BAAI BGE，需在第三方声明中注明）；
- **ONNX 解析**：只加载用户配置目录下的 `model.onnx`，不接受远程 URL；路径由设置注入，不拼 shell。

## 10. 性能与规模

| 项 | 实测/估算 |
| - | - |
| 单批 3 条短文本推理 | Python 3.7 ms / Node 6.1 ms / **Electron 45 主进程 7.2 ms** |
| 首次模型加载 | **约 0.47 s**（tokenizer 33 ms + ONNX session 440 ms，Electron 45 实测） |
| 63 节点一次全量 embedding | 约 0.1–0.3 s（估算，按 6 ms/3 条 + 模型加载；待 P0 实测） |
| 63 节点两两相似度 | 1,953 对 × 512 维，毫秒级 |
| 63 节点 Foam 画布 | 无压力；无 2k 事件节点 |
| 1,000 节点 | embedding 约 2–5 s（worker 后台）；两两 50 万对，可接受 |
| 10,000 节点 | 两两 5,000 万对，需 ANN（M3 再上 sqlite-vec） |
| 包体 | 模型 95 MB + ONNX 运行时（需裁剪 win32-x64）+ tokenizer 8 KB；仅主进程使用 |

> 结论：新方案比「2k 事件全量上画布」轻得多；真正的体积成本是 ONNX 运行时和模型文件，不是渲染。

## 11. 测试与验收

### 11.1 单测

- `embedding-tokenizer.test.ts`：截断/补齐、CLS pooling、L2 归一化、空文本、英文 `[UNK]` 不崩；
- `embedding-service.test.ts`：注入假 ONNX session / 假向量，验证队列、批大小、失败状态、模型缺失；
- `graph-similarity.test.ts`：余弦、top-k、互选、阈值、无向去重、空节点集；
- `graph-distance.test.ts`：距离随 sim 单调、阈值处 = dMax、1.0 处 = dMin、夹取；
- `graph-query.test.ts`：只返回 `kind='embedding'`、degree 重算、旧 `ai` 边不出现；
- `migrations.test.ts`：v3 up/down/幂等、备份。

> CI 不加载真实 95 MB 模型：全部用确定性假向量；真实模型只在本机 smoke / 手工验收跑。

### 11.2 E2E（沿用假采集 + 假 LLM）

- 图谱出现节点与相似边；计数正确；
- 点击节点 → 侧栏成员事件 → 时间线；
- 「显示事件」开关：关时不画事件节点，开时出现；
- 模型未配置：黄条 + 无连线 + 不崩；
- 暂停：零新增 LLM 请求、零 embedding 出网（本来就没有）；
- 原有 24 条 E2E 回归；选择器从 `#sigma-container` 改为 `#graph-container` / `foam-graph canvas`。

### 11.3 验收口径（替代旧 C3/C4/D8/D25 的图谱部分）

| # | 验收项 | 方法 |
| - | - | - |
| G1 | 节点照常归纳 | 10-21 真实数据仍得到 63 个节点；`source_events` 100% 可解析 |
| G2 | 本地连线 | 同一天节点生成 ≥1 条 `kind='embedding'` 边；同输入重跑边集合一致 |
| G3 | 距离编码 | 单测：sim 越大 distance 越小；渲染层不读 weight 改线宽 |
| G4 | 阈值可调 | 设置改 0.60/0.70 后边数变化符合预期；有「重新连线」 |
| G5 | 模型缺失降级 | 删/改名模型目录 → 图谱只画节点 + 黄条，应用不崩、采集/时间线正常 |
| G6 | 零出网 | 抓包/单测断言 embedding 路径无 fetch；模型不从 Hub 下载 |
| G7 | 事件默认不上画布 | 10-22（2,029 事件 / 0 节点）不出现 2k 点云；开开关才画 |
| G8 | 下钻与找回 | 3 个回忆问题 ≥2 题在 90 秒内靠节点 + 侧栏找回（沿用 D25 的实用口径） |
| G9 | 性能 | 63 节点 embedding ≤ 500 ms（不含首次模型加载）；边重算 ≤ 100 ms；画布交互 ≥ 30 fps |
| G10 | 闸门 | `npm test` + `typecheck` + `build` + `test:e2e` 全绿；无真实网络 |

## 12. 分阶段实施（3–4.5 天）

| 阶段 | 内容 | 产出 | 工时 |
| - | - | - | - |
| **P0 运行时 spike** | Electron + `onnxruntime-node` + tokenizer worker；63 个真实节点全量 embedding；边策略/距离调参；Foam 距离补丁截图 | 数据报告 + go/no-go | 0.5–1 天 |
| **P1 数据层** | schema v3、embedding service、edge builder、query kind 过滤、迁移/回填、单测 | 本地连线可跑通 | 1–1.5 天 |
| **P2 渲染层** | vendor Foam + M1–M9、adapter、概念优先 UI、设置项、E2E | 新画布可看可用 | 1–1.5 天 |
| **P3 验收** | 10-21/10-22 真机、G1–G10、文档/决策、PR squash | 验收记录 | 0.5–1 天 |

**开工前**：当前分支 `feat/obsidian-graph-and-settings-ux` 有未提交的 Sigma 调优，已被本方案取代；新分支从 `main` 切 `feat/graph-foam-embedding`，不要把这些改动带进去（先 stash/丢弃需拍板人确认）。

## 13. 风险与回退

| 风险 | 影响 | 缓解 |
| - | - | - |
| ONNX 原生模块在打包后加载失败 | 高 | P0 在 Electron 实测（已通过）；打包 `asarUnpack` + 只留 win32-x64；失败回退 WASM |
| 运行时 301 MB + 模型 95 MB | 中 | 裁剪多平台二进制；模型放 userData/外部目录，不进安装包；设置可换目录 |
| 英文/技术词 [UNK] | 中 | 中文摘要兜底；纯英文标题在 UI 标注「向量质量低」；M3 换 bge-m3 |
| 相似度整体偏高 → 毛球 | 中 | 默认 0.64 + 互选 top-4（67 条边实测）；设置可调；后续 ANN/聚类 |
| 距离编码导致弱边飞出屏幕 | 中 | dMax 220 夹取；`zoomToFit`；设置可调 |
| 旧 AI 边残留 | 低 | 查询过滤，不删除；显式清理另开操作 |
| 迁移破坏用户库 | 高 | 迁移前自动备份；up/down/幂等；单测覆盖 |
| Foam 改动与上游分叉 | 低 | 用户明确允许；`UPSTREAM.md` + 补丁标记；不追上游 |

**回退**：旧边保留 + 旧 Sigma 代码在 git 历史；新方案按阶段提交，P2 出问题可只回退渲染层，数据层（embedding 表/边）不影响时间线与采集。

## 14. 决策归档与文档同步

按拍板人 2026-10-23 指令：

- **归档**：D8（AI 连边 + 线宽/距离双重编码）、D17（M2 sigma 画布范围）、D20（图谱入口/热键）、D23（M2 验收）、D25（C3/C4 找回验收）→ `docs/archive/graph-decisions.md`（保留原文 + 归档原因 + 处置）。
- **取代**：新增 **D27**：图谱重做（Foam 内核 + 本地 bge-small 向量连线 + 距离编码 + 事件默认不上画布）；D20 的入口/热键行为在 D27 中原样保留。
- **保留**：D3（图谱式日记）、D7（分层记忆）、D18（暂停零出网）、D19（敏感事件）、D21/D22/D26（供应商/参数/设置）、D24（出网确认门）。
- **文档**：`docs/m2-plan.md` 图谱章节标记 superseded；`docs/human/记忆球-产品技术方案.md` §6.2 双重编码/线宽表述标记 superseded；本文件为图谱新事实源。

## 15. 待拍板问题

| # | 问题 | 建议 |
| - | - | - |
| Q1 | 向量运行时：`onnxruntime-node`（原生，快，301 MB）还是 `onnxruntime-web`（WASM，小一些，慢） | **A 原生**；Electron 45 已实测通过 |
| Q2 | 模型放哪：设置指向现有 AI_Companion 目录 / 复制到 `userData/models` / 随安装包分发 | **设置 + 首次引导**；不硬编码、不复制、不分发 |
| Q3 | 默认连线策略：0.64 + 互选 top-4（67 条边） | 接受，设置可调 |
| Q4 | 事件节点：默认不画，开关打开才画 | 接受；侧栏下钻保留 |
| Q5 | 节点尺寸：用 `sourceCount` 对数映射（证据量），不用 degree | 接受；避免和相似度重复 |
| Q6 | 时点：现在替换 M2 Phase 3，还是 M2 收口后做 | **现在替换**；旧 Sigma 分支不再维护 |

## 16. 核对记录（本方案的事实来源）

```text
# 模型
路径：C:\Users\HP\AI_Companion\models\bge-small-zh-v1.5
文件：model.onnx 94,851,877 B；tokenizer.json 439,125 B；config.json（BERT 4 层 / hidden 512）
输入：input_ids / attention_mask / token_type_ids；输出：last_hidden_state [B,T,512]
池化：CLS + L2 归一化（与 AI_Companion embeddings.py 一致）

# 运行时
Python onnxruntime：batch=3 短文本 3.7 ms
Node 24 + onnxruntime-node@1.30.0：6.1 ms
Electron 45.0.0 主进程：7.2 ms（同一 model.onnx）；首次加载 tokenizer 33 ms + session 440 ms
onnxruntime-node 解包 301 MB（多平台）；tokenizer @huggingface/tokenizers 0.2.0 纯 JS

# 相似度标定（63 节点，title + summary）
1,953 对：min 0.281 / p50 0.516 / p95 0.702 / max 0.959
0.64 + mutual top-4 → 67 条边，平均度 2.13
0.70 + mutual top-4 → 57 条边，平均度 1.81

# 已知限制
bge-small-zh vocab 无 deep/api/gui/rust/desk/m2/onnx 等英文子词 → [UNK]（已实测）

# 现行数据
nodes 63（均在 2026-10-21）；旧 ai 边 56 条；10-22 事件 2,029、节点 0
```

参考：

- Foam：<https://gitcode.com/gh_mirrors/fo/foam.git> / <https://github.com/foambubble/foam>
- BGE：<https://huggingface.co/BAAI/bge-small-zh-v1.5>
- ONNX Runtime Node：<https://onnxruntime.ai/docs/get-started/with-javascript/node.html>
- Tokenizers.js：<https://github.com/huggingface/tokenizers.js>
