# UPSTREAM · Foam graph view（vendored）

- 上游：https://github.com/foambubble/foam
- 包：`packages/foam-graph`（npm 名 `@foam/graph-view`），版本 **0.40.0**
- commit：`3a3662d1fff122e2701d7fb43adb70d9087d9bc3`（2026-10-23）
- 许可证：MIT（见同目录 `LICENSE`）
- 复制时间：2026-10-24

## 复制清单

| 上游路径 | 本目录 | 说明 |
| - | - | - |
| `src/protocol.ts` | `protocol.ts` | 加 Gotcha 节点属性/边字段（F1） |
| `src/lib/types.ts` | `lib/types.ts` | 边 weight/kind、`dimmed` 状态（F1/F4） |
| `src/lib/colors.ts` | `lib/colors.ts` | `dimmed` 透明度（F4） |
| `src/lib/defaults.ts` | `lib/defaults.ts` | Gotcha 暗色默认样式（F11） |
| `src/lib/style.ts` | `lib/style.ts` | 未改 |
| `src/lib/groups.ts` | `lib/groups.ts` | 未改（分组颜色仍可用） |
| `src/lib/painter.ts` | `lib/painter.ts` | 颜色分组的性能补丁（见下） |
| `src/lib/graph-utils.ts` | `lib/graph-utils.ts` | 状态计算接 `dimmedNodeIds`（F4/F13） |
| `src/lib/graph-view-model.ts` | `lib/graph-view-model.ts` | 未改 |
| `src/components/graph-canvas.ts` | `components/graph-canvas.ts` | F2/F3/F5/F6/F7/F8/F9 + 渲染帧计数 |
| `src/foam-graph.ts` | `foam-graph.ts` | F10/F12/F13 + 事件接线 + `stats()` |
| — | `lib/distance.ts` | 新增：`distanceFromSim`（F2） |

## 未复制的文件

`components/control-panel.ts`、`components/autocomplete-input.ts`（F10 整块移除）、
`main.ts` / `main.css` / `index.html`（VS Code webview 启动器，不需要）、
构建与测试基建（`build.cjs`、`tsconfig*`、`*.test.ts`）；Gotcha 自己的行为用
`tests/unit/*` 覆盖，不搬上游测试。

## 补丁清单（方案 `docs/m2-graph-redesign.md` §7.3）

| # | 位置 | 改动 |
| - | - | - |
| F1 | `protocol.ts` / `lib/types.ts` | `GraphDataLink` 增加 `weight`/`kind`；`NodeProperties` 增加 `size`/`tsStart`/`tsEnd`/`dayKey`；`GraphModelLink` 同步类型 |
| F2 | `components/graph-canvas.ts` | `forceLink.distance()` 用 `distanceFromSim(weight)`；`updated()` 改力时保持函数，不重置常数 |
| F3 | `components/graph-canvas.ts` | 节点半径改读 `properties.size`（回退度数）；时刻点标签放大/高亮才显示 |
| F4 | `lib/types.ts` / `lib/colors.ts` / `lib/graph-utils.ts` / `foam-graph.ts` | 新增 `dimmed` 状态（填充/边框 0.18、边 0.1）；`dimmedNodeIds` 透传；状态变化强制重绘 |
| F5 | `components/graph-canvas.ts` / `foam-graph.ts` | `seedPositions` 建节点时 seed `x/y`；沉降后派发 `canvas-settled`→`graph-settled`；`positions()` |
| F6 | `components/graph-canvas.ts` | `forceCollide` 改按节点半径函数（主题大、时刻小） |
| F7 | `components/graph-canvas.ts` / `foam-graph.ts` | 单击 300ms 计时；同节点双击 → `canvas-node-dblclick` → `node-open` |
| F8 | `components/graph-canvas.ts` / `foam-graph.ts` | `zoomToFitNodes(ids)` 按子集包围盒适配相机 |
| F9 | `components/graph-canvas.ts` | 保留方向粒子、标签淡出、hover 高亮；未按 v0.2 M8 删粒子 |
| F10 | `foam-graph.ts` | 移除控制面板与 `showControls`，控件改由 Gotcha 设置抽屉承担 |
| F11 | `lib/defaults.ts` | 主题色/背景/行色硬编码为 Gotcha 暗色，不依赖 `--vscode-*` |
| F12 | `foam-graph.ts` / `components/graph-canvas.ts` | 暴露 `selectNode` / `clearSelection` / `zoomToFitNodes` / `positions` / `nodePosition` / `selectedId`；E2E/wrapper 复用 |
| F13 | `foam-graph.ts` / `lib/graph-utils.ts` | 聚焦 = 选中 + 调暗，不用 `graphScope` 删节点（避免布局跳） |

## 方案外的 P0 追加（最小改动，均有注释标记）

| 位置 | 改动 | 理由 |
| - | - | - |
| `lib/painter.ts` | 圆按颜色字符串分组，且每个圆 `moveTo` 起独立子路径 | 上游按 `RGBColor` 对象身份做 Map 键；每节点新建颜色对象 → 1010 节点 ≈ 1010 次 `beginPath`/`fill`，实测只有约 13 fps。改成字符串键后 210+800 活布局 60 fps、2k 约 56 fps（`.tmp/harness-check.mjs` 实测） |
| `components/graph-canvas.ts` / `foam-graph.ts` | `onRenderFramePost`、`onEngineTick` 计数 + `stats()` | harness 用「渲染帧差值」算**布局中** FPS；静止时 rAF 仍是 60，直接读会虚高 |

## 升级方式

不要追上游。需要新版本时：重新复制上述文件 → 逐条重放本表补丁 → 更新本文件的 commit 与
版本 → 跑 `npm test` / `npm run typecheck` / `npm run build`。
