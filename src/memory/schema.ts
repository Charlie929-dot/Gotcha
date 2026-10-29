/**
 * 个人记忆 · SQLite 表结构（v9）
 *
 * 与 `events`（屏幕记忆）并列的第二本账：**日记记忆**。
 * 表名统一 `mem_` 前缀，和采集/图谱的表互不干扰；`mem_items` 是事实源，
 * 其余（画像 / 观测）都是可以整表重建的派生数据。
 */

/** 一条记忆条目（日记块 / 待办 / 摘录） */
export const MEM_ITEMS_DDL = `
CREATE TABLE IF NOT EXISTS mem_items (
  id          INTEGER PRIMARY KEY,
  uid         TEXT NOT NULL UNIQUE,
  source_path TEXT NOT NULL,
  day_key     TEXT NOT NULL,
  section     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL,
  text_norm   TEXT NOT NULL,
  ts          INTEGER,
  line_start  INTEGER NOT NULL,
  line_end    INTEGER NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  refs        TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
`

export const MEM_ITEMS_DAY_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_mem_items_day ON mem_items(day_key);
`

export const MEM_ITEMS_TS_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_mem_items_ts ON mem_items(ts);
`

export const MEM_ITEMS_SOURCE_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_mem_items_source ON mem_items(source_path);
`

/** 已同步的文件（mtime + size 没变就跳过整份解析） */
export const MEM_SOURCES_DDL = `
CREATE TABLE IF NOT EXISTS mem_sources (
  path       TEXT PRIMARY KEY,
  day_key    TEXT,
  mtime      INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  synced_at  INTEGER NOT NULL
);
`

/**
 * 观测（Hindsight 的 observations）：把多条条目压成一句可复用的话。
 * 当前只做**可解释的统计型**观测（source='stats'），不带 LLM 归纳；
 * `status` 预留给「被更新的观测取代」（superseded），避免两条互相打架的结论同时生效。
 */
export const MEM_OBSERVATIONS_DDL = `
CREATE TABLE IF NOT EXISTS mem_observations (
  id          INTEGER PRIMARY KEY,
  uid         TEXT NOT NULL UNIQUE,
  topic       TEXT NOT NULL,
  statement   TEXT NOT NULL,
  detail_json TEXT,
  source      TEXT NOT NULL DEFAULT 'stats',
  confidence  REAL NOT NULL DEFAULT 1.0,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
`

export const MEM_OBSERVATIONS_TOPIC_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_mem_observations_topic ON mem_observations(topic);
`

/**
 * 回收站（v9）：用户在设置抽屉里删掉的条目。
 *
 * 两个作用：
 * 1. 同步时**跳过**这些 uid —— 日记原文还在，改别的段落会触发整份重解析，
 *    没有这张表的话删掉的条目下一次同步就自己回来了；
 * 2. 存整行（不是只存 uid）：撤销删除可以原样放回，不必等下一次同步。
 *
 * 条目正文 / 段落 / 起始行任一变化都会换 uid：那是「新写的一条」，不受这里影响。
 * 表本身有上限（`DELETED_KEEP`），超出按删除时间丢最旧的。
 */
export const MEM_DELETED_DDL = `
CREATE TABLE IF NOT EXISTS mem_deleted (
  uid         TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  day_key     TEXT NOT NULL,
  section     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  text        TEXT NOT NULL,
  text_norm   TEXT NOT NULL,
  ts          INTEGER,
  line_start  INTEGER NOT NULL,
  line_end    INTEGER NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  refs        TEXT NOT NULL DEFAULT '[]',
  deleted_at  INTEGER NOT NULL
);
`

export const MEM_DELETED_DAY_INDEX_DDL = `
CREATE INDEX IF NOT EXISTS idx_mem_deleted_day ON mem_deleted(day_key);
`

/**
 * 向量（v10）：日记 / 对话 / 观测 / self 的本地 embedding。
 *
 * 设计见 `docs/agent/llm-call.md` §4（D57）：本地 bge-small 算，**零出网**；
 * `text_hash` 是正文指纹 —— 正文没变就不重算，换了模型则按 `model` 各存一份（同一模型覆盖）。
 *
 * 派生数据，可整表重建：孤儿（条目已删 / 正文变了换 uid）由索引任务按
 * 「`item_id` 不在 `mem_items` 里」清掉；`dim` 不入库，读的时候按当前模型维度校验
 * （长度对不上的坏行跳过，不报错）。
 */
export const MEM_VECTORS_DDL = `
CREATE TABLE IF NOT EXISTS mem_vectors (
  item_type  TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  model      TEXT NOT NULL,
  vector     BLOB NOT NULL,
  text_hash  TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (item_type, item_id, model)
);
`
