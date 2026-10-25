/**
 * 「时刻过多」提示（P3-b；§12「>2k 时刻提示收窄」）
 *
 * 纯函数：只决定要不要提示、提示什么文案。阈值来自设置（默认 2k，抽屉可调），
 * 「只看主题」时时刻层已隐藏，不再提示。这里不碰 DOM，渲染层只写 hidden / 文本。
 */

/** 缺省阈值：与主进程 `DEFAULT_SCALE_HINT_MOMENTS` 保持一致（单测钉住） */
export const DEFAULT_SCALE_HINT_MOMENTS = 2_000

/**
 * 要不要给「先收窄」的提示。
 * @param moments 当前画布上的可见时刻数（有归属的时刻，不含悬空时刻）
 * @param threshold 设置里的阈值（时刻数**超过**它才提示）
 * @param onlyThemes 是否已切「只看主题」（时刻层隐藏时不提示）
 */
export function scaleHintText(
  moments: number,
  threshold: number,
  onlyThemes: boolean
): string | null {
  if (onlyThemes) return null
  if (!Number.isFinite(moments) || moments <= 0) return null
  if (!Number.isFinite(threshold) || threshold <= 0) return null
  if (moments <= threshold) return null
  // 时间筛选只调暗不删节点（§8），收窄日期并不会减少画布上的时刻——
  // 所以这里只推荐「只看主题」，别把收窄日期写成能减负的操作。
  return `已显示 ${moments} 个时刻（提示阈值 ${threshold} 个）：时刻层较多时画布可能偏卡，可切「只看主题」。`
}
