# 草案 · 用 Foam graph-view 重做记忆球图谱渲染（M2 增补）

> **已归档（2026-10-23）**：本稿是「Foam 兼容 Sigma」的中间方案，已被 `docs/m2-graph-redesign.md`（Foam 内核 + 本地向量连线 + 仅距离编码）取代，仅作历史记录，不再作为实施依据。

> 状态：**草案 v0.1（2026-10-23）· 未拍板 · 未改动代码**
> 依据：拍板人指定 <https://gitcode.com/gh_mirrors/fo/foam.git>（上游 [foambubble/foam](https://github.com/foambubble/foam)）
> 结论先行：Foam 的 `packages/foam-graph`（包名 `@foam/graph-view`）是一个与 VS Code 解耦的 **Lit + force-graph Web Component**，可直接在 Electron 渲染进程运行，交互模型（邻域高亮 / 局部图 / 类型过滤 / 分组 / 力参数）比现有自绘 Sigma 完整；但它建模的是「笔记 + 链接」，**未发布 npm，只能 vendor 并维护 fork**，边宽 ∝ weight（D8）、节点尺寸、事件叶节点标签、切日 fit 都必须打补丁。建议先走 0.5–1 天 `vibe/foam-graph-spike` 做 2k 节点性能闸门，过了再替换；不过则退到「只移植 Foam 模型与交互，保留 Sigma 渲染」。

## 0. 需要拍板的事（先看这五条）

| # | 请求 | 建议 |
| - | - | - |
| Q1 | 是否批准 `vibe/foam-graph-spike`（临时装依赖、不合并） | 批准。0.5–1 天出帧率/包体/交互报告，失败直接删分支 |
| Q2 | 替换时点：M2 Phase 3 验收前 vs 收口后 | **先 spike，再按数据定**：spike 全绿就在验收前替换（C3/C4 直接按新内核验）；否则 M2 先按 Sigma 收口，Foam 转 M3 |
| Q3 | 事件叶节点默认怎么展示（当前是「全量事件环」） | 默认全量但**不画事件标签**；2k 节点帧率不达标再降级为「概念图 + 点开看事件」 |
| Q4 | 依赖与 vendor：`lit` / `force-graph` / `d3-force` / `d3-scale` / `d3-color` + Foam 源码副本 | 批准 5 个宽松许可依赖 + 固定 commit 的 vendor；只进图谱窗口懒加载 chunk |
| Q5 | 是否新增决策 D27，修订 D17 的「sigma.js 画布」表述 | 需要。D17 的范围（L1 + 带权边 + 下钻）不变，只换渲染内核 |

> 未拍板前：不装依赖、不改 `package.json`、不动 `graph.ts`；本文件只是方案。

## 1. 现状：Sigma 内核已经能用，但「越调越像在维护一个小框架」

当前图谱窗口的渲染全部是自己的代码：

- `src/renderer/graph/graph.ts`：graphology 建图、FA2 布局、Sigma 初始化、hover/click reducer、相机 reset；
- `src/renderer/graph/graph-view.ts`：颜色 / 尺寸 / 边宽 / 邻域等纯函数；
- `src/renderer/graph/graph-panel.ts`：节点侧栏（成员事件 / 跳时间线）；
- `src/renderer/graph/graph-settings-panel.ts`：设置抽屉（归纳参数 / 供应商 / 热键 / 出网确认）。

问题不是「跑不起来」，而是：

1. **视觉与交互都靠手写**：悬停降透明度、标签避让、局部图、类型过滤、分组、力参数，每加一项都要改 `graph.ts` 并手测；没有可复用的组件边界。
2. **Sigma 的坑需要持续兜**：`itemSizesReference` 锁 `screen` 防止节点膨胀成巨球（`graph.ts` 已注释，见上次交接）；标签密度、相机范围、事件节点标签都要逐项调。
3. **能力缺口**：没有「以某节点为中心的局部图（depth 1/2）」、没有按类型显隐、没有分组着色、没有力参数面板；这些 Foam 已经做成产品。
4. **当前图谱代码只是 M2 自用**，没有上游维护；而 Foam 的 graph 有独立包、单测和版本节奏。

同时要如实说：**现在的 Sigma 实现有 24 条 E2E 覆盖 C3/C4 路径，真机验收仍待 Phase 3**；换内核不是修 bug，是体验升级，收益必须大于迁移风险。

## 2. Foam 核对结果（本次实际拉库 + npm 查询）

