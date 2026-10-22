import { describe, expect, it } from 'vitest'
import {
  BALL_EDGE_OFFSET,
  BALL_WINDOW_SIZE,
  clampPosition,
  clampRatio,
  nearestEdge,
  positionFor,
  positionOnPixelGrid,
  ratioFor,
  resolveLayout,
  snapToPixelGrid,
  type BallDisplay
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

/** 主屏上方副屏：负 y */
const SECONDARY_TOP: BallDisplay = {
  id: 3,
  workArea: { x: 0, y: -1080, width: 1920, height: 1080 }
}

const SPAN_X = PRIMARY.workArea.width - BALL_WINDOW_SIZE
const SPAN_Y = PRIMARY.workArea.height - BALL_WINDOW_SIZE

describe('positionFor：贴边位置', () => {
  it('默认右边缘垂直居中（B1）', () => {
    expect(positionFor('right', 0.5, PRIMARY.workArea)).toEqual({
      x: 1920 - BALL_WINDOW_SIZE - BALL_EDGE_OFFSET,
      y: (1080 - BALL_WINDOW_SIZE) / 2
    })
  })

  it('四条边都按 6px 内缩，窗口完整落在工作区内', () => {
    expect(positionFor('left', 0, PRIMARY.workArea)).toEqual({ x: BALL_EDGE_OFFSET, y: 0 })
    expect(positionFor('right', 1, PRIMARY.workArea)).toEqual({
      x: 1920 - BALL_WINDOW_SIZE - BALL_EDGE_OFFSET,
      y: SPAN_Y
    })
    expect(positionFor('top', 0, PRIMARY.workArea)).toEqual({ x: 0, y: BALL_EDGE_OFFSET })
    expect(positionFor('bottom', 1, PRIMARY.workArea)).toEqual({
      x: SPAN_X,
      y: 1080 - BALL_WINDOW_SIZE - BALL_EDGE_OFFSET
    })
  })

  it('负坐标工作区（左侧副屏）不丢符号', () => {
    expect(positionFor('right', 0.5, SECONDARY_LEFT.workArea)).toEqual({
      x: -1920 + 1920 - BALL_WINDOW_SIZE - BALL_EDGE_OFFSET,
      y: SPAN_Y / 2
    })
  })

  it('负 y 工作区（上方副屏）垂直居中仍正确', () => {
    expect(positionFor('top', 0.5, SECONDARY_TOP.workArea)).toEqual({
      x: SPAN_X / 2,
      y: -1080 + BALL_EDGE_OFFSET
    })
  })

  it('比例越界被夹到 [0,1]', () => {
    expect(positionFor('right', -5, PRIMARY.workArea)).toEqual(positionFor('right', 0, PRIMARY.workArea))
    expect(positionFor('right', 5, PRIMARY.workArea)).toEqual(positionFor('right', 1, PRIMARY.workArea))
  })

  it('窗口比工作区还大时贴左上，不产生负坐标', () => {
    expect(positionFor('right', 0.5, { x: 0, y: 0, width: 40, height: 40 })).toEqual({ x: 0, y: 0 })
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

describe('nearestEdge：吸附到最近边缘', () => {
  it('贴近左边吸附 left', () => {
    expect(nearestEdge({ x: 4, y: 400 }, PRIMARY.workArea)).toBe('left')
  })

  it('贴近右边吸附 right', () => {
    expect(nearestEdge({ x: 1850, y: 400 }, PRIMARY.workArea)).toBe('right')
  })

  it('贴近上缘吸附 top', () => {
    expect(nearestEdge({ x: 800, y: 2 }, PRIMARY.workArea)).toBe('top')
  })

  it('贴近下缘吸附 bottom', () => {
    expect(nearestEdge({ x: 800, y: 1010 }, PRIMARY.workArea)).toBe('bottom')
  })

  it('负坐标副屏吸附仍取最近的边', () => {
    expect(nearestEdge({ x: -1915, y: 400 }, SECONDARY_LEFT.workArea)).toBe('left')
  })
})

describe('ratioFor：吸附后落盘比例', () => {
  it.each(['left', 'right', 'top', 'bottom'] as const)('%s 边位置 ↔ 比例往返一致', (edge) => {
    for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
      const position = positionFor(edge, ratio, PRIMARY.workArea)
      expect(ratioFor(edge, position, PRIMARY.workArea)).toBeCloseTo(ratio, 6)
    }
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
    // 1466 × 1.25 = 1832.5（非整数物理像素）→ 1464 × 1.25 = 1830
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

describe('resolveLayout：默认态与多屏回退', () => {
  it('无落盘状态：主屏右边缘垂直居中', () => {
    expect(resolveLayout(null, [PRIMARY], PRIMARY.id)).toEqual({
      displayId: PRIMARY.id,
      edge: 'right',
      offsetRatio: 0.5,
      position: positionFor('right', 0.5, PRIMARY.workArea)
    })
  })

  it('落盘状态命中副屏：在原显示器上还原', () => {
    const layout = resolveLayout(
      { edge: 'left', offset_ratio: 0.25, display_id: SECONDARY_LEFT.id },
      [PRIMARY, SECONDARY_LEFT],
      PRIMARY.id
    )
    expect(layout.displayId).toBe(SECONDARY_LEFT.id)
    expect(layout.edge).toBe('left')
    expect(layout.position).toEqual(positionFor('left', 0.25, SECONDARY_LEFT.workArea))
  })

  it('display_id 已失效（拔屏）：回退主屏，保留边缘与比例', () => {
    const layout = resolveLayout(
      { edge: 'bottom', offset_ratio: 0.75, display_id: 999 },
      [PRIMARY],
      PRIMARY.id
    )
    expect(layout.displayId).toBe(PRIMARY.id)
    expect(layout.edge).toBe('bottom')
    expect(layout.offsetRatio).toBe(0.75)
    expect(layout.position).toEqual(positionFor('bottom', 0.75, PRIMARY.workArea))
  })

  it('比例越界（旧文件）被夹到 [0,1]', () => {
    const layout = resolveLayout(
      { edge: 'right', offset_ratio: 2, display_id: PRIMARY.id },
      [PRIMARY],
      PRIMARY.id
    )
    expect(layout.offsetRatio).toBe(1)
  })
})
