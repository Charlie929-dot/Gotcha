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

/**
 * 主题向量：Float32Array（已 L2 归一化），模型名 + 维度用于换模型时识别。
 * v6 追加 `text_hash`（`title + summary` 的指纹，见 `understand/vector-fingerprint.ts`）：
 * 文本变了才重新推理，别的主题直接复用（P2 · S3 增量维护）。
 */
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
 * v6 追加 `members_hash`（参与求均值的去重事件 id 集合指纹）：成员变了才重算（P2 · S3）。
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

/* ------------------------------------------------------------------ *
 * v5：检索索引（门一 v1，D31 / docs/memory-orb-design-proposal.md §3）
 * ------------------------------------------------------------------ */

/**
 * OCR 文本归一化（SQL 侧唯一定义：触发器与重建共用）。
 *
 * 实测修正（2026-10-24，本机 9 866 条非空 OCR）：98.9% 的中文被 WinRT OCR 切成
 * 「图 谱 设 计」这种空格逐字形态，原文上 trigram MATCH（需 ≥3 连续字符）与
 * LIKE '%图谱%' 都搜不到连续中文词（同一词原文 LIKE 命中 42 条、去空白后 2 503 条）。
 * 中文词内空格在视觉上无意义，因此索引侧一律去空白；查询侧同样去空白，两边口径一致，
 * 英文相邻词（"quick brown" → "quickbrown"）也仍然可查。
 */
export function normalizeOcrSql(expr: string): string {
  return `replace(replace(replace(replace(replace(replace(${expr}, ' ', ''), char(9), ''), char(10), ''), char(13), ''), char(12288), ''), char(160), '')`
}

/**
 * 检索索引：rowid = `events.id`，列存**归一化后的 OCR 文本**（不是原文）。
 *
 * 为什么不是 external-content（提案 §3.2 原始写法）：归一化文本必须落库才撑得起
 * 「两字词 LIKE 兜底」与 snippet，而 SQL 触发器没法调用 TS 归一化函数；用内容自持的
 * FTS 表 = 索引 + 归一化文本同表，省掉第二张原文副本，且仍可从 L0 整体重建。
 * 代价（本机实测）：9 914 条事件建索引 ~4.1 s、库 44.6 → 91.7 MB（+47 MB：归一化原文 ~12 MB + trigram 索引 ~35 MB）。
 */
export const EVENTS_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
  ocr_text,
  tokenize = 'trigram'
);
`

/** 新事件入索引（与 `events` 同事务，触发器保证任何写入路径都覆盖） */
export const EVENTS_FTS_INSERT_TRIGGER_DDL = `
CREATE TRIGGER IF NOT EXISTS events_fts_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, ocr_text)
  VALUES (new.id, ${normalizeOcrSql("coalesce(new.ocr_text, '')")});
END;
`

/** 事件删除 → 索引同步删（L0 行没了，索引不能留下幽灵命中） */
export const EVENTS_FTS_DELETE_TRIGGER_DDL = `
CREATE TRIGGER IF NOT EXISTS events_fts_ad AFTER DELETE ON events BEGIN
  DELETE FROM events_fts WHERE rowid = old.id;
END;
`

/** 事件改写 → 索引跟随（现有写入路径不改写 L0；留触发器兜住未来迁移/修正脚本） */
export const EVENTS_FTS_UPDATE_TRIGGER_DDL = `
CREATE TRIGGER IF NOT EXISTS events_fts_au AFTER UPDATE ON events BEGIN
  DELETE FROM events_fts WHERE rowid = old.id;
  INSERT INTO events_fts(rowid, ocr_text)
  VALUES (new.id, ${normalizeOcrSql("coalesce(new.ocr_text, '')")});
END;
`

export const EDGES_DST_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
`