| 项 | 事实 | 证据 |
| - | - | - |
| 仓库 | `foambubble/foam`，VS Code 的个人知识管理扩展 | 上游 README |
| 许可 | 仓库根 **MIT**（Copyright 2020–present Jani Eväkallio） | `LICENSE` |
| 图谱包 | `packages/foam-graph`，包名 `@foam/graph-view`，版本 `0.40.0`，`private: true` | `packages/foam-graph/package.json` |
| 是否可 npm 安装 | **否**：`npm view @foam/graph-view` 返回 **404** | 2026-10-23 本机实测 |
| 技术栈 | **Lit 3** Web Component + **force-graph**（Canvas 2D）+ d3-force / d3-scale / d3-color | `packages/foam-graph/src/**` |
| 与 VS Code 耦合 | **无**。组件只依赖 DOM / Canvas；`protocol.ts` 明确「不得 import VS Code / Node」；`main.ts` 里的 `acquireVsCodeApi` 只是 webview 壳，可不用 | `src/protocol.ts` 头注释、`src/main.ts` |
| 构建方式 | esbuild；lib 产物把 `lit` 设为 external，另有一份全打包的 `foam-graph.standalone.js` | `build.cjs` |
| 数据协议 | `GraphData { nodeInfo: Record<string, NodeInfo>, links: {source,target}[] }`；`NodeInfo { id, type, title, properties, tags }` | `src/protocol.ts` |
| 已具备能力 | 1 跳邻域高亮（`computeGraphStates`）、局部图 `graphScope: 'full' \| {depth}`、按类型显隐、分组规则（type/path/tag/title）、标签随缩放淡出、力参数（collide/repel/link/velocityDecay）、粒子连线动画、`zoomToFit` / `centerOnNode` / `selectNote`、`node-click` 事件 | `src/foam-graph.ts`、`src/components/graph-canvas.ts`、`src/lib/graph-utils.ts` |
| 上游维护 | 活跃；本次核对 GitHub `3a3662d`（2026-10-23）与 GitCode 镜像 `a7d70d1`（2026-10-11）；**GitHub 侧的 `packages/foam-graph` 文件在镜像中均无差异、无缺失**（本次 hash 对比） | 本机 clone 对比 |

### 它不是什么

- **不是通用图库**：节点尺寸按「邻居数」线性映射（`scaleLinear().domain([0,30]).range([0.6,3])`），边宽全局统一（`style.lineWidth * multiplier`），没有 per-node size / per-edge width 入参。
- **不是「把记忆球数据导成 markdown 就能看」**：Foam 的模型是笔记 / 标签 / 附件；我们的模型是概念节点 + 原始事件叶节点 + 带权边，需要适配层。
- **不是 Obsidian / Foam 工作区导出**：本方案不落地 markdown、不引 VS Code；「Obsidian 互通」仍是 M5 边界（decisions 立项表）。

## 3. 复用面：哪些直接拿，哪些必须改

### 3.1 直接复用（MIT，保留版权声明）

| 上游文件 / 符号 | 用途 |
| - | - |
| `src/lib/graph-utils.ts`：`createGraphModel` / `computeGraphStates` / `computeFocusSets` / `getNeighbors` | 建模型、1 跳邻域、选中/悬停状态 |
| `src/lib/graph-view-model.ts`：`computeVisibleGraph` / `deriveNodeTypeFilters` / `computeGroupMatchCounts` | 类型过滤、分组、局部图裁剪 |
| `src/lib/colors.ts` / `style.ts` / `defaults.ts` | 颜色、样式合并、默认主题（VS Code CSS 变量有 fallback） |
| `src/lib/painter.ts` | 按颜色批量画圆 + 屏幕坐标文字（2k 节点时比分次 `fill()` 更稳） |
| `src/components/graph-canvas.ts` | force-graph 初始化、ResizeObserver、zoom/center/fit、hover/click 事件、增量数据更新 |
| `src/foam-graph.ts` | `<foam-graph>` 公开属性与 `node-click` 事件 |
| `src/protocol.ts` | 消息/数据类型（需扩展 link 权重） |

上游单测（`graph-utils.test.ts` / `graph-view-model.test.ts` / `colors.test.ts` / `style.test.ts` / `graph-canvas.test.ts`）可一并 vendor，用于守住 fork 补丁。

### 3.2 必须打的补丁（按优先级）

