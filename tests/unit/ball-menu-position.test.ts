/**
 * 球右键菜单几何（自绘菜单，D53）
 *
 * 重点：贴边停靠的球不能把菜单顶出工作区；顶部 / 底部停靠时垂直方向夹回工作区。
 */

import { describe, expect, it } from 'vitest'
import {
  MENU_ITEM_HEIGHT,
  MENU_OVERLAP,
  MENU_PADDING,
  MENU_SEPARATOR_HEIGHT,
  MENU_WIDTH,
  menuSize,
  placeBallMenu
} from '../../src/main/ball-menu-position'

const WORK_AREA = { x: 0, y: 0, width: 1536, height: 864 }
const MENU = { width: MENU_WIDTH, height: 170 }

describe('menuSize：按条目数算高', () => {
  it('项与分隔线高度不同，上下各有内边距', () => {
    expect(menuSize([])).toEqual({ width: MENU_WIDTH, height: MENU_PADDING * 2 })
    expect(menuSize([{ type: 'separator' }, { id: 'open-ask' }])).toEqual({
      width: MENU_WIDTH,
      height: MENU_PADDING * 2 + MENU_SEPARATOR_HEIGHT + MENU_ITEM_HEIGHT
    })
  })

  it('与 tray-menu 的 6 条结构一致：4 项 + 2 分隔线', () => {
    const entries = [
      { id: 'open-ask' },
      { id: 'open-settings' },
      { type: 'separator' },
      { id: 'toggle-capture' },
      { type: 'separator' },
      { id: 'quit' }
    ]
    expect(menuSize(entries).height).toBe(MENU_PADDING * 2 + MENU_ITEM_HEIGHT * 4 + MENU_SEPARATOR_HEIGHT * 2)
  })
})

describe('placeBallMenu：朝屏幕中心展开并夹回工作区', () => {
  it('右边缘停靠：菜单放在球左侧，不越出右边界', () => {
    const ball = { x: 1472, y: 364, width: 64, height: 64 }
    const { x, y } = placeBallMenu(ball, MENU, WORK_AREA)
    expect(x).toBe(ball.x - MENU.width + MENU_OVERLAP)
    expect(x + MENU.width).toBeLessThanOrEqual(ball.x + ball.width)
    expect(y).toBe(364 + 32 - 85)
  })

  it('左边缘停靠：菜单放在球右侧', () => {
    const ball = { x: 0, y: 300, width: 64, height: 64 }
    const { x } = placeBallMenu(ball, MENU, WORK_AREA)
    expect(x).toBe(ball.x + ball.width - MENU_OVERLAP)
  })

  it('顶部停靠：垂直方向夹回工作区上沿', () => {
    const ball = { x: 700, y: 0, width: 64, height: 64 }
    expect(placeBallMenu(ball, MENU, WORK_AREA).y).toBe(0)
  })

  it('底部停靠：不越出工作区下沿', () => {
    const ball = { x: 700, y: 800, width: 64, height: 64 }
    const { y } = placeBallMenu(ball, MENU, WORK_AREA)
    expect(y + MENU.height).toBeLessThanOrEqual(WORK_AREA.height)
  })

  it('第二块屏（负坐标工作区）也按屏幕中心判断方向', () => {
    const leftDisplay = { x: -1536, y: 0, width: 1536, height: 864 }
    const ball = { x: -1536, y: 400, width: 64, height: 64 }
    const { x } = placeBallMenu(ball, MENU, leftDisplay)
    expect(x).toBe(-1536 + 64 - MENU_OVERLAP)
  })

  it('工作区比菜单还窄时贴住左沿，不返回负偏移', () => {
    const small = { x: 0, y: 0, width: 120, height: 120 }
    const { x, y } = placeBallMenu({ x: 100, y: 100, width: 64, height: 64 }, MENU, small)
    expect(x).toBe(0)
    expect(y).toBe(0)
  })
})
