import { describe, expect, it } from 'vitest'
import {
  BALL_SIZE,
  BALL_TUCK_OFFSET,
  BALL_WINDOW_SIZE,
  DOCK_THRESHOLD,
  clampPosition,
  clampRatio,
  dockedPosition,
  freePosition,
  nearestEdgeWithin,
  positionOnPixelGrid,
  ratioFor,
  ratiosForFree,
  resolveLayout,
  snapToPixelGrid,
  type BallDisplay,
  type BallSavedState
} from '../../src/main/ball-position'

const PRIMARY: BallDisplay = {
  id: 1,
  workArea: { x: 0, y: 0, width: 1920, height: 1080 }
}

/** 左侧副屏：负坐标工作区（多屏 clamp 的经典坑） */
const SECONDARY_LEFT: BallDisplay = {
  id: 2,
  workArea: { x: -1920, y: 0, width: 1920, height: 1080 }
}

const SPAN_X = PRIMARY.workArea.width - BALL_WINDOW_SIZE
const SPAN_Y = PRIMARY.workArea.height - BALL_WINDOW_SIZE

function saved(partial: Partial<BallSavedState>): BallSavedState {
  return {
    edge: 'right',
    offset_ratio: 0.5,
    x_ratio: 0.5,
    y_ratio: 0.5,
    display_id: PRIMARY.id,
    ...partial
  }
}

describe('停靠几何常量（D15）', () => {
  it('球体 48、窗口 64，缩进 32 后只露半颗（24px）', () => {
    expect(BALL_SIZE).toBe(48)
    expect(BALL_WINDOW_SIZE).toBe(64)
    expect(BALL_TUCK_OFFSET).toBe(32)
    // 露出宽度 = 窗口宽 - 居中留白 - 缩进量 = 64 - 8 - 32 = 24（半颗球的半径）
    expect(BALL_WINDOW_SIZE - (BALL_WINDOW_SIZE - BALL_SIZE) / 2 - BALL_TUCK_OFFSET).toBe(24)
    expect(DOCK_THRESHOLD).toBe(24)
  })
})

describe('dockedPosition：窗口贴齐边缘（球体由 renderer 缩进）', () => {
  it('右边缘垂直居中：窗口右缘贴工作区右缘', () => {
    expect(dockedPosition('right', 0.5, PRIMARY.workArea)).toEqual({
      x: 1920 - BALL_WINDOW_SIZE,
      y: (1080 - BALL_WINDOW_SIZE) / 2
    })
  })

  it('四条边都贴齐（无 6px 内缩）', () => {
    expect(dockedPosition('left', 0, PRIMARY.workArea)).toEqual({ x: 0, y: 0 })
    expect(dockedPosition('right', 1, PRIMARY.workArea)).toEqual({
      x: 1920 - BALL_WINDOW_SIZE,
      y: SPAN_Y
    })
    expect(dockedPosition('top', 0.5, PRIMARY.workArea)).toEqual({
      x: SPAN_X / 2,
      y: 0
    })
    expect(dockedPosition('bottom', 1, PRIMARY.workArea)).toEqual({
      x: SPAN_X,
      y: 1080 - BALL_WINDOW_SIZE
    })
  })

  it('负坐标工作区（左侧副屏）不丢符号', () => {
    expect(dockedPosition('left', 0.5, SECONDARY_LEFT.workArea)).toEqual({
      x: -1920,
      y: SPAN_Y / 2
    })
  })

  it('比例越界被夹到 [0,1]', () => {
    expect(dockedPosition('right', -5, PRIMARY.workArea)).toEqual(
      dockedPosition('right', 0, PRIMARY.workArea)
    )
    expect(dockedPosition('right', 5, PRIMARY.workArea)).toEqual(
      dockedPosition('right', 1, PRIMARY.workArea)
    )
  })

  it('窗口比工作区还大时贴左上，不产生负坐标', () => {
    expect(dockedPosition('right', 0.5, { x: 0, y: 0, width: 40, height: 40 })).toEqual({
      x: 0,
      y: 0
    })
  })
})