| # | 补丁 | 原因 | 改动面 |
| - | - | - | - |
| P1a | `linkWidth` 读 `link.weight`：`1 + 4 * clamp(weight)` | Foam 边宽全局统一，**直接违反 D8「线宽 + 布局距离双重编码」**；真实数据 weight 0.2–0.8 有 9 档，必须可见 | `graph-canvas.ts` 1 处 + 适配层 |
| P1b | `forceLink.strength(link => 0.1 + 0.9 * clamp(weight))`（或让 `distance` 随 weight 反比） | D8 的另一半是「布局距离」；Foam 默认 `forceLink` 不读 weight，所有边等强，**只补线宽仍只实现半条 D8** | `graph-canvas.ts` 1 处 + 适配层 |
| P2 | 节点尺寸读 `properties.size`，否则回退邻居数 | 真实概念节点 degree 只有 1–4；Foam 的 `[0,30] → [0.6,3]` 会把 1–4 度压成几乎同尺寸（约 1.4–1.8），而现有映射是 6–22px。另：size 是 force-graph 图坐标单位，需按 `globalScale` 换算成屏幕像素（或接受随缩放变化），spike 里定 | `graph-canvas.ts` 1 处 + 适配层 |
| P3 | 事件叶节点不画标签，仅 highlighted 时显示 | 2k 事件节点 + 每帧逐条 `fillText` 会糊成一片且拖慢帧率 | `graph-canvas.ts` 标签分支 |
| P4 | `<foam-graph>` 暴露 `fit()` / `hoverNode(id)`，并透传 `background-click` | 切日后需要重新 fit；E2E 需要与现有 `__gotchaGraphView.hover` 对齐；关侧栏需要空白点击事件 | `foam-graph.ts` 两个方法 + 一个事件 |
| P5 | 颜色解析结果缓存（按 type+state） | 当前每帧对每个节点 `rgb()` / `hsl()` 解析，2k 节点会产生大量临时对象（**推断，待 spike 证实**） | `colors.ts` 或 canvas 内缓存 |
| P6 | `cooldownTicks` / `alphaDecay` 调到 2k 规模 | Foam 首载只跑 100 tick；2k 节点 100 tick 时 alpha 仍约 0.1，布局没收敛 | `graph-canvas.ts` 初始化 |
| P7 | 无父事件初始位置成环（可选） | Foam 对无边节点只有 x/y 向心 + 碰撞，2k 个孤立事件会挤成中心团；现有实现是外环 | `graph-canvas.ts` 数据更新处 |

> 补丁全部用小段注释 `// GOTCHA PATCH Pn:` 标记，并在 `foam/PATCHES.md` 记录「上游文件 + 原因 + 升级时要复核的点」，避免下次升级无从下手。

## 4. 集成架构（不动主进程 / 不改数据契约）

```
graph.html（外壳保留：工具栏 / 空状态 / 侧栏 / 设置抽屉）
└─ graph.ts（日期、IPC、状态、空态、侧栏、设置；删掉 sigma/graphology/FA2）
   ├─ graph-adapter.ts   纯函数：GraphDayData → FoamGraphData（可单测）
   ├─ graph-foam.ts      挂载 <foam-graph>、事件映射、切日 fit、E2E 钩子
   │  └─ foam/           vendor 自 @foam/graph-view @ 固定 commit（MIT）
   ├─ graph-panel.ts     不变
   ├─ graph-settings-panel.ts 不变
   └─ graph-view.ts      保留颜色/尺寸纯函数供适配层复用；Sigma 专用邻域函数退休
```

- **IPC 不变**：继续用 `window.gotchaGraph.query(from, to)`，主进程 `queryGraphDay(..., { includeEvents: true })` 一行不改。
- **SQLite / 归纳 / 出网 / 暂停全部不碰**，迁移回归面只在渲染进程。
- **懒加载**：`import('./graph-foam')` 保持，时间线页不背图谱体积。
- **不建插件系统**：只做一个 `renderer` 开关用于迁移期回退，验收后删除，不做长期双内核。

### 4.1 挂载草图

```ts
// graph-foam.ts（示意，非最终代码）
import './foam/foam-graph' // 注册 <foam-graph>
import type { FoamGraph } from './foam/foam-graph'
import type { GraphDayData } from '../../understand/graph-query'
import { toFoamGraph } from './graph-adapter'

const FORCES = { collide: 1.5, repel: 120, link: 30, velocityDecay: 0.4 }

export function mountGraph(container: HTMLElement, data: GraphDayData): FoamGraph {
  const el = document.createElement('foam-graph') as FoamGraph
  el.graphData = toFoamGraph(data)
  el.graphStyle = FOAM_STYLE
  el.forces = FORCES
  el.labels = { fade: 1 }
  el.showControls = false
  container.replaceChildren(el)
  return el
}
```

