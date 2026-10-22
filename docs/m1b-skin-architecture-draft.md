# 悬浮球皮肤架构与水球皮肤 · 草案（v0.1）

> 状态：**后续设计草案，暂不进入 M1b 当前验收**（2026-10-22）。
> 目标：判断现有代码是否方便支持多皮肤，并设计第一款“水球”皮肤：悬停时流体波动/呼吸，停靠缩入后在边缘形成平滑细线。
> 前置：自动缩回可靠性已按 `docs/m1b-ball-retract-draft.md` 方案 A 修复（D16，2026-10-23：状态机 + 600ms 宽限 + 主进程游标兜底）；皮肤只能消费交互状态，不能自行决定命中、穿透、拖动和停靠。

## 1. 可行性结论

**可以实现，而且非常适合作为后续皮肤。** Chromium/Electron 自带 CSS、SVG filter、Web Animations API 与 Canvas，不需要为了第一版水球引入运行时依赖。

现有结构对多皮肤的友好度约 **6/10**：

### 已经有利的部分

- 球有独立的 `ball.html / ball.ts / ball.css` 页面，不与时间线 UI 混在一起。
- 交互状态已集中为 `paused / running / dock-* / expanded / hover / dragging` 等 class。
- 主进程只负责窗口、位置、IPC，视觉主要在 renderer，方向正确。
- Vite 能直接打包 CSS、内联 SVG 与 TypeScript 模块，新增皮肤不需要改构建体系。

### 当前阻碍

- `#ball` 同时承担**命中、拖动、状态 class、视觉造型、变形动画**；水球变细线后，视觉包围盒和交互包围盒会冲突。
- 48px 球、64px 窗口、32px 缩进量散落在主进程、位置模块和 CSS 中，皮肤不能安全改变视觉尺寸。
- `.slash` 暂停标识写死在默认球 DOM 内，不是皮肤可复用的状态叠层。
- 状态通过大量 class 表达，新增皮肤容易复制选择器并出现组合爆炸。
- 当前没有 `skin id / skin tokens / renderer contract`，直接再写一套 CSS 最终会变成“每款皮肤各修一遍交互 Bug”。

**结论**：现在不是即插即用的多皮肤系统，但只需一次小型 renderer 重构，不必推翻主进程和位置持久化。

## 2. 水球皮肤体验草图

### 2.1 常态（水球）

- 球体保持 48px 外轮廓，内部有 2–3 层半透明液体层。
- 非交互时只做极弱的 5–7 秒呼吸：亮度/内部高光变化 2%–4%，外轮廓不持续乱动。
- 运行态用偏冷的清澈蓝灰；暂停态降低饱和度并保留明确的暂停标识，不能只靠颜色区分。

### 2.2 鼠标悬停（水流感）

进入后分两段，避免一上来就“沸腾”：

1. **0–180ms**：球从停靠位置滑出并轻微放大，保持现有反馈。
2. **180ms 后**：液体表面开始低频形变；高光与内层波纹产生轻微相位差，像软质水球受到鼠标靠近后的扰动。

建议效果：

- 外轮廓形变幅度：1.5–2.5px；
- 周期：1.8–2.6 秒，两个不同周期叠加，避免机械重复；
- 呼吸缩放：`1.00 ↔ 1.025`，不要超过现有 hover 的 1.08；
- 鼠标位置只影响高光方向与局部波峰，不让球追着鼠标大幅变形。

### 2.3 停靠缩入（边缘细线）

“细线”只是一种**视觉皮肤**，不能真的把命中区缩成 2px：

- 停靠 idle 时，48px 水球向边缘流动并收束为一条长约 30–36px、宽 3–5px 的圆角水线；
- 水线沿停靠边缘方向排列：左右边缘为竖线，上下边缘为横线；
- 线中间保留一颗轻微移动的高光/水滴，表示它仍然可交互；
- 背后的稳定唤醒热区仍至少是 D15 的 24px 可见入口，推荐实际热区为 24×48px；
- 指针进入热区后，水线从中部鼓起，像水滴聚合成球，再完成滑出。

