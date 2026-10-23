/**
 * Gotcha patch F2：相似度 → 力布局距离（方案 §6.2 `distanceFromSim`）。
 *
 * - `sim = threshold`（主题间连线最低相似度）→ 最远 `dMax`；
 * - `sim = 1` → 最近 `dMin`；
 * - 超出 `[threshold, 1]` 的输入夹取，非法输入按最远处理。
 *
 * 纯函数，可单测；渲染层不用它改线宽（线宽统一常数，避免与距离双重编码）。
 */
export function distanceFromSim(
  sim: number,
  threshold: number,
  dMin: number,
  dMax: number
): number {
  const lo = clampUnit(threshold)
  const hi = 1
  if (hi <= lo) return dMax
  const s = Number.isFinite(sim) ? Math.min(hi, Math.max(lo, sim)) : lo
  const k = (s - lo) / (hi - lo)
  return dMax + (dMin - dMax) * k
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(0.99, Math.max(0, value))
}
