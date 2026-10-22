# M1b 悬浮球自动缩回 · 交互修订草案（v0.1）

> 状态：**待拍板，不是已生效决策**（2026-10-22）。
> 目的：解决“球第一次能缩回，滑出后经常很难再次缩回”的真机问题；对齐市面悬浮球的稳定边缘入口、离开延迟收起与低干扰原则。
> 边界：不推翻 D15——停靠仍露出 24px、悬停滑出、自由位仍停在原地、离边 ≤24px 才吸附；本草案只修订停靠态的命中与自动缩回机制。

## 1. 现状与问题

当前实现把三个不同概念绑在同一个实时圆形距离上：

1. 球是否展开（`expanded`）；
2. 窗口是否接收鼠标（`setIgnoreMouseEvents`）；
3. 球是否处于视觉 hover。

现有阈值是：进入半径 24px、缩回半径 40px，但窗口在指针离球心超过 24px 时就恢复鼠标穿透。于是指针可能先进入 **24–40px 的中间带**：球仍保持展开，窗口却已经穿透，后续移动/离开事件可能收不到，导致球卡在展开态。E2E 只覆盖了一次“直接移到左上角”的理想路径，没有覆盖慢速移出、反复滑入滑出和事件丢失。

**判断（高置信，待真机埋点/修复验证）**：问题不是 160ms 动画本身，而是“视觉收起阈值晚于鼠标穿透阈值”，使收起链路失去事件来源。

## 2. 市面产品的共同做法

| 产品 | 官方可见行为 | 可借鉴点 |
| - | - | - |
| 小米 Quick ball | 可拖动、半透明；支持“闲置 3 秒后贴边”；支持配置屏幕边缘唤醒区域；全屏时自动移到边缘 | **空闲自动回边 + 固定边缘唤醒区**，不要求用户精准追逐移动球体 |
| Apple AssistiveTouch | 按钮可拖动；支持调节 Idle Opacity | 空闲态应降低遮挡，交互目标保持可预测 |
| OPPO Assistive Ball | 支持空闲透明度、全屏自动隐藏，并提供边缘恢复方式 | 收起后仍应保留明确、稳定的找回入口 |
| Samsung Assistant menu | 常驻浮标，可调透明度，点击后略放大并出现菜单 | 交互态与空闲态有明确视觉差异，不依赖极窄命中区 |

**归纳**：正常悬浮球不是“离开 1px 就立即消失”，也不是“靠连续 pointermove 才能收起”；而是采用稳定边缘入口、短暂离开宽限、空闲降干扰，并确保任何一次展开都能确定地回到停靠态。

资料来源（均为官方资料，检索于 2026-10-22）：

- 小米支持：《Introduction to using Accessibility features on the phone》——明确写有闲置 3 秒贴边、默认屏幕边缘唤醒区且可调大小、全屏自动移到边缘：<https://www.mi.com/uk/support/faq/details/KA-728047/>
- Apple 支持：《Use AssistiveTouch on iPhone》——按钮可拖动，并可设置 Idle Opacity：<https://support.apple.com/guide/iphone/use-assistivetouch-iph96b21954/ios>
- OPPO 支持：《The Assistive Ball on OPPO Phone》——可设置空闲透明度、全屏自动隐藏，并从顶部边缘恢复：<https://support.oppo.com/my/answer/?aid=neu1410>
- Samsung 用户手册 Assistant menu——浮标可调透明度，点击时图标略微放大并展开菜单：<https://images.samsung.com/is/content/samsung/assets/fr/support/warranty/refurbished-devices-information-warranty/s23-series-sm-s91x-um-eu-uu-eng-rev-1-1-240417.pdf>

## 3. 推荐交互（方案 A）

### 3.1 状态机

```text
DOCKED_IDLE（缩入，露 24px）
  └─ 指针进入固定边缘热区 → DOCKED_EXPANDED

DOCKED_EXPANDED（全显）
  ├─ 指针仍在安全区 → 保持
  ├─ 指针离开安全区 → DOCKED_GRACE（启动 600ms 收起计时）
  └─ pointerdown → DRAGGING

DOCKED_GRACE（全显，等待用户回头）
  ├─ 600ms 内重新进入 → DOCKED_EXPANDED（取消计时）
  └─ 计时结束且指针仍在安全区外 → DOCKED_IDLE

DRAGGING
  ├─ 松手离边 ≤24px → DOCKED_IDLE（吸附后缩入）
  └─ 其余位置 → FREE（完整可见，不自动缩边）
```

### 3.2 命中原则

1. **视觉球、唤醒热区、鼠标穿透分离**：不再用同一个 24px 半径同时控制三件事。
2. **展开或宽限期间禁止穿透**：`DOCKED_EXPANDED / DOCKED_GRACE / DRAGGING` 都保持 `setIgnoreMouseEvents(false)`；只有回到 `DOCKED_IDLE` 后才恢复穿透。
3. **固定边缘热区**：缩入态使用窗口内靠屏幕一侧的可见半球作为入口，可额外向屏幕内侧放宽 8px；热区不随 CSS transform 移动。
4. **安全区按窗口而不是瞬时球心计算**：展开后，指针只要仍在 64×64 球窗口（可加 4–8px 容差）内，就不触发收起。
5. **离开延迟收起**：指针离开安全区后等待 600ms；用户短暂划过边缘或想回点时不闪烁。
6. **主进程兜底游标检查**：展开期间每 50ms 用 Electron `screen.getCursorScreenPoint()` 检查指针是否仍在窗口安全区；即使 renderer 丢了 `pointerleave`，也能在宽限后收回。该检查仅在展开/宽限/拖动状态运行，不是全局键鼠钩子。
7. **重复操作幂等**：每次重新进入都取消旧收起 timer；任意时刻最多一个 timer、一个 cursor watcher。

