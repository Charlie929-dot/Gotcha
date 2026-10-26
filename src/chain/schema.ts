/**
 * 信息链 · 表结构（`docs/information-chain-contract.md` v0.5）
 *
 * 只建新表（`chain_` 前缀），不动旧表，不迁移旧数据（D38）。
 * 所有 DDL 带 IF NOT EXISTS，重复执行幂等；**已接进应用启动**（`main/chain-recording.ts`），
 * 所以从这里开始「改 DDL 必须带迁移」：`CREATE TABLE IF NOT EXISTS` 不会给老库补列 / 改 CHECK
 * （gotchas「改 chain_*.DDL 不会改到已有库」），因此另有 `chain_meta.schema_version` 记账 +
 * `CHAIN_MIGRATIONS` 迁移表（见文件末尾）。
 *
 * 证据层（段 / 事件 / 截图）只 INSERT；派生层（标签 / 双链 / 向量）可全删重建。
 *
 * 唯一例外（契约 v0.4）：段在开段时就要插入一行（子行要立刻拿到 `segment_id`，
 * 且段可能长达数小时、不能全缓冲在内存里），`end_ts` / `active_ms` / `idle_ms` /
 * `title_last` / `closed` 由收口时的**一次** UPDATE 落定；其余字段此后永不改。
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
  closed      INTEGER NOT NULL DEFAULT 0,  -- 0=还开着（end_ts/active_ms 只是暂定值），1=已收口
  CHECK (end_ts >= start_ts),
  CHECK (active_ms >= 0 AND idle_ms >= 0),
  CHECK (closed IN (0, 1))
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
  CHECK (kind IN ('click_left', 'click_right', 'click_middle', 'wheel', 'move_pause', 'typing', 'enter'))
);
`

/** 截图：挂在事件上的证据，只写一次 */
export const CHAIN_SHOT_DDL = `
CREATE TABLE IF NOT EXISTS chain_shot (
  id         INTEGER PRIMARY KEY,
  segment_id INTEGER NOT NULL,
  event_id   INTEGER,             -- 触发它的那个事件（入场帧挂在 enter 事件上）
  ts         INTEGER NOT NULL,
  path       TEXT,
  width      INTEGER,
  height     INTEGER,
  bytes      INTEGER,
  source     TEXT NOT NULL,
  tier       TEXT NOT NULL DEFAULT 'hot',
  container  TEXT,
  CHECK (source IN ('event', 'enter', 'typing')),
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

/**
 * 段向量（派生）。
 *
 * `content_max_id`（v0.8）：建向量时这一段最大的 `chain_content.id`——内容又读回来一条
 * 就比它大，扫派生队列据此判断「要不要重算」，不必每次把全部正文读出来比指纹。
 */
export const CHAIN_VECTOR_DDL = `
CREATE TABLE IF NOT EXISTS chain_vector (
  segment_id     INTEGER PRIMARY KEY,
  model          TEXT    NOT NULL,
  dim            INTEGER NOT NULL,
  vec            BLOB    NOT NULL,
  text_hash      TEXT    NOT NULL,
  content_max_id INTEGER NOT NULL DEFAULT 0
);
`

/**
 * 派生进度（v0.8，派生层自己的记账，不属于契约 §2 的证据表）。
 *
 * 一行 = 「这一段**这个指纹**的正文已经送过模型抽标签 / 双链」。
 * 没有它就无法区分「还没抽」与「抽了但什么都没抽出来」——只靠 `chain_tag` 有没有行会
 * 把「空结果」当成待办，每轮重抽一次白烧 token。派生层可全删重建，这张表也一样。
 */
export const CHAIN_DERIVE_DDL = `
CREATE TABLE IF NOT EXISTS chain_derive (
  segment_id     INTEGER PRIMARY KEY,
  text_hash      TEXT    NOT NULL,
  content_max_id INTEGER NOT NULL DEFAULT 0,
  derived_at     INTEGER NOT NULL
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
  CHAIN_VECTOR_DDL,
  CHAIN_DERIVE_DDL
]

export const CHAIN_TABLES = [
  'chain_segment',
  'chain_event',
  'chain_shot',
  'chain_content',
  'chain_tag',
  'chain_link',
  'chain_link_segment',
  'chain_vector',
  'chain_derive'
] as const

export type ChainTable = (typeof CHAIN_TABLES)[number]

/** 版本记账表（不属于契约 §2 的数据表，只存 `schema_version`） */
export const CHAIN_META_TABLE = 'chain_meta'