这比“半颗圆球”更低干扰，但必须保留可发现性：线不能低于 3px，透明度不能低到看不见，暂停态仍应有区别。

### 2.4 拖动

- pointerdown 后先在 80–120ms 内聚合回完整球体，再跟手移动；不能拖着一条细线跑。
- 快速拖动时可有 4–8px 的反向液体拖尾，但拖尾只画在 64px 窗口内，不能改变窗口落点。
- 松手吸附时先确定位置，再播放“贴边 → 流成线”的 220–300ms 动画。

### 2.5 主动弱提示

产品策划中的“微弱收缩一次”可以在水球皮肤中表现为一圈向内传播的水波，而不是放大/闪光：

- 单次 500–700ms；
- 幅度低于 hover；
- 不抢焦点、不连续循环；
- `prefers-reduced-motion` 下改成一次轻微亮度变化。

## 3. 推荐多皮肤架构

### 3.1 DOM 分层

```html
<div id="ball-hitbox" data-state="idle" data-edge="right" data-status="paused">
  <div id="ball-visual" aria-hidden="true"></div>
  <div id="ball-status-overlay" aria-hidden="true"></div>
</div>
```

职责必须固定：

| 层 | 职责 | 皮肤能否替换 |
| - | - | - |
| `ball-hitbox` | 命中、拖动、pointer capture、无障碍 button、稳定几何 | 否 |
| `ball-visual` | 圆球、水球、像素球、极简线等视觉 | 是 |
| `ball-status-overlay` | 暂停、错误、倒计时等可信状态 | 只允许换表现，不允许隐藏语义 |

皮肤的 transform 只能作用于 `ball-visual`，不能改变 hitbox 的几何与事件判断。

### 3.2 状态契约

行为层输出统一状态，而不是让皮肤读取十几个互相组合的 class：

```ts
type BallInteractionState =
  | 'docked-idle'
  | 'docked-expanded'
  | 'docked-grace'
  | 'free-idle'
  | 'hovered'
  | 'dragging'
  | 'pulse'

type BallRuntimeStatus = 'paused' | 'starting' | 'running' | 'stopping'
type BallEdge = 'left' | 'right' | 'top' | 'bottom' | null

interface BallVisualState {
  interaction: BallInteractionState
  status: BallRuntimeStatus
  edge: BallEdge
  pointer?: { x: number; y: number }
  reducedMotion: boolean
}
```

行为层只调用 `skin.render(state)` 或更新 `data-*`；皮肤不得调用 IPC、改变鼠标穿透、移动窗口或写 `ball.json`。

### 3.3 皮肤接口

第一阶段只支持**随应用打包的可信皮肤**，不支持用户随意导入 JS/CSS：

```ts
interface BallSkin {
  id: string
  displayName: string
  mount(root: HTMLElement): void
  render(state: BallVisualState): void
  unmount(): void
}
```

建议目录：

```text
src/renderer/ball/
├─ core/
│  ├─ controller.ts       # 状态机、命中、拖动；与皮肤无关
│  ├─ skin-contract.ts
│  └─ geometry.ts         # hitbox / safe zone 的 renderer 常量
├─ skins/
│  ├─ classic/
│  │  ├─ index.ts
│  │  └─ classic.css
│  └─ water/
│     ├─ index.ts
│     ├─ water.css
│     └─ water.svg        # 可选：内联 filter/shape
├─ ball.html
└─ ball.ts                # 装配 controller + 当前 skin
```

### 3.4 皮肤参数与持久化

后续 settings 可以只存：

```json
{
  "ball.skin": "water",
  "ball.motion": "normal",
  "ball.opacity": 0.88
}
```

- `ball.json` 继续只存位置，不混入皮肤设置；
- 默认内置 `classic`，皮肤加载失败自动回退 classic 并记元数据日志；
- 首版不开放任意文件路径、远程 URL 或第三方脚本，避免皮肤获得 preload/IPC 上下文。

## 4. 水球渲染技术建议

