/**
 * 信息链 · 表结构（`docs/information-chain-contract.md` v0.3）
 *
 * 只建新表（`chain_` 前缀），不动旧表，不迁移旧数据（D38）。
 * 所有 DDL 带 IF NOT EXISTS，重复执行幂等；本模块不接入应用启动流程，
 * 由调用方显式执行 `ensureChainSchema(db)`（第一版只被单测调用）。
 *
 * 证据层（段 / 事件 / 截图）只 INSERT；派生层（标签 / 双链 / 向量）可全删重建。
 */

/** 段：一个窗口的一段焦点占用 */
export const CHAIN_SEGMENT_DDL = `
CREATE TABLE IF NOT EXISTS chain_segment (
  id          INTEGER PRIMARY KEY,
  start_ts    INTEGER NOT NULL,
  end_ts      INTEGER NOT NULL,
  active_ms   INTEGER NOT NULL,
  idle_ms     INTEGER NOT NULL DEFAULT 0,
  day_key     TEXT    NOT NULL,
  app         TEXT,
  exe         TEXT,
  pid         INTEGER,
  hwnd        INTEGER,
  title_first TEXT,
  title_last  TEXT,
  created_at  INTEGER NOT NULL,
  CHECK (end_ts >= start_ts),
  CHECK (active_ms >= 0 AND idle_ms >= 0)
);
`

/** 事件点：段的内部锚点与截图触发器，不是图谱节点 */
export const CHAIN_EVENT_DDL = `
CREATE TABLE IF NOT EXISTS chain_event (
  id         INTEGER PRIMARY KEY,
  segment_id INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  x          INTEGER,
  y          INTEGER,
  delta      INTEGER,
  CHECK (kind IN ('click_left', 'click_right', 'click_middle', 'wheel', 'move_pause', 'enter'))
);
`

/** 截图：挂在事件上的证据，只写一次 */
export const CHAIN_SHOT_DDL = `
CREATE TABLE IF NOT EXISTS chain_shot (
  id         INTEGER PRIMARY KEY,
  segment_id INTEGER NOT NULL,
  event_id   INTEGER,
  ts         INTEGER NOT NULL,
  path       TEXT,
  width      INTEGER,
  height     INTEGER,
  bytes      INTEGER,
  source     TEXT NOT NULL,
  tier       TEXT NOT NULL DEFAULT 'hot',
  container  TEXT,
  CHECK (source IN ('event', 'enter')),
  CHECK (tier IN ('hot', 'warm', 'cold', 'archive'))
);
`

/** 内容：段内的文本流，每条都带来源 */
export const CHAIN_CONTENT_DDL = `
CREATE TABLE IF NOT EXISTS chain_content (
  id          INTEGER PRIMARY KEY,
  segment_id  INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  source      TEXT    NOT NULL,
  text        TEXT    NOT NULL,
  chars       INTEGER NOT NULL,
  hash        TEXT    NOT NULL,
  CHECK (source IN ('uia', 'ocr', 'manual')),
  CHECK (chars >= 0)
);
`

/** 标签（派生） */
export const CHAIN_TAG_DDL = `
CREATE TABLE IF NOT EXISTS chain_tag (
  id         INTEGER PRIMARY KEY,
  segment_id INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  source     TEXT    NOT NULL
);
`

/** 双链单元（派生）：可被多个段共用 */
export const CHAIN_LINK_DDL = `
CREATE TABLE IF NOT EXISTS chain_link (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  aliases TEXT
);
`

/** 双链 × 段（派生，多对多） */
export const CHAIN_LINK_SEGMENT_DDL = `
CREATE TABLE IF NOT EXISTS chain_link_segment (
  link_id    INTEGER NOT NULL,
  segment_id INTEGER NOT NULL,
  weight     REAL    NOT NULL DEFAULT 1.0,
  PRIMARY KEY (link_id, segment_id)
);
`

/** 段向量（派生） */
export const CHAIN_VECTOR_DDL = `
CREATE TABLE IF NOT EXISTS chain_vector (
  segment_id INTEGER PRIMARY KEY,
  model      TEXT    NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB    NOT NULL,
  text_hash  TEXT    NOT NULL
);
`