export const CHAIN_META_DDL = `
CREATE TABLE IF NOT EXISTS chain_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/**
 * 信息链自己的结构版本。**改任何 chain_ DDL 都要同时**：
 * ① 把这里 +1；② 在 `CHAIN_MIGRATIONS` 里补「旧版本 → 新版本」那一步（老库靠它补列 / 重建）。
 * 忘了的后果是静默：老库缺列，插入直接报 `no column named`（gotchas 记过这条）。
 *
 * 版本史：1 = v0.5 接线时的八张表；2 = 派生层（`chain_derive` + `chain_vector.content_max_id`）。
 */
export const CHAIN_SCHEMA_VERSION = 2

/** 版本 → 迁移步骤。`CHAIN_MIGRATIONS[n]` 负责把 v(n-1) 的库改成 v(n) */
export const CHAIN_MIGRATIONS: Record<number, (db: ChainSchemaDb) => void> = {
  /**
   * v1 → v2：补派生层的列与表。
   *
   * `ensureChainSchema` 先跑一遍 `CREATE TABLE IF NOT EXISTS`（`chain_derive` 会被建出来），
   * 所以这里只需把老 `chain_vector` 缺的列补上——SQLite 的 `ALTER TABLE ... ADD COLUMN`
   * 不能带 `IF NOT EXISTS`，只能靠版本号保证只跑一次。
   */
  2: (db) => {
    db.exec('ALTER TABLE chain_vector ADD COLUMN content_max_id INTEGER NOT NULL DEFAULT 0')
  }
}

/** 建表 / 版本记账需要的最小 db 形状（只用到 exec / prepare） */
export interface ExecutableDb {
  exec(sql: string): unknown
}

export interface ChainSchemaDb extends ExecutableDb {
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }
}

const SCHEMA_VERSION_KEY = 'schema_version'

/**
 * 幂等建表 + 版本记账。**不触碰旧表、不写业务数据**（只用 `chain_meta` 记自己的版本）。
 *
 * - 新建库（没有记账行）：DDL 已经把结构建成当前版本，直接记成 `CHAIN_SCHEMA_VERSION`；
 * - 已有记账行：低于当前版本就按 `CHAIN_MIGRATIONS` 逐步迁移，再做一次幂等建表；
 * - 高于当前版本：拒绝启动（别让旧程序往新结构的库里写）。
 */
export function ensureChainSchema(db: ChainSchemaDb): void {
  for (const ddl of CHAIN_SCHEMA_DDLS) db.exec(ddl)
  for (const ddl of CHAIN_INDEX_DDLS) db.exec(ddl)
  db.exec(CHAIN_META_DDL)

  const row = db.prepare('SELECT value FROM chain_meta WHERE key = ?').get(SCHEMA_VERSION_KEY) as
    | { value: string }
    | undefined
  if (!row) {
    db.prepare('INSERT INTO chain_meta (key, value) VALUES (?, ?)').run(
      SCHEMA_VERSION_KEY,
      String(CHAIN_SCHEMA_VERSION)
    )
    return
  }

  const current = Number(row.value)
  if (!Number.isInteger(current) || current < 0) {
    throw new Error(`chain_meta.schema_version 非法：${row.value}`)
  }
  if (current > CHAIN_SCHEMA_VERSION) {
    throw new Error(
      `信息链表结构版本 ${current} 高于本程序支持的 ${CHAIN_SCHEMA_VERSION}，请升级应用后再启动`
    )
  }
  for (let version = current; version < CHAIN_SCHEMA_VERSION; version += 1) {
    const migrate = CHAIN_MIGRATIONS[version + 1]
    if (!migrate) throw new Error(`缺少 chain v${version} → v${version + 1} 的迁移步骤`)
    migrate(db)
  }
  if (current !== CHAIN_SCHEMA_VERSION) {
    db.prepare('UPDATE chain_meta SET value = ? WHERE key = ?').run(
      String(CHAIN_SCHEMA_VERSION),
      SCHEMA_VERSION_KEY
    )
  }
}

/** 事件类型（与 DDL 的 CHECK 一致） */
export const CHAIN_EVENT_KINDS = [
  'click_left',
  'click_right',
  'click_middle',
  'wheel',
  'move_pause',
  'typing',
  'enter'
] as const
export type ChainEventKind = (typeof CHAIN_EVENT_KINDS)[number]

/** 鼠标事件（会带坐标 / 滚轮格数）；typing 与 enter 没有坐标 */
export const CHAIN_POINTER_EVENT_KINDS = ['click_left', 'click_right', 'click_middle', 'wheel', 'move_pause'] as const

/** 截图来源 */
export const CHAIN_SHOT_SOURCES = ['event', 'enter', 'typing'] as const
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
  /** 0 = 还开着（`end_ts` / `active_ms` 只是暂定值，收口时由唯一一次 UPDATE 落定） */
  closed: 0 | 1
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

/** 段向量行（派生；`vec` 是 Float32Array 的原始字节，小端） */
export interface ChainVectorRow {
  segment_id: number
  model: string
  dim: number
  vec: Buffer
  text_hash: string
  content_max_id: number
}

/** 派生进度行（派生层记账，可全删重建） */
export interface ChainDeriveRow {
  segment_id: number
  text_hash: string
  content_max_id: number
  derived_at: number
}
