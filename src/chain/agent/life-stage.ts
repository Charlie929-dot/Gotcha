/**
 * 生命阶段（2026-11-03 拍板，D99）：按「剩余生命百分比」给一个展示用的阶段词。
 *
 * 只用于 `<now>` 的生命行和 `/life` 的文案——**不改**冻结 / 传承 / 工具注入的任何判定。
 * 边界（整数百分比）：>95 宝宝；86–95 少女；16–85 准妈妈；≤15 快要离开
 * （即 95 归少女、85 归准妈妈、15 归快要离开）。
 */
export type LifeStage = '宝宝' | '少女' | '准妈妈' | '快要离开'

/** 剩余百分比 → 阶段；坏值（NaN / 越界）先夹回 0–100 再判 */
export function lifeStageOf(percent: number): LifeStage {
  const value = Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : 0
  if (value > 95) return '宝宝'
  if (value > 85) return '少女'
  if (value > 15) return '准妈妈'
  return '快要离开'
}
