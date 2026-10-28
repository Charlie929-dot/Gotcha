/**
 * 球右键菜单的几何（纯函数，单测覆盖）
 *
 * 球窗永远是 64×64、贴边停靠；菜单是另一个独立小窗（方案 B：自绘 HTML 菜单，
 * 不再用原生 `Menu.popup`——球窗 `focusable:false`，原生菜单收不掉，见 gotchas）。
 *
 * 规则：
 * - 水平方向朝**屏幕中心**那一侧展开：球在右半边就把菜单放在球左侧，反之放右侧；
 *   不这样做的话，贴边停靠的球会把菜单顶出工作区，只剩一半。
 * - 垂直方向与球心对齐，越界就夹回工作区（顶部 / 底部停靠时）。
 * - 允许和球重叠 `OVERLAP`，看起来像从球上长出来的。
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface MenuSize {
  width: number
  height: number
}

/** 单个菜单项 / 分隔线的高度（与 menu.css 对齐） */
export const MENU_ITEM_HEIGHT = 32
export const MENU_SEPARATOR_HEIGHT = 9
export const MENU_PADDING = 6
export const MENU_WIDTH = 176
/** 菜单与球重叠的量：视觉上贴着球，又不挡住球心 */
export const MENU_OVERLAP = 10

/** 菜单窗尺寸：按条目数算高（分隔线矮一截），宽度固定 */
export function menuSize(entries: readonly unknown[]): MenuSize {
  let height = MENU_PADDING * 2
  for (const entry of entries) {
    const isSeparator =
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { type?: unknown }).type === 'separator'
    height += isSeparator ? MENU_SEPARATOR_HEIGHT : MENU_ITEM_HEIGHT
  }
  return { width: MENU_WIDTH, height }
}

/** 夹在 [min, max+1) 里；工作区比菜单还小时让菜单贴住左 / 上边 */
function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

export function placeBallMenu(ball: Rect, menu: MenuSize, workArea: Rect): { x: number; y: number } {
  const centerX = ball.x + ball.width / 2
  const openLeft = centerX > workArea.x + workArea.width / 2
  const rawX = openLeft
    ? ball.x - menu.width + MENU_OVERLAP
    : ball.x + ball.width - MENU_OVERLAP
  const x = clamp(rawX, workArea.x, workArea.x + workArea.width - menu.width)
  const rawY = ball.y + ball.height / 2 - menu.height / 2
  const y = clamp(rawY, workArea.y, workArea.y + workArea.height - menu.height)
  return { x: Math.round(x), y: Math.round(y) }
}