describe('freePosition：自由停在原地（按工作区比例）', () => {
  it('0.5 / 0.5 即工作区居中', () => {
    expect(freePosition(0.5, 0.5, PRIMARY.workArea)).toEqual({
      x: SPAN_X / 2,
      y: SPAN_Y / 2
    })
  })

  it('边界比例对应工作区两端', () => {
    expect(freePosition(0, 0, PRIMARY.workArea)).toEqual({ x: 0, y: 0 })
    expect(freePosition(1, 1, PRIMARY.workArea)).toEqual({ x: SPAN_X, y: SPAN_Y })
  })

  it('比例越界被夹紧', () => {
    expect(freePosition(-1, 2, PRIMARY.workArea)).toEqual({ x: 0, y: SPAN_Y })
  })
})

describe('clampPosition', () => {
  it('负坐标夹回工作区', () => {
    expect(clampPosition({ x: -120, y: -40 }, PRIMARY.workArea)).toEqual({ x: 0, y: 0 })
  })

  it('越界夹到右下极限', () => {
    expect(clampPosition({ x: 9999, y: 9999 }, PRIMARY.workArea)).toEqual({ x: SPAN_X, y: SPAN_Y })
  })

  it('负坐标工作区的边界方向正确', () => {
    expect(clampPosition({ x: -3000, y: 0 }, SECONDARY_LEFT.workArea)).toEqual({ x: -1920, y: 0 })
  })
})

describe('nearestEdgeWithin：≤24px 才吸附', () => {
  it('贴右缘吸附 right', () => {
    expect(nearestEdgeWithin({ x: SPAN_X, y: 400 }, PRIMARY.workArea)).toBe('right')
  })

  it('距右缘 20px 吸附，距右缘 30px 不吸附（自由）', () => {
    expect(nearestEdgeWithin({ x: SPAN_X - 20, y: 400 }, PRIMARY.workArea)).toBe('right')
    expect(nearestEdgeWithin({ x: SPAN_X - 30, y: 400 }, PRIMARY.workArea)).toBeNull()
  })

  it('四边分别吸附', () => {
    expect(nearestEdgeWithin({ x: 10, y: 400 }, PRIMARY.workArea)).toBe('left')
    expect(nearestEdgeWithin({ x: 800, y: 10 }, PRIMARY.workArea)).toBe('top')
    expect(nearestEdgeWithin({ x: 800, y: 1080 - BALL_WINDOW_SIZE - 10 }, PRIMARY.workArea)).toBe(
      'bottom'
    )
  })

  it('拖出屏外（负坐标）仍按最近边吸附', () => {
    expect(nearestEdgeWithin({ x: -40, y: 400 }, PRIMARY.workArea)).toBe('left')
    expect(nearestEdgeWithin({ x: SPAN_X + 40, y: 400 }, PRIMARY.workArea)).toBe('right')
  })

  it('工作区中间返回 null（自由位）', () => {
    expect(nearestEdgeWithin({ x: 800, y: 400 }, PRIMARY.workArea)).toBeNull()
  })
})

describe('ratioFor / ratiosForFree', () => {
  it.each(['left', 'right', 'top', 'bottom'] as const)('%s 边停靠位置 ↔ 比例往返一致', (edge) => {
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      const position = dockedPosition(edge, ratio, PRIMARY.workArea)
      expect(ratioFor(edge, position, PRIMARY.workArea)).toBeCloseTo(ratio, 6)
    }
  })

  it('自由位比例往返一致', () => {
    const position = freePosition(0.25, 0.75, PRIMARY.workArea)
    expect(ratiosForFree(position, PRIMARY.workArea)).toEqual({ xRatio: 0.25, yRatio: 0.75 })
  })

  it('工作区跨度不足时比例归 0，不产生 NaN', () => {
    expect(ratioFor('right', { x: 0, y: 0 }, { x: 0, y: 0, width: 30, height: 30 })).toBe(0)
  })
})

