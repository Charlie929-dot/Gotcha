/**
 * 信息链 · 数据新鲜度（问记忆工具循环的注入项）
 *
 * 为什么需要：模型不知道「现在几点」「数据到哪一刻」，于是把「昨天下午」「刚刚」
 * 全都答错（召回根因 1 / 5）。这一层只做一件事：用一条只读 SQL 给出
 * 「最新证据到什么时候」，由系统提示注入，模型自己换算毫秒时间戳再调工具。
 *
 * 口径拍板（方案定稿）：`MAX(chain_segment.start_ts)`；有开着的段（`closed=0`）时，
 * 证据事实上延续到「现在」——开段的 `end_ts` 只是暂定值，不拿它骗模型。
 */
import type { ChainDb } from '../store'

/** 新鲜度（数字是毫秒时间戳；空库为 null，模型据此知道「什么都没有」） */
export interface ChainFreshness {
  latestEvidenceTs: number | null
}

/**
 * 读最新证据时刻。只读：不写表、不建派生、不出网。
 *
 * @param now 「现在」（毫秒）；开段在场时按 `max(MAX(start_ts), now)` 报——
 *            测试注入固定钟，主进程传 `Date.now()`
 */
export function readChainFreshness(db: ChainDb, now: number): ChainFreshness {
  const row = db
    .prepare(
      'SELECT MAX(start_ts) AS maxTs, MAX(CASE WHEN closed = 0 THEN 1 ELSE 0 END) AS hasOpen FROM chain_segment'
    )
    .get() as { maxTs: number | null; hasOpen: number }
  if (row.maxTs === null) return { latestEvidenceTs: null }
  // 开段算「现在」：证据还在长，如实报到当下（max 兜底时钟回拨 / 未来时间戳）
  return { latestEvidenceTs: row.hasOpen === 1 ? Math.max(row.maxTs, now) : row.maxTs }
}
