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

/* ------------------------------------------------------------------ *
 * v3：时刻层 + 多归属 + 主题向量/位置（docs/m2-graph-redesign.md §4）
 * ------------------------------------------------------------------ */

/**
 * 时刻（「同 app + 同标题 + 相邻 ≤90s」的事件组）。
 * - `event_ids` 是 JSON 数组，必须能解析回 events 行（L0 是事实源，不因时刻改写）；
 * - `day_key` 是本地日期 `yyyy-mm-dd`，日历筛选与按日回填都按它分组。
 */
export const MOMENTS_DDL = `
CREATE TABLE IF NOT EXISTS moments (
  id           INTEGER PRIMARY KEY,
  start_ts     INTEGER NOT NULL,
  end_ts       INTEGER NOT NULL,
  day_key      TEXT NOT NULL,
  app          TEXT,
  window_title TEXT,
  ocr_summary  TEXT,
  event_ids    TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
`

/** 日历按天取时刻 */
export const MOMENTS_DAY_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_moments_day ON moments(day_key);
`

/**
 * 主题成员（多对多）：主归属 `source='owner'` 恒有，次归属 0–2 个。
 * `nodes.source_events` 退化为兼容并集字段，新查询以本表为准。
 */
export const THEME_MOMENTS_DDL = `
CREATE TABLE IF NOT EXISTS theme_moments (
  theme_id   INTEGER NOT NULL,
  moment_id  INTEGER NOT NULL,
  weight     REAL NOT NULL DEFAULT 1.0,
  source     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (theme_id, moment_id)
);
`

/** 按时刻反查主题（侧栏「也属于」） */
export const THEME_MOMENTS_MOMENT_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_theme_moments_moment ON theme_moments(moment_id);
`

/** 主题向量：Float32Array（已 L2 归一化），模型名 + 维度用于换模型时识别 */
export const NODE_EMBEDDINGS_DDL = `
CREATE TABLE IF NOT EXISTS node_embeddings (
  node_id    INTEGER PRIMARY KEY,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
`

/** 节点位置：只用于下次 seed，活布局会继续移动，不冻结 */
export const NODE_POSITIONS_DDL = `
CREATE TABLE IF NOT EXISTS node_positions (
  node_id    INTEGER PRIMARY KEY,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
`

/** 邻域查询 / 边去重按端点查 */
export const EDGES_SRC_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
`

export const EDGES_DST_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
`
