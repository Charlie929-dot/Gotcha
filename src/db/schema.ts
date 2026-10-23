/**
 * SQLite schema（字段按技术方案 §4 原文）
 *
 * v1：events + settings（M1a）；v2：nodes / edges + 索引（M2 Phase 0）。
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

/** 图谱节点（L1~L4 一等公民；M2 只写 level=1） */
export const NODES_DDL = `
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY,
  level INTEGER,
  type TEXT,
  title TEXT,
  summary TEXT,
  ts_start INTEGER,
  ts_end INTEGER,
  source_events TEXT,
  meta_json TEXT
);
`

/** 图谱边（带权重；M2 只写 kind='ai'） */
export const EDGES_DDL = `
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY,
  src INTEGER,
  dst INTEGER,
  weight REAL,
  kind TEXT,
  evidence TEXT
);
`

/** 按日查询节点（时间窗过滤） */
export const NODES_TS_START_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_nodes_ts_start ON nodes(ts_start);
`

/** 按层级过滤（M3 起 LOD 用；M2 也用于只取 L1） */
export const NODES_LEVEL_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_nodes_level ON nodes(level);
`

/** 邻域查询 / 边去重按端点查 */
export const EDGES_SRC_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
`

export const EDGES_DST_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
`