Electron 官方对 `win.setIgnoreMouseEvents(true, { forward: true })` 的定义是：忽略窗口鼠标事件，同时在 macOS/Windows 把移动消息转发给 Chromium，使 renderer 可收到 `mouseleave` 等事件；但该机制并不等于区域级命中 API，且 Windows 上高完整性级别程序在前台时可能收不到转发事件。因此最终收起不能只依赖 renderer 连续事件。官方资料：<https://www.electronjs.org/docs/latest/api/browser-window#winsetignoremouseeventsignore-options>。

### 3.3 建议参数

| 参数 | 建议值 | 说明 |
| - | -: | - |
| 缩入露出 | 24px | 维持 D15 |
| 滑出/缩回动画 | 180ms ease-out | 160ms 可保留；180ms 更柔和，非本问题关键 |
| 离开宽限 | 600ms | 避免误划过即收起，同时不会显得“赖着不走” |
| 安全区容差 | 8px | 解决缩放、阴影与指针临界抖动 |
| 游标兜底轮询 | 50ms | 仅展开时运行，20Hz 足够，开销可控 |
| 最迟自动缩回 | 离开后 ≤900ms | 600ms 宽限 + 动画与调度余量 |

首版不提供设置项，先以统一默认值验证手感；真机感觉偏黏时把宽限调到 450ms，偏敏感时调到 750ms。

## 4. 为什么不直接照搬“小米 3 秒自动贴边”

小米的“闲置 3 秒后贴边”主要解决自由浮球自动回边。D15 已明确：记忆球拖到中间松手后应停在原地，只有靠近边缘才吸附。直接照搬会推翻已拍板的自由位语义。

本草案只借鉴其两个原则：

- 收起由**空闲/离开机制**可靠触发，而不是依赖精准半径；
- 缩入后有**固定边缘唤醒区域**，用户始终知道从哪里找回。

若未来希望自由位也自动贴边，应另开产品决策，不与本次 Bug 修复混做。

## 5. 实现改动草图（拍板后执行）

1. `src/renderer/ball/ball.ts`
   - 把 `expanded/pointerInside` 布尔组合改为显式交互状态；
   - 收起计时独立管理；
   - 不再在 `distance > 24` 时立刻开启穿透；
   - renderer 只上报状态变化，不靠连续事件保证最终收起。
2. `src/main/ball.ts` / `ball-preload.ts`
   - 增加最小的展开态游标兜底通道，或由主进程直接管理 watcher；
   - 所有 IPC 继续校验球窗口 sender；
   - watcher 在 idle/dispose 时必须清理。
3. `src/renderer/ball/ball.css`
   - 动画曲线微调；
   - 不改变 24px 露出量与 48px 球体尺寸。
4. 测试与文档
   - 补状态机纯函数单测；
   - 补重复循环 E2E；
   - 拍板后新增 decisions D16，并同步 m1b-plan / gotchas / workflow。

## 6. 验收标准

### 自动化

1. **连续 10 次**“进入 → 滑出 → 离开 → 缩回”，10/10 成功；不能只测一次。
2. 慢速离开：指针经过原 24–40px 中间带，仍在 ≤900ms 内缩回。
3. 快速离开窗口：即使 renderer 后续不再收到 pointermove，也会缩回。
4. 宽限回头：离开 300ms 后重新进入，不收回、不闪烁。
5. 宽限后回头：已开始缩回时重新进入，可平滑反向展开，不跳帧。
6. 四边停靠均过；125% / 150% DPI 均过。
7. 拖动时不自动缩回；自由位不执行停靠态自动缩回。
8. dispose 后无 timer / watcher 残留。

### 真机

1. 正常速度移开，不需要刻意把鼠标甩到窗口角落，球会自然缩回。
2. 球展开后沿边缘上下经过，不出现展开/缩回闪烁。
3. 想点击球时，短暂移出再移回不会“躲开鼠标”。
4. 球缩入后，露出的 24px 入口容易再次唤醒。
5. 空闲 CPU 无可感知增加；展开态 watcher 不影响拖动跟手。

## 7. 待拍板

| # | 问题 | 推荐 |
| - | - | - |
| Q1 | 离开后多久缩回 | **600ms**；可接受区间 450–750ms |
| Q2 | 是否加主进程游标兜底 | **加**；仅展开态 50ms 检查，保证事件丢失也能收回 |
| Q3 | 是否让自由位闲置后自动贴边 | **不加**；维持 D15“松手停在原地” |
| Q4 | 动画是否从 160ms 改 180ms | 可选；先修命中链路，动画不是根因 |

**建议拍板口径**：采用方案 A；Q1=600ms、Q2=加、Q3=不加、Q4=保持 160ms 先不动。
