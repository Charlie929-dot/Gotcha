/**
 * E2E 只读/受控钩子的共享类型（经典 sigma 页与全局 Foam 页共用）。
 *
 * 两个页面都会挂 `window.__gotchaGraphView`；字段取并集，页面各自实现可用子集。
 * 不用它做业务逻辑，只给 Playwright 在没有像素点击条件时走同一交互路径。
 */

export interface GraphViewHook {
  count(): number
  select(nodeId: number | string): Promise<void>
  hover(nodeId: number | string | null): void
  focus(nodeId: number | string): void
  clearFocus(): void
  position(nodeId: number | string): { x: number; y: number } | null
  filters(): Record<string, boolean>
  visibleCounts(): { nodes: number; edges: number; themes?: number; moments?: number }
  /** 全局页专有（经典页不实现） */
  dimmedCount?(): number
  focusDays?(): string[] | null
  setDays?(list: string[] | null): void
  /** 时段（一天内的起止分钟）；E2E 用来跳过滚轮像素操作 */
  clock?(): { fromMinute: number; toMinute: number }
  setClock?(fromMinute: number, toMinute: number): void
  /** 文字筛选命中的时刻 id；null＝没按文字筛 */
  searchHits?(): number[] | null
  onlyThemes?(): boolean
  setOnlyThemes?(value: boolean): void
  nodeIds?(): string[]
}

declare global {
  interface Window {
    __gotchaGraphView?: GraphViewHook
  }
}
