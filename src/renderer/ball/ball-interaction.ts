/**
 * 悬浮球交互状态机（m1b-plan §3 Phase 1 / D16，2026-10-23 拍板）
 *
 * 纯函数：不碰 DOM、Electron 与计时器。`ball.ts` 把指针事件换算成「到球心距离」后
 * 交给这里，再按返回的快照更新 class、穿透开关与状态通道。
 *
 * 状态：
 * - `idle`：停靠缩入（未展开）或自由位常态；窗口是否可交互由 `pointerInside` 决定。
 * - `expanded`：停靠悬停展开（全显）；窗口必须保持可交互，否则收不到离开事件。
 * - `grace`：指针离开窗口后的宽限期（仍全显、仍可交互），600ms 内回来即恢复。
 * - `dragging`：拖动中；不自动缩回。
 *
 * 为什么不再用「球心距离」判定收起（真机坑，见 gotchas）：
 * 旧实现展开后指针离球心 > 24px 就恢复鼠标穿透、> 40px 才收起。指针停在 24–40px
 * 中间带时球仍展开、窗口却已穿透，后续 move / leave 事件收不到，球会卡在展开态。
 * 现在收起只由「离开窗口且宽限期到期」或主进程兜底触发；距离只负责展开入口与
 * 球体命中（hover / 点击）。
 */

export type BallInteractionState = 'idle' | 'expanded' | 'grace' | 'dragging'

/** 球体半径（48px 直径）：hover 与点击命中 */
export const BALL_HIT_RADIUS = 24

/** 停靠缩入态的展开热区：可见半球 24px 再向屏幕内侧放宽 8px（D16） */
export const BALL_HOT_RADIUS = BALL_HIT_RADIUS + 8

/** 离开窗口后的宽限时长：600ms 内回到窗口内即取消缩回（D16） */
export const BALL_GRACE_MS = 600

export interface BallInteractionSnapshot {
  state: BallInteractionState
  /** 指针是否在球体命中半径内；决定自由位 / 停靠 idle 的窗口可交互性与 hover 放大 */
  pointerInside: boolean
}

export interface BallPointerGeometry {
  /** 当前布局是否停靠 */
  docked: boolean
  /** 指针到球心距离（client px，用实时包围盒算，缩进 / 过渡期间都准） */
  distance: number
}

export type BallInteractionEvent =
  | { type: 'placement'; docked: boolean }
  | { type: 'pointer-move'; geometry: BallPointerGeometry }
  | { type: 'pointer-leave' }
  | { type: 'pointer-down'; geometry: BallPointerGeometry }
  | { type: 'pointer-up'; docked: boolean }
  | { type: 'pointer-cancel' }
  | { type: 'grace-expired' }
  | { type: 'force-retract' }

export function initialSnapshot(): BallInteractionSnapshot {
  return { state: 'idle', pointerInside: false }
}

/** 视觉是否全显（展开 / 宽限 / 拖动都保持滑出，不再缩入） */
export function isExpanded(snapshot: BallInteractionSnapshot): boolean {
  return snapshot.state !== 'idle'
}

export function reduceInteraction(
  snapshot: BallInteractionSnapshot,
  event: BallInteractionEvent
): BallInteractionSnapshot {
  switch (event.type) {
    case 'placement':
      // 主进程落位（拖动松手 / 屏幕变化）后由停靠状态决定缩入或自由，先回到 idle
      return { state: 'idle', pointerInside: false }

    case 'pointer-move': {
      const { docked, distance } = event.geometry
      if (snapshot.state === 'dragging') return snapshot
      let state = snapshot.state
      if (docked) {
        if (state === 'idle' && distance <= BALL_HOT_RADIUS) state = 'expanded'
        else if (state === 'grace') state = 'expanded'
      }
      return { state, pointerInside: distance <= BALL_HIT_RADIUS }
    }

    case 'pointer-leave':
      if (snapshot.state === 'dragging') return snapshot
      if (snapshot.state === 'expanded') return { state: 'grace', pointerInside: false }
      return { state: snapshot.state, pointerInside: false }

    case 'pointer-down': {
      if (event.geometry.distance > BALL_HIT_RADIUS) return snapshot
      return { state: 'dragging', pointerInside: true }
    }

    case 'pointer-up':
      // 未拖动的按下-释放按点击处理：指针还在球上，停靠态保持展开；移动后的落位由
      // 主进程 placement 消息重置（见 onDragEnd -> settleAt -> pushPlacement）
      if (snapshot.state !== 'dragging') return snapshot
      return { state: event.docked ? 'expanded' : 'idle', pointerInside: true }

    case 'pointer-cancel':
      if (snapshot.state !== 'dragging') return snapshot
      return { state: 'idle', pointerInside: false }

    case 'grace-expired':
      if (snapshot.state !== 'grace') return snapshot
      return { state: 'idle', pointerInside: false }

    case 'force-retract':
      // 主进程兜底：只处理展开 / 宽限，拖动与已缩回时忽略
      if (snapshot.state === 'expanded' || snapshot.state === 'grace') {
        return { state: 'idle', pointerInside: false }
      }
      return snapshot
  }
}
