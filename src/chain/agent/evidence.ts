/**
 * 信息链 · 单段证据（问记忆窗口「点开引用」用）
 *
 * 只读：段行 + 标签 / 双链 + 内容片段 + 截图（截图由调用方注入读取函数，
 * 主进程读文件、测试给假实现——这一层不碰 fs）。
 */
import { listSegmentLinks, listSegmentTags } from '../derive/store'
import { getSegmentDetail, type ChainDb } from '../store'

export interface SegmentEvidenceContent {
  ts: number
  source: string
  text: string
}

export interface SegmentEvidenceShot {
  ts: number
  source: string
  width: number | null
  height: number | null
  /** 归档 / 打包进容器的截图没有可直接读的文件，给 null */
  dataUrl: string | null
}

export interface SegmentEvidence {
  segmentId: number
  app: string | null
  title: string
  startTs: number
  endTs: number
  activeMs: number
  tags: string[]
  links: string[]
  contents: SegmentEvidenceContent[]
  shots: SegmentEvidenceShot[]
}

export interface SegmentEvidenceOptions {
  /** 读一张证据图 → data URL；读不到（文件没了 / 已归档）返回 null */
  readShot?: (path: string) => string | null
  /** 内容片段上限（条数），默认 3 */
  contentLimit?: number
  /** 每段正文的字符上限，默认 1200 */
  textChars?: number
  /** 最多回几张截图，默认 2 */
  shotLimit?: number
}

const DEFAULT_CONTENT_LIMIT = 3
const DEFAULT_TEXT_CHARS = 1_200
const DEFAULT_SHOT_LIMIT = 2

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 读一段的「可核验证据」；段不存在或不变量不满足时返回 null */
export function readSegmentEvidence(
  db: ChainDb,
  segmentId: number,
  options: SegmentEvidenceOptions = {}
): SegmentEvidence | null {
  const detail = getSegmentDetail(db, segmentId)
  if (!detail) return null
  const contentLimit = Math.max(1, options.contentLimit ?? DEFAULT_CONTENT_LIMIT)
  const textChars = Math.max(80, options.textChars ?? DEFAULT_TEXT_CHARS)
  const shotLimit = Math.max(0, options.shotLimit ?? DEFAULT_SHOT_LIMIT)

  const contents = detail.contents
    .slice(-contentLimit)
    .reverse()
    .map((row) => ({
      ts: row.captured_at,
      source: row.source,
      text: truncate(row.text, textChars)
    }))

  // 只给有文件的那几张：归档进容器的（path 为空）留 null，不在这里解包
  const shots = detail.shots
    .filter((row) => typeof row.path === 'string' && row.path !== '')
    .slice(-shotLimit)
    .reverse()
    .map((row) => ({
      ts: row.ts,
      source: row.source,
      width: row.width,
      height: row.height,
      dataUrl: options.readShot ? options.readShot(row.path as string) : null
    }))

  return {
    segmentId: detail.segment.id,
    app: detail.segment.app,
    title: detail.segment.title_last ?? detail.segment.title_first ?? '',
    startTs: detail.segment.start_ts,
    endTs: detail.segment.end_ts,
    activeMs: detail.segment.active_ms,
    tags: listSegmentTags(db, segmentId).map((tag) => tag.name),
    links: listSegmentLinks(db, segmentId).map((link) => link.name),
    contents,
    shots
  }
}