- 点击：`el.addEventListener('node-click', (e) => ...)`，detail 是 `c:<id>` / `e:<id>`；
- 空白点击：上游只内部清选中，未向外冒泡；P4 一并补 `background-click` 透传，用于关侧栏；
- 切日：重新 `graphData` 后调 P4 的 `fit()`；不要重建整个元素（保留力模拟与相机）。

### 4.2 vendor 规则

- 只复制 `src/foam-graph.ts`、`src/protocol.ts`、`src/components/graph-canvas.ts`、`src/lib/*` 与对应单测；`main.ts` / `main.css` / `control-panel` 不复制（同时摘掉 import 与 render 分支）。
- 保持上游文件头与格式，**不重排、不格式化**，让 `diff -r` 仍能对齐上游；补丁统一用 `// GOTCHA PATCH Pn:` 标记。
- `foam/UPSTREAM.md` 记录 commit、日期、复制清单、补丁清单；`foam/LICENSE` 放 MIT 全文；根 `THIRD_PARTY_NOTICES.md` 汇总 Foam / Lit / force-graph / d3 的许可。

## 5. 数据映射（适配层的关键）

### 5.1 映射表

| Gotcha（`GraphDayData`） | Foam（`GraphData`） | 说明 |
| - | - | - |
| `node.id` + `type` + `title` | `NodeInfo.id = "c:<id>"`、`type`、`title` | 加 `c:` 前缀，避免和事件 id 撞 |
| `node.degree` | `properties.degree` / `properties.size` | 由适配层算好尺寸，P2 读取 |
| `node.type` | `properties.color` 或 `style.node[type]` | 六色沿用 `NODE_COLORS`；用 style 可让分组规则覆盖 |
| `edge.source/target/weight` | `links[] = { source: "c:a", target: "c:b", weight }` | **无向去重**：`a-b` 与 `b-a` 只留一条（现有 graphology 也是单边） |
| `event.id` | `NodeInfo.id = "e:<id>"`、`type: 'event'` | `title = windowTitle || app`，**不带 OCR** |
| `node.eventIds` | 从属边 `c:<parent> → e:<event>` | 一个事件只挂第一个父节点（与现有 `eventParentMap` 一致） |
| 无父事件 | 仅 `e:` 节点，无边 | 默认仍渲染；Q3 决定是否降级 |

### 5.2 适配层草图

```ts
// graph-adapter.ts（纯函数，零 DOM，零 IPC）
import type { GraphDayData } from '../../understand/graph-query'
import { maxDegree, nodeColor, nodeSize } from './graph-view'

export interface FoamNodeInfo {
  id: string
  type: string
  title: string
  properties: { color?: string; size?: number; degree?: number; eventId?: number; ts?: number }
  tags: []
}

export interface FoamLink {
  source: string
  target: string
  weight: number
  kind: 'concept' | 'sub'
}

export interface FoamGraphData {
  nodeInfo: Record<string, FoamNodeInfo>
  links: FoamLink[]
}

const conceptKey = (id: number): string => `c:${id}`
const eventKey = (id: number): string => `e:${id}`

export function toFoamGraph(data: GraphDayData): FoamGraphData {
  const maxDeg = maxDegree(data)
  const nodeInfo: Record<string, FoamNodeInfo> = {}
  const links: FoamLink[] = []
  const seen = new Set<string>()

  for (const node of data.nodes) {
    nodeInfo[conceptKey(node.id)] = {
      id: conceptKey(node.id),
      type: node.type,
      title: node.title || '未命名节点',
      properties: {
        color: nodeColor(node.type),
        size: nodeSize(node.degree, maxDeg),
        degree: node.degree
      },
      tags: []
    }
  }

  for (const edge of data.edges) {
    const a = conceptKey(edge.source)
    const b = conceptKey(edge.target)
    if (!nodeInfo[a] || !nodeInfo[b] || a === b) continue
    const key = [a, b].sort().join('|')
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ source: a, target: b, weight: edge.weight, kind: 'concept' })
  }

  // 事件叶节点：先建父映射，再逐条挂边；无父事件保留为孤立点
  const parent = new Map<number, number>()
  for (const node of data.nodes) {
    for (const evId of node.eventIds ?? []) {
      if (!parent.has(evId)) parent.set(evId, node.id)
    }
  }
  for (const ev of data.events ?? []) {
    const id = eventKey(ev.id)
    nodeInfo[id] = {
      id,
      type: 'event',
      title: ev.windowTitle || ev.app,
      properties: { color: '#58677c', eventId: ev.id, ts: ev.ts },
      tags: []
    }
    const p = parent.get(ev.id)
    if (p !== undefined) {
      links.push({ source: conceptKey(p), target: id, weight: 0.25, kind: 'sub' })
    }
  }

  return { nodeInfo, links }
}
```

