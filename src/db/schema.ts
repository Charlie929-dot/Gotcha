/**
 * SQLite v1 schema（字段按技术方案 §4 原文）
 *
 * 分批建表（m1a-plan §4.1）：v1 只建 events + settings；
 * nodes / edges 由 M2 的 v2 迁移添加，避免空表漂移。
 * 所有 DDL 带 IF NOT EXISTS，重复执行幂等。
 */

/** L0 原始事件流（精确层，图谱默认折叠） */
export const EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts INTEGER,
  app TEXT,
  window_title TEXT,
  ocr_text TEXT,
  shot_path TEXT,
  intent_json TEXT,
  sensitive INTEGER DEFAULT 0
);
`

/** 时间线查询按 ts 区间扫描，建索引避免全表扫 */
export const EVENTS_TS_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`

/** 一切自定义项（埋点 stats.day.<yyyy-mm-dd> 也存这里，不建新表） */
export const SETTINGS_DDL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`
