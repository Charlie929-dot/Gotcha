/**
 * settings 读写（m1a-plan §2：一切自定义项进 settings 表，不建新表）
 */

import type { Db } from './index'

export const SETTING_DEFAULTS: Readonly<Record<string, string>> = {
  'capture.diff_threshold': '8',
  'capture.save_shots': '0',
  // P0-2（性能方案 §3）：旧管线默认保持原样；双写（events_mirror）默认开，
  // 观察一周覆盖后再把 metadata_only 置 1（旧管线只记 app/title，不截图、不 OCR）。
  'capture.metadata_only': '0',
  'capture.events_mirror': '1',
  // M2 归纳（D18/D22；m2-plan §3 Phase 1）
  'graph.auto': '1',
  'graph.interval_minutes': '10',
  'graph.budget_tokens_per_day': '1000000',
  'graph.retry_backoff_minutes': '1,5,15',
  // 连续失败到上限就停自动归纳（手动「立即归纳」成功一次即恢复；2026-10-24 可观测性）
  'graph.max_consecutive_failures': '5',
  'graph.batch_max_moments': '20',
  'graph.max_tokens': '2000',
  // 在线归属（P2 · S6）：采集时把新时刻本地归到主题、新主题只走命名/模糊确认两条 LLM 调用；
  // 关掉 = 回到「按日批量归纳」的老路径（`graph.auto` 控制自动跑不跑）
  'graph.online_themes': '1',
  // 本地向量模型目录（留空 = `<userData>/models/bge-small-zh-v1.5`；D29 / 方案 §10）
  'graph.embedding_model_dir': '',
  // 图谱相似度阈值（docs/m2-graph-redesign.md §5.2；在合并后的真实主题集上标定）
  'graph.theme_new_min_sim': '0.78',
  'graph.theme_member_min_sim': '0.92',
  'graph.theme_duplicate_sim': '0.92',
  'graph.theme_merge_sim': '0.95',
  'graph.theme_secondary_max': '2',
  'graph.edge_min_sim': '0.64',
  'graph.edge_top_k': '4',
  'graph.edge_mutual': '1',
  // 个人记忆（日记 = 第二本账）：目录留空 = 自动找（见 memory/persona.ts resolveVaultDir）
  'memory.vault_dir': '',
  'memory.persona_name': '贴心大肥鱼',
  'memory.persona_tone':
    '像认识很久的老朋友：短句、具体、先给结论；不确定就说不确定，可以有自己的看法，不用端着',
  'memory.persona_redlines': '',
  // 启用的人格卡（D62）：<userData>/persona-cards/ 里的 .md 文件名；空 = 不用卡
  'memory.persona_card': ''
}

export function getSetting(db: Db, key: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? SETTING_DEFAULTS[key] ?? ''
}

export function getNumberSetting(db: Db, key: string, fallback = 0): number {
  const parsed = Number(getSetting(db, key))
  return Number.isFinite(parsed) ? parsed : fallback
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value)
}