> 真实数据里 `eventIds` 只在 `includeEvents: true` 时返回；当前 `graph:query` 已开启，无需改主进程。

## 6. 视觉与交互映射

| 能力 | 现状（Sigma） | Foam 方案 | 备注 |
| - | - | - | - |
| 概念色 | `nodeColor(type)` 六色 | `style.node` + `colorMode: 'type'`，或 `properties.color` | 保护灰 / 未知灰保留 |
| 概念尺寸 | `log1p(degree)` → 6–22px | **P2 补丁**读 `properties.size` | 不沿用 Foam 的邻居数线性映射 |
| 边宽 | `1 + 4*weight` | **P1 补丁**读 `weight` | D8 视觉验收点 |
| 事件节点 | 3.5px，默认无标签 | type `event`，3.5，**P3 只高亮时画标签** | 2k 事件时最关键的性能/可读性开关 |
| 悬停 | `neighborKeys` 手写 reducer | `computeGraphStates` 1 跳；`lessened` 透明度 0.05 | 高亮色改 `#4fc3f7` 或白，别用 Foam 默认黄 |
| 点击 | 侧栏 / 事件侧栏 | `node-click` 事件 → 同一 `openNode` / `showEvent` | 映射 `c:` / `e:` 前缀 |
| 空白点击 | 关侧栏 | `canvas-background-click` | 保留 |
| 缩放/平移 | Sigma 相机 | force-graph 内置 + `zoomToFit` | 切日调用 `fit()` |
| 局部图 | 无 | `graphScope: {depth: 1}` + `focusNodeId` | 可做「双击进入邻域，Esc 退出」；本版可选 |
| 类型显隐 / 分组 | 无 | `showNodesOfType` / `GroupRule` | 本版先固定，不做 UI；后续可进设置 |
| 力参数 | FA2 预计算 180 迭代，`edgeWeightInfluence=1.2` | d3-force 实时模拟；**P1b** 让 link strength 读 weight | 手感不同，spike 里调 `collide/repel/link/velocityDecay` |
| 标签淡出 | sigma `labelDensity` | `labels={{fade: 1}}` + P3 | 中文长标题仍需截断 |
| 空状态 / 状态徽标 | 外壳 | 不变 | 只在 `graph-foam.ts` 挂载/卸载 |

### 主题初值（草案）

```ts
const FOAM_STYLE = {
  background: '#0d0e14',
  fontSize: 11,
  fontFamily: 'Segoe UI, "Microsoft YaHei", system-ui, sans-serif',
  lineColor: '#3e4451',
  lineWidth: 1,
  particleWidth: 0,
  highlightedForeground: '#4fc3f7',
  node: {
    knowledge: '#4FC3F7',
    activity: '#81C784',
    protected: '#9E9E9E',
    event: '#58677c'
  },
  colorMode: 'type' as const
}
```

## 7. 性能与量级：这是本方案唯一的硬闸门

### 7.1 真实数据（2026-10-23 约 21:00，只读查询本机 `%APPDATA%/Gotcha/memory.db`）

| 项 | 数值 |
| - | - |
| `events` 总数 | 4,242 |
| `nodes` 总数 | 63（全部落在 2026-10-21） |
| `edges` 总数 | 56（kind 全为 `ai`，weight 0.2–0.8，9 档） |
| 10-22 事件数 | **2,029**，节点 0 |
| 10-23 事件数 | 641，节点 0 |
| 概念节点 degree 分布 | 1 度 23 个、2 度 27 个、3 度 9 个、4 度 2 个、0 度 2 个 |

含义：

- **10-21 这种已归纳日**：63 节点 + 56 边，Foam 会非常轻松，局部图/分组都能开。
- **10-22 这种未归纳日**：现有实现会画 **2,029 个孤立事件点 + 0 条概念边**；换 Foam 后仍会是 2k 点，且由于没有 link，力模拟会把它们往中心挤。**换内核不会自动解决「未归纳日」的观感**，需要 Q3 的产品决策。
- 全量事件 + 概念边的最坏情况约 **2,100 节点 / 2,000 边**。

### 7.2 布局基准（Node 24.13，仅 d3-force，不含渲染）