describe('clampRatio', () => {
  it('非有限数归 0', () => {
    expect(clampRatio(Number.NaN)).toBe(0)
    expect(clampRatio(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('snapToPixelGrid：非整数缩放下的像素网格吸附', () => {
  it('125%：吸附到 DIP×1.25 为整数的最近整数坐标', () => {
    expect(snapToPixelGrid(1466, 1.25)).toBe(1464)
    expect(snapToPixelGrid(1464, 1.25)).toBe(1464)
    expect(snapToPixelGrid(376, 1.25)).toBe(376)
  })

  it('100% / 200% 缩放：整数 DIP 本身就在网格上', () => {
    expect(snapToPixelGrid(1466, 1)).toBe(1466)
    expect(snapToPixelGrid(1466, 2)).toBe(1466)
  })

  it('150%：偶数 DIP 在网格上，奇数会就近吸附', () => {
    expect(snapToPixelGrid(1466, 1.5)).toBe(1466)
    expect(snapToPixelGrid(1465, 1.5)).toBe(1464)
  })

  it('非法缩放按 1 处理（取整）', () => {
    expect(snapToPixelGrid(1466.4, Number.NaN)).toBe(1466)
    expect(snapToPixelGrid(1466.4, 0)).toBe(1466)
  })

  it('positionOnPixelGrid 对 x / y 分别吸附', () => {
    expect(positionOnPixelGrid({ x: 1466, y: 377 }, 1.25)).toEqual({ x: 1464, y: 376 })
  })
})

describe('resolveLayout：默认态、停靠 / 自由、多屏回退', () => {
  it('无落盘状态：主屏右边缘垂直居中、停靠态', () => {
    expect(resolveLayout(null, [PRIMARY], PRIMARY.id)).toEqual({
      displayId: PRIMARY.id,
      docked: true,
      edge: 'right',
      offsetRatio: 0.5,
      position: dockedPosition('right', 0.5, PRIMARY.workArea)
    })
  })

  it('落盘停靠态命中副屏：在原显示器上还原', () => {
    const layout = resolveLayout(
      saved({ edge: 'left', offset_ratio: 0.25, display_id: SECONDARY_LEFT.id }),
      [PRIMARY, SECONDARY_LEFT],
      PRIMARY.id
    )
    expect(layout.displayId).toBe(SECONDARY_LEFT.id)
    expect(layout.docked).toBe(true)
    expect(layout.edge).toBe('left')
    expect(layout.position).toEqual(dockedPosition('left', 0.25, SECONDARY_LEFT.workArea))
  })

  it('落盘自由态：按 x/y 比例还原窗口位置', () => {
    const layout = resolveLayout(
      saved({ edge: null, x_ratio: 0.2, y_ratio: 0.8 }),
      [PRIMARY],
      PRIMARY.id
    )
    expect(layout.docked).toBe(false)
    expect(layout.edge).toBeNull()
    expect(layout.position).toEqual(freePosition(0.2, 0.8, PRIMARY.workArea))
  })

  it('display_id 已失效（拔屏）：回退主屏，保留边缘与比例', () => {
    const layout = resolveLayout(
      saved({ edge: 'bottom', offset_ratio: 0.75, display_id: 999 }),
      [PRIMARY],
      PRIMARY.id
    )
    expect(layout.displayId).toBe(PRIMARY.id)
    expect(layout.edge).toBe('bottom')
    expect(layout.offsetRatio).toBe(0.75)
    expect(layout.position).toEqual(dockedPosition('bottom', 0.75, PRIMARY.workArea))
  })

  it('比例越界（旧文件）被夹到 [0,1]', () => {
    const layout = resolveLayout(saved({ offset_ratio: 2 }), [PRIMARY], PRIMARY.id)
    expect(layout.offsetRatio).toBe(1)
  })
})