export const CHAIN_INDEX_DDLS: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS idx_chain_segment_day ON chain_segment(day_key);',
  'CREATE INDEX IF NOT EXISTS idx_chain_segment_start ON chain_segment(start_ts);',
  'CREATE INDEX IF NOT EXISTS idx_chain_event_segment ON chain_event(segment_id);',
  'CREATE INDEX IF NOT EXISTS idx_chain_event_ts ON chain_event(ts);',
  'CREATE INDEX IF NOT EXISTS idx_chain_shot_segment ON chain_shot(segment_id);',
  'CREATE INDEX IF NOT EXISTS idx_chain_shot_event ON chain_shot(event_id);',
  'CREATE INDEX IF NOT EXISTS idx_chain_content_segment ON chain_content(segment_id);',
  'CREATE INDEX IF NOT EXISTS idx_chain_tag_segment ON chain_tag(segment_id);',
  'CREATE INDEX IF NOT EXISTS idx_chain_link_segment_seg ON chain_link_segment(segment_id);'
]

/** 证据层与派生层的全部建表语句（顺序固定：先证据，后派生） */
export const CHAIN_SCHEMA_DDLS: readonly string[] = [
  CHAIN_SEGMENT_DDL,
  CHAIN_EVENT_DDL,
  CHAIN_SHOT_DDL,
  CHAIN_CONTENT_DDL,
  CHAIN_TAG_DDL,
  CHAIN_LINK_DDL,
  CHAIN_LINK_SEGMENT_DDL,
  CHAIN_VECTOR_DDL
]

export const CHAIN_TABLES = [
  'chain_segment',
  'chain_event',
  'chain_shot',
  'chain_content',
  'chain_tag',
  'chain_link',
  'chain_link_segment',
  'chain_vector'
] as const

export type ChainTable = (typeof CHAIN_TABLES)[number]

/** 建表的最小 db 形状（只用到 exec，便于单测注入） */
export interface ExecutableDb {
  exec(sql: string): unknown
}

/**
 * 幂等建表。**不触碰旧表、不写数据、不改 schema_version**——
 * 版本管理等接线应用启动时再统一处理（见契约 §4）。
 */
export function ensureChainSchema(db: ExecutableDb): void {
  for (const ddl of CHAIN_SCHEMA_DDLS) db.exec(ddl)
  for (const ddl of CHAIN_INDEX_DDLS) db.exec(ddl)
}

/** 事件类型（与 DDL 的 CHECK 一致） */
export const CHAIN_EVENT_KINDS = [
  'click_left',
  'click_right',
  'click_middle',
  'wheel',
  'move_pause',
  'enter'
] as const
export type ChainEventKind = (typeof CHAIN_EVENT_KINDS)[number]

/** 截图来源 */
export const CHAIN_SHOT_SOURCES = ['event', 'enter'] as const
export type ChainShotSource = (typeof CHAIN_SHOT_SOURCES)[number]

/** 归档层级（契约 §5.1） */
export const CHAIN_SHOT_TIERS = ['hot', 'warm', 'cold', 'archive'] as const
export type ChainShotTier = (typeof CHAIN_SHOT_TIERS)[number]

/** 内容来源 */
export const CHAIN_CONTENT_SOURCES = ['uia', 'ocr', 'manual'] as const
export type ChainContentSource = (typeof CHAIN_CONTENT_SOURCES)[number]

export interface ChainSegmentRow {
  id: number
  start_ts: number
  end_ts: number
  active_ms: number
  idle_ms: number
  day_key: string
  app: string | null
  exe: string | null
  pid: number | null
  hwnd: number | null
  title_first: string | null
  title_last: string | null
  created_at: number
}

export interface ChainEventRow {
  id: number
  segment_id: number
  ts: number
  kind: ChainEventKind
  x: number | null
  y: number | null
  delta: number | null
}

export interface ChainShotRow {
  id: number
  segment_id: number
  event_id: number | null
  ts: number
  path: string | null
  width: number | null
  height: number | null
  bytes: number | null
  source: ChainShotSource
  tier: ChainShotTier
  container: string | null
}

export interface ChainContentRow {
  id: number
  segment_id: number
  captured_at: number
  source: ChainContentSource
  text: string
  chars: number
  hash: string
}