| 规模 | 300 tick 耗时（3 次） | 说明 |
| - | - | - |
| 2,100 节点 / 2,000 边 | **3.1–5.3 s** | 约 11–17 ms/tick；force-graph 若每帧 1 tick，收敛需 3–5 秒 |
| 2,029 节点 / 0 边 | **3.4–4.5 s** | 孤立点云也不便宜 |
| 63 节点 / 56 边 | **54–77 ms** | 已归纳日无压力 |

> 口径：`forceSimulation` + `forceLink/charge/collide/x/y`，`alpha < 0.001` 或 300 tick 停止；**未含 Canvas 渲染、浏览器主线程竞争和 force-graph 内部开销**。这是量级参考，不是 Electron 实测。

### 7.3 包体基准（esbuild 0.28.1，minify）

入口只 import `lit` + `force-graph` + `d3-force` + `d3-scale`（不含组件代码）：**215 KB min / 74 KB gzip**。

对照当前构建产物：`sigma.esm` 686 KB（gzip 154 KB）+ `graphology` 154 KB（gzip 20 KB）+ FA2 31 KB（gzip 5.5 KB）≈ **180 KB gzip**。换成 Foam 后大概率**更小**（组件代码另计，估计 +10–20 KB gzip）。**结论：包体不是风险，性能才是。**

### 7.4 Spike 闸门（未验证，必须实测）

在 1100×800 图谱窗口、本机集显、2,100 节点 / 2,000 边合成数据下：

- 首屏可交互 ≤ 3 s；布局收敛 ≤ 8 s；
- 收敛后拖拽/缩放 **p50 ≥ 30 fps**（用 `requestAnimationFrame` 采样 5 s）；
- 空闲 10 s 后 CPU < 5%（任务管理器或 `performance` 粗测）；
- 事件标签关闭时，2k 节点不出现 > 500 ms 的长任务；
- 任一不达标 → 先试 LOD（Q3），仍不达标 → 走方案 B（保留 Sigma）。

## 8. 迁移步骤与工时

| 阶段 | 内容 | 产出 | 工时 |
| - | - | - | - |
| **F0 Spike** | `vibe/foam-graph-spike`：vendor 最小文件集 + 适配层 + 2.1k 合成数据页；打 P1/P2/P3 最小补丁；跑 7.4 闸门；截 3 张图（概念图 / 事件云 / 局部图） | 数据报告 + go/no-go | 0.5–1 天 |
| **F1 适配** | 完整补丁 P1–P7；样式/中文/高亮色；切日 `fit()`；点击 → 侧栏；空状态/确认门/设置抽屉接线；单测 | `graph-adapter.ts` + `graph-foam.ts` + `foam/`；单测绿 | 1–1.5 天 |
| **F2 替换** | `graph.ts` 删 sigma/graphology/FA2；`package.json` 移除三依赖、加五依赖；E2E 选择器与钩子更新；构建体积对比 | 旧内核下线，E2E 绿 | 0.5–1 天 |
| **F3 验收** | 10-21/10-22/10-23 真机；C3/C4/D8/D25 清单；D27 + `m2-plan` + 技术方案 §3 同步；PR squash | 验收记录 | 0.5 天 |
| 合计 | | | **2.5–4 天** |

**时点建议**：先 F0；若全绿且拍板人接受 +1–2 天排期，就在 M2 Phase 3 验收前完成 F1–F3，C3/C4 直接按新内核验；否则 M2 按现 Sigma 收口，Foam 作为 M2.5/M3 的体验升级另开分支。

**回退**：F2 之前 Sigma 代码不动；F2 是一个独立提交，出问题 `git revert` 即可恢复（不涉及数据/迁移）。

## 9. 测试与验收

### 9.1 单测（新增 / 调整）

- `graph-adapter.test.ts`（新）：概念/事件 id 前缀、无向边去重、父事件挂边、无父事件保留、空数据、weight 夹取、`eventIds` 缺失时不崩。
- `foam-patches.test.ts`（新）：P1a 边宽随 weight、P1b link strength 随 weight、P2 `properties.size` 优先、P3 事件标签仅 highlighted 绘制（纯函数化后测）。
- 保留上游 `graph-utils` / `graph-view-model` / `colors` / `style` 测试，作为 fork 回归。
- 现有 `graph-view.test.ts` 保留颜色/尺寸/边宽/过滤用例；`neighborIds/neighborKeys` 若随 Sigma 退休则同步删用例（不注释、不跳过）。

### 9.2 E2E（现有 24 条基线）

