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

/* ------------------------------------------------------------------ *
 * v4：主题合并审计 + 事件向量 + 主题质心（docs/m2-graph-redesign.md §5.1）
 * ------------------------------------------------------------------ */

/**
 * 合并审计与回滚：源节点并入目标节点。
 * - 不物理删除源节点，`nodes.merged_into` 指向目标（旧引用不断链）；
 * - `before_json` 存合并前两个节点的字段与归属快照，供 `revertThemeMerge` 精确回滚；
 * - `reverted_at` 非空 = 已撤销，重复撤销直接跳过。
 */
export const NODE_MERGES_DDL = `
CREATE TABLE IF NOT EXISTS node_merges (
  id          INTEGER PRIMARY KEY,
  group_id    INTEGER NOT NULL,
  from_node   INTEGER NOT NULL,
  into_node   INTEGER NOT NULL,
  merged_at   INTEGER NOT NULL,
  reason      TEXT,
  before_json TEXT,
  reverted_at INTEGER
);
`

export const NODE_MERGES_GROUP_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_node_merges_group ON node_merges(group_id);
`

export const NODE_MERGES_FROM_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_node_merges_from ON node_merges(from_node);
`

export const NODE_MERGES_INTO_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_node_merges_into ON node_merges(into_node);
`

/** 查询层过滤已合并节点（`merged_into IS NULL`） */
export const NODES_MERGED_INTO_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_nodes_merged_into ON nodes(merged_into);
`

/**
 * 事件向量缓存（合并质心 / 次归属用）。
 * 与 `node_embeddings` 分开：那边只放主题 `title+summary` 向量（用途是连线），
 * 这边放成员事件向量（用途是合并判定与时刻向量），口径不同不能混存。
 */
export const EVENT_EMBEDDINGS_DDL = `
CREATE TABLE IF NOT EXISTS event_embeddings (
  event_id   INTEGER PRIMARY KEY,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
`

/**
 * 主题成员事件质心（成员事件向量均值再 L2 归一化）。
 * `member_events` 是参与求均值的去重事件数；合并/次归属都读它，不读 title+summary 向量。
 */
export const THEME_CENTROIDS_DDL = `
CREATE TABLE IF NOT EXISTS theme_centroids (
  node_id       INTEGER PRIMARY KEY,
  model         TEXT NOT NULL,
  dim           INTEGER NOT NULL,
  vec           BLOB NOT NULL,
  member_events INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
`

/** 邻域查询 / 边去重按端点查 */
export const EDGES_SRC_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
`

export const EDGES_DST_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
`
