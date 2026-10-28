/**
 * 球右键菜单的几何（纯函数，单测覆盖）
 *
 * 球窗永远是 64×64、贴边停靠；菜单是另一个独立小窗（方案 B：自绘 HTML 菜单，
 * 不再用原生 `Menu.popup`——球窗 `focusable:false`，原生菜单收不掉，见 gotchas）。
 *
 * 规则：
 * - 水平方向朝**屏幕中心**那一侧展开：球在右半边就把菜单放在球左侧，反之放右侧；
 *   不这样做的话，贴边停靠的球会把菜单顶出工作区，只剩一半。
 * - 垂直方向**贴球角**：优先让菜单上沿对齐球上沿（球左上 / 右上角），下方放不下
 *   就翻成菜单下沿对齐球下沿（左下 / 右下角），最后再夹回工作区。
 *   不再与球心垂直居中对齐——菜单比球高得多，居中会变成「一条横在球旁边」。
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

  // 贴角：先试「上沿贴球上沿」，下方放不下（球靠近工作区底部）就翻成「下沿贴球下沿」。
  // 注意判断用菜单真实高度，不用球心——球只有 64px，菜单通常高一倍以上。
  const topAligned = ball.y
  const bottomAligned = ball.y + ball.height - menu.height
  const fitsBelow = topAligned + menu.height <= workArea.y + workArea.height
  const y = clamp(
    fitsBelow ? topAligned : bottomAligned,
    workArea.y,
    workArea.y + workArea.height - menu.height
  )
  return { x: Math.round(x), y: Math.round(y) }
}