- `tests/e2e/graph.spec.ts`：`#sigma-container canvas` → `#graph-container canvas`（或 `foam-graph canvas`）；`__gotchaGraphView.count/select` 保持同名 API，内部改调 `selectNote('c:<id>')`；`hover` 若保留则走 P4 的 `hoverNode`。
- 新增断言：`#node-count` 计数不变、点击节点侧栏不变、时间线跳转不变、暂停零请求不变。
- Playwright 默认穿透 open shadow DOM，`foam-graph canvas` 可直接定位；若不行，用 `#graph-container` 外层。
- 性能用例放 `tests/perf/` 或手工清单，不进常规 CI（避免机器差异导致 flaky）。

### 9.3 验收映射

| 口径 | 换 Foam 后 |
| - | - |
| C3 缩放/平移/悬停高亮 | 内置能力；补一条 E2E/手工确认 |
| C4 点击下钻 + 时间线 | 事件映射到原 `openNode` / `showEvent`，不变 |
| D8 边宽 ∝ weight + 布局距离 | P1a + P1b + 单测，视觉抽查 |
| D25 `source_events` 100% 可溯 | 适配层只读，不改库；E2E 原断言保留 |
| C7 闸门 | `npm test` + `npm run typecheck` + `npm run build` + `npm run test:e2e` 全绿 |
| 新增 G1 | 2k 节点性能闸门（7.4） |
| 新增 G2 | 许可：`foam/LICENSE` + `THIRD_PARTY_NOTICES.md`，打包时随应用分发 |
| 新增 G3 | 零新增出网：依赖全部本地打包，无 CDN / 远程字体 |

## 10. 与现有决策 / 约束的冲突（必须显式处理）

| 现有约束 | 冲突点 | 处置 |
| - | - | - |
| **D17**：M2 用「sigma.js 力导向画布」 | 换内核直接改选型 | 新增 **D27** 修订「渲染内核」表述；D17 的范围（L1 + 带权边 + 下钻）不变 |
| `m2-plan §1`：不新增 §5 之外依赖 | 新增 lit / force-graph / d3-* | Q4 单独报备并批准；§5 依赖表同步替换 |
| `m2-plan §5`：sigma / graphology / FA2 三依赖 | 移除三依赖，新增五依赖 | 依赖表重写；锁版本、只进图谱 chunk |
| `workflow §4`：新依赖要报「替代/体积/维护/许可/原生模块」 | — | 见下表 |
| **D8**：线宽 + 布局距离双重编码 | Foam 边宽全局统一、link 强度不读 weight | P1a + P1b 补丁 + 单测，不能静默丢 |
| **D25**：每个节点 `source_events` 可溯 | 适配层不能造节点 | 适配层只做展示映射；无父事件不伪造 hub |
| 安全红线：零真实出网 | Foam 组件无网络请求 | 依赖本地打包；不引 CDN；E2E 仍假 LLM |

### 依赖报备表（待批）

| 包 | 版本 | 许可 | 用途 | 体积 / 说明 |
| - | - | - | - | - |
| `lit` | 3.3.3 | **BSD-3-Clause** | Web Component 基座（Foam 组件 peer dep） | 106 KB unpacked；浏览器侧 |
| `force-graph` | 1.52.0 | MIT | Canvas 2D 力导向渲染 | 6.4 MB unpacked（含 dist/map）；实际打包见 7.3 |
| `d3-force` | 3.0.0 | ISC | 力模拟 | 已被 force-graph 间接依赖 |
| `d3-scale` | 4.0.2 | ISC | 尺寸/透明度映射 | 同上 |
| `d3-color` | 3.1.0 | ISC | 颜色解析 | 同上 |
| `@foam/graph-view` | 0.40.0（vendor，固定 commit） | MIT | 图谱组件源码 | **非 npm 包**，不产生 registry 依赖 |

> 全部为宽松许可、无原生模块、仅渲染进程使用；`lit` 是 BSD-3-Clause（不是 MIT），第三方声明里要写清。

### 建议的 D27 文本（草案，未写入 decisions.md）

> **D27｜M2 图谱渲染内核改用 Foam graph-view**：M2 图谱窗口的渲染内核由 sigma.js + graphology 改为 vendor 自 `@foam/graph-view`（Foam，MIT）的 Lit + force-graph 组件；D17 的范围（L1 知识/行为节点 + 带权边 + 点击下钻）与 D8 的线宽编码不变；该组件仅在图谱窗口懒加载，不改变出云、存储与 IPC 契约；若 2k 节点性能闸门不达标，回退保留 sigma 实现。

## 11. 风险与回退