### 推荐：CSS + 内联 SVG 混合

- CSS 负责滑出、缩入、呼吸、线/球形态切换和 reduced-motion；
- 内联 SVG 的 `feTurbulence + feDisplacementMap` 只在 hover/pulse 短时启用，负责轻微液体边缘；
- 2–3 个伪元素负责内部液层、高光和细线中的流动亮点；
- 动画暂停时必须停止 SVG filter 参数更新，避免常驻 GPU 消耗。

优点：不新增依赖、可主题化、DOM 简单、方便在 E2E 中通过 `data-state` 验证。

### 不建议首版使用 Canvas/WebGL

Canvas/WebGL 能更真实，但会增加：渲染循环、DPI 适配、设备丢失、截图排除复核、自动化视觉测试难度。除非 CSS/SVG 无法达到效果，再单开技术 spike。

### 动效降级

| 场景 | 行为 |
| - | - |
| `prefers-reduced-motion: reduce` | 禁用持续波动，只保留 120ms 淡入/形态切换 |
| 窗口不在 hover/pulse/drag | 停止 turbulence 动画，使用静态水球 |
| GPU/性能异常 | 自动回退无 filter 的水球配色 |
| 暂停态 | 保留状态叠层，水波幅度降至 0 |

## 5. 性能预算

悬浮球是常驻进程，皮肤不能为了“好看”长期烧 GPU。建议写入验收：

- idle 时无 `requestAnimationFrame` 常驻循环；
- idle 时 SVG turbulence 静止；
- 只有 hover / pulse / drag 期间运行动态 filter；
- 动效停止后 300ms 内回到静态；
- 球窗口 renderer 空闲 CPU 接近当前 classic 皮肤；
- 连续 hover 60 秒无明显内存增长；
- 125% / 150% 缩放下无锯齿、裁切和窗口尺寸漂移。

## 6. 分阶段落地

### Phase S0 · 拆皮肤骨架（建议先做）

- 拆 `hitbox / visual / status overlay`；
- 把现有外观迁为 `classic`，视觉和行为保持不变；
- 建 `BallSkin` 契约和状态对象；
- 自动回缩修复完成后再接入，避免同时改两套状态机。

验收：现有 classic 的位置、缩回、拖动、暂停视觉和 E2E 全部不变。

### Phase S1 · 水球视觉 spike

- 只做 hover 水波、呼吸、四边细线形态；
- 不做设置 UI、不做第三方皮肤；
- 真机比较纯 CSS 与 CSS+SVG 两版的观感及 GPU 占用。

### Phase S2 · 皮肤选择与持久化

- 设置中选择 classic / water；
- 本地保存 skin id；
- 加载失败回退；
- 补切换皮肤时 timer/filter 清理测试。

### Phase S3 · 更多内置皮肤

可以扩展：磨砂玻璃、像素星球、极简墨点、柔光胶囊。仍只允许内置可信模块；第三方皮肤体系另立安全方案。

## 7. 验收重点

1. 换任何皮肤都不改变命中区、吸附阈值、拖动落点和 `ball.json`。
2. 水线虽然只有 3–5px，边缘唤醒热区仍稳定易用。
3. 连续 10 次线 → 球 → 线，全部正常，不闪烁、不残留 filter。
4. 四边的水线方向正确，切换边缘不需要皮肤自己计算屏幕坐标。
5. 暂停/运行状态在每款皮肤上都明确可辨，不可被装饰遮盖。
6. reduced-motion 下仍功能完整。
7. classic 皮肤作为回归基线，所有现有测试继续通过。

## 8. 推荐结论

- **水流感：可做，建议 CSS + SVG，第一版不引依赖。**
- **边缘细线：可做，但必须是“视觉细线 + 稳定透明热区”，不能把真实命中区一起压细。**
- **多皮肤：现有代码需要先做一次小型分层重构；主进程与位置逻辑基本可复用。**
- **执行顺序：先修自动缩回 → 拆 classic 皮肤骨架 → 做 water spike → 最后做皮肤选择设置。**