| 风险 | 影响 | 缓解 |
| - | - | - |
| 2k 节点 Canvas 帧率不达标 | 高 | F0 闸门；P3 关事件标签；LOD；不过则方案 B |
| 未发布 npm，只能 vendor | 中 | 固定 commit + `PATCHES.md` + 上游单测；升级时逐条复核补丁 |
| 上游模型/样式变化导致升级困难 | 中 | 只 vendor 最小文件集；补丁集中、带标记；不把业务逻辑写进 vendor |
| 视觉与现有暗色主题不一致 | 低 | 显式 `FOAM_STYLE`；不依赖 VS Code CSS 变量 |
| E2E 选择器/钩子大面积改 | 中 | 保留 `__gotchaGraphView` API；先加 `#graph-container` 外层再替换 |
| 许可/署名遗漏 | 中 | 根 `THIRD_PARTY_NOTICES.md` + 打包检查；MIT/BSD/ISC 全文 |
| 依赖审批拖期 | 低 | spike 用临时分支，不进 main；审批后再落 package.json |
| 未归纳日仍是 2k 点云 | 中 | Q3 产品决策；必要时按 app 聚合（另案，不在本次范围） |

**方案 B（spike 失败时的退路）**：只 vendor `graph-utils` / `graph-view-model` / `colors` 的纯逻辑，接到现有 Sigma 上，实现局部图、类型过滤、分组；不换渲染器、不新增 lit/force-graph。工时约 1–1.5 天，风险最低，但拿不到 Foam 的力参数面板与整体手感。

## 12. 明确不做

- 不把记忆球导出成 Foam workspace / markdown（Obsidian 互通仍归 M5）。
- 不引入 VS Code 依赖、不跑 webview 协议、不做 `acquireVsCodeApi` 兼容层。
- 不采用 Foam 的 note/tag/attachment 语义，不生成标签节点（`tags: []`）。
- 不新增数据库表/字段，不改归纳、脱敏、出网、暂停逻辑。
- 不在本版做完整控制面板 UI（`control-panel.ts` 暂不 vendor；需同时摘掉 `foam-graph.ts` 里的 `control-panel` import 与 render 分支）；先固定主题，外观项后续进设置抽屉。
- 不做长期双内核插件化；迁移期开关验收后删除。

## 13. 核对记录（本草案的事实来源）

```text
# 1. 仓库与许可
git clone --depth 1 https://gitcode.com/gh_mirrors/fo/foam.git   -> a7d70d1 (2026-10-11)
git clone --depth 1 https://github.com/foambubble/foam.git       -> 3a3662d (2026-10-23)
对比 packages/foam-graph/**：GitHub 侧文件在镜像中均无差异、无缺失；包版本 0.40.0，private: true
LICENSE：MIT（Copyright 2020-present Jani Eväkallio）

# 2. npm 可用性 / 许可
npm view @foam/graph-view      -> 404 Not Found
npm view force-graph           -> 1.52.0, MIT
npm view lit@3.3.3             -> BSD-3-Clause
npm view d3-force              -> 3.0.0, ISC
npm view d3-scale              -> 4.0.2, ISC
npm view d3-color              -> 3.1.0, ISC

# 3. 本机数据（readonly better-sqlite3）
events 4242 / nodes 63 / edges 56
2026-10-22: events 2029, nodes 0
2026-10-23: events 641,  nodes 0
degree 分布: 0:2, 1:23, 2:27, 3:9, 4:2
edge weight: 0.2–0.8（9 档，56 条）

# 4. 布局基准（Node 24.13，d3-force，无渲染）
2100 节点 / 2000 边：3.1–5.3 s（300 tick）
2029 节点 / 0 边：3.4–4.5 s
63 节点 / 56 边：0.054–0.077 s

# 5. 包体基准（esbuild 0.28.1，minify）
lit + force-graph + d3-force + d3-scale：215,349 B min / 74,237 B gzip
现有 sigma + graphology + FA2：约 180 KB gzip
```

参考链接：

- Foam 仓库：<https://gitcode.com/gh_mirrors/fo/foam.git>（镜像）/ <https://github.com/foambubble/foam>
- Foam graph 组件：`packages/foam-graph`（README 明示 Lit + force-graph）
- force-graph：<https://github.com/vasturiano/force-graph>
- Lit：<https://lit.dev>
- 现有实现：`docs/m2-plan.md` §3 Phase 2、`docs/agent/decisions.md` D8/D17、`docs/agent/gotchas.md`（Sigma 相机 / 包体坑）
