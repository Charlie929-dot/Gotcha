/**
 * 信息链 · 保留期分层执行器（契约 §5.1，D44）
 *
 * 一件事：把**老证据**按 `chain/retention.ts` 的计划重编码 / 打包，并把结果写回行。
 * 不抓帧、不读文本、不碰旧管线。
 *
 * 四条纪律：
 * 1. **先写新、再改行、最后删旧**：任何一步崩掉，最坏是「多留一个文件」，绝不出现
 *    「行指向一个不存在的文件」。`updateShotRetention` 在一个事务里落行。
 * 2. **按天 + 层打包**：cold / archive 的图进 `<shotsDir>/archive/<日期>-<层>.cgar`，
 *    行里 `path` 置空、`container` 指向容器；旧的容器在没人再引用后删掉。
 * 3. **幂等**：已经是目标层的行直接跳过；重复跑不会二次压缩。
 * 4. **不占满主进程**：每处理一张让出一拍（`setImmediate`），`nativeImage` 是同步的，
 *    一口气转几千张会让球和热键卡住。一次默认最多 2000 张，剩下的下一轮接着做。
 *
 * 失败只记 `failed` 与日志，**不动那一行**（宁可这一张还是 old tier，也不写半截状态）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildArchive, extractArchiveEntry } from '../chain/archive'
import type { ChainShotRow, ChainShotTier } from '../chain/schema'
import {
  containerName,
  jpegPathOf,
  planShotRetention,
  retentionScanBefore,
  DEFAULT_RETENTION,
  type RetentionEncoding,
  type RetentionParams
} from '../chain/retention'
import {
  dayKeyOf,
  listShotsInContainer,
  selectShotsForRetention,
  updateShotRetention,
  type ChainDb,
  type ShotRetentionUpdate
} from '../chain/store'

/** 文件操作的注入点（生产用 node:fs；单测用内存实现） */
export interface RetentionFs {
  readFileSync(path: string): Buffer
  writeFileSync(path: string, data: Buffer): void
  renameSync(from: string, to: string): void
  unlinkSync(path: string): void
  mkdirSync(path: string, options: { recursive: boolean }): void
  existsSync(path: string): boolean
  statSync(path: string): { size: number }
  readdirSync(path: string): string[]
}

/** 重编码结果 */
export interface EncodedImage {
  bytes: Buffer
  width: number
  height: number
}

/**
 * 重编码器（生产是 Electron `nativeImage`，单测注入假的）。
 * `input` 是解码前的文件字节（PNG / JPEG 都行）。
 */
export type ImageEncoder = (input: Buffer, encoding: RetentionEncoding) => EncodedImage

export type RetentionLog = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  data?: Record<string, unknown>
) => void

export interface ChainRetentionOptions {
  db: ChainDb
  /** 证据根目录（`<userData>/chain-shots`） */
  shotsDir: string
  encode: ImageEncoder
  params?: RetentionParams
  now?: () => number
  fs?: RetentionFs
  log?: RetentionLog
  /** 自动扫描间隔（默认 6h；0 = 只手动 `run()`） */
  intervalMs?: number
  /** 单次最多处理多少张（默认 2000） */
  maxPerRun?: number
}

export interface RetentionStats {
  scanned: number
  encoded: number
  packed: number
  skipped: number
  failed: number
  /** 处理掉的载荷字节（改之前 / 之后；不含容器索引开销） */
  bytesBefore: number
  bytesAfter: number
  /** 新建 / 重建的容器数 */
  containers: number
}

export interface ChainRetention {
  /** 跑一轮（已经在跑就返回同一个 Promise） */
  run(): Promise<RetentionStats>
  /** 立即跑一轮 + 每 `intervalMs` 再跑；幂等 */
  start(): void
  /** 停止自动扫描；在跑的这轮会在当前这张之后收手 */
  stop(): void
  readonly busy: boolean
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_MAX_PER_RUN = 2_000

const nodeFs: RetentionFs = {
  readFileSync: (path) => readFileSync(path),
  writeFileSync: (path, data) => writeFileSync(path, data),
  renameSync: (from, to) => renameSync(from, to),
  unlinkSync: (path) => unlinkSync(path),
  mkdirSync: (path, options) => mkdirSync(path, options),
  existsSync: (path) => existsSync(path),
  statSync: (path) => statSync(path),
  readdirSync: (path) => readdirSync(path)
}

function emptyStats(): RetentionStats {
  return { scanned: 0, encoded: 0, packed: 0, skipped: 0, failed: 0, bytesBefore: 0, bytesAfter: 0, containers: 0 }
}

/** 让出一拍：nativeImage 是同步的，连续转图会把主进程卡住 */
function yieldOnce(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

interface PackGroup {
  dayKey: string
  tier: 'cold' | 'archive'
  encoding: RetentionEncoding
  container: string
  rows: ChainShotRow[]
}

export function createChainRetention(options: ChainRetentionOptions): ChainRetention {
  const fs = options.fs ?? nodeFs
  const log: RetentionLog = options.log ?? (() => {})
  const params = options.params ?? DEFAULT_RETENTION
  const clock = options.now ?? Date.now
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const maxPerRun = Math.max(1, options.maxPerRun ?? DEFAULT_MAX_PER_RUN)
  const archiveDir = join(options.shotsDir, 'archive')

  let timer: ReturnType<typeof setInterval> | null = null
  let running: Promise<RetentionStats> | null = null
  let aborted = false
  /** 一轮内复用最近读过的一个容器（同一天的移动行会反复读它） */
  const containerCache: { current: { path: string; bytes: Buffer } | null } = { current: null }

  /** 读容器文件（同一个容器连读多次只读一次） */
  const readContainer = (path: string): Buffer => {
    const cached = containerCache.current
    if (cached !== null && cached.path === path) return cached.bytes
    const bytes = fs.readFileSync(path)
    containerCache.current = { path, bytes }
    return bytes
  }

  /** 读一张图的载荷：在原文件里，或者在归档容器里 */
  const readPayload = (row: ChainShotRow): Buffer => {
    if (row.path !== null) {
      if (!fs.existsSync(row.path)) throw new Error(`证据文件不存在：${row.path}`)
      return fs.readFileSync(row.path)
    }
    if (row.container !== null) {
      if (!fs.existsSync(row.container)) throw new Error(`归档容器不存在：${row.container}`)
      const entry = extractArchiveEntry(readContainer(row.container), row.id)
      if (!entry) throw new Error(`归档容器 ${row.container} 里没有截图 ${row.id}`)
      return entry.bytes
    }
    throw new Error(`截图 ${row.id} 既没有文件也没有容器，无法读取`)
  }

  const unlinkQuietly = (path: string): void => {
    try {
      if (fs.existsSync(path)) fs.unlinkSync(path)
    } catch (error) {
      log('warn', 'chain retention: unable to delete old file', { path, error: String(error) })
    }
  }

  /** 容器没人引用了才删（升级时旧容器要等所有行都搬走） */
  const removeContainerIfUnused = (container: string): void => {
    if (container === '') return
    if (!fs.existsSync(container)) return
    if (listShotsInContainer(options.db, container).length > 0) return
    unlinkQuietly(container)
  }

  const applyEncode = (row: ChainShotRow, tier: ChainShotTier, encoding: RetentionEncoding, stats: RetentionStats): void => {
    if (row.path === null) throw new Error(`截图 ${row.id} 不在文件层，不能就地重编码`)
    const payload = readPayload(row)
    const encoded = options.encode(payload, encoding)
    const target = jpegPathOf(row.path)
    const temporary = `${target}.tmp`
    fs.writeFileSync(temporary, encoded.bytes)
    fs.renameSync(temporary, target)
    updateShotRetention(options.db, [
      {
        id: row.id,
        tier,
        path: target,
        container: null,
        width: encoded.width,
        height: encoded.height,
        bytes: encoded.bytes.length
      }
    ])
    // 行已经指向新文件，再删老文件；老路径 == 新路径时（JPEG → JPEG）不删
    if (row.path !== target) unlinkQuietly(row.path)
    stats.encoded += 1
    stats.bytesBefore += row.bytes ?? payload.length
    stats.bytesAfter += encoded.bytes.length
  }

  const packGroup = (group: PackGroup, stats: RetentionStats): void => {
    const existing = listShotsInContainer(options.db, group.container)
    containerCache.current = null

    const updates: Array<{ row: ChainShotRow; update: ShotRetentionUpdate }> = []
    const entries: Array<{ shotId: number; bytes: Buffer; width: number; height: number }> = []

    for (const row of group.rows) {
      const payload = readPayload(row)
      const encoded = options.encode(payload, group.encoding)
      entries.push({ shotId: row.id, bytes: encoded.bytes, width: encoded.width, height: encoded.height })
      updates.push({
        row,
        update: {
          id: row.id,
          tier: group.tier,
          path: null,
          container: group.container,
          width: encoded.width,
          height: encoded.height,
          bytes: encoded.bytes.length
        }
      })
      stats.bytesBefore += row.bytes ?? payload.length
      stats.bytesAfter += encoded.bytes.length
    }

    // 已经在同一个容器里的行（cold → archive 升级时是那些「先一步到 archive」的）
    // 原样带上，不二次压缩；否则重建容器会把它们弄丢。
    const moving = new Set(group.rows.map((row) => row.id))
    for (const row of existing) {
      if (moving.has(row.id)) continue
      if (row.container === null) continue
      const entry = extractArchiveEntry(readContainer(row.container), row.id)
      if (!entry) throw new Error(`归档容器 ${row.container} 里没有截图 ${row.id}`)
      entries.push({ shotId: row.id, bytes: entry.bytes, width: entry.width, height: entry.height })
      updates.push({
        row,
        update: {
          id: row.id,
          tier: group.tier,
          path: null,
          container: group.container,
          width: entry.width,
          height: entry.height,
          bytes: entry.bytes.length
        }
      })
    }

    // 稳定顺序：同一批数据重复打包得到同一份字节
    entries.sort((a, b) => a.shotId - b.shotId)
    const buffer = buildArchive(entries)
    fs.mkdirSync(archiveDir, { recursive: true })
    const temporary = `${group.container}.tmp`
    fs.writeFileSync(temporary, buffer)
    fs.renameSync(temporary, group.container)
    stats.containers += 1

    updateShotRetention(
      options.db,
      updates.map((item) => item.update)
    )

    // 落行成功之后才动文件：删原图、删没人引用的旧容器
    for (const { row } of updates) {
      if (row.path !== null && row.path !== group.container) unlinkQuietly(row.path)
      if (row.container !== null && row.container !== group.container) removeContainerIfUnused(row.container)
    }
    stats.packed += group.rows.length
  }

  const runSweep = async (): Promise<RetentionStats> => {
    const stats = emptyStats()
    const now = clock()
    const before = retentionScanBefore(now, params)
    const rows = selectShotsForRetention(options.db, before)
    stats.scanned = rows.length
    if (rows.length === 0) return stats

    // 上次崩溃留下的半截容器（写了一半的 .tmp）直接清掉：它不是证据。
    // 归档目录还不存在时 readdir 会抛错（第一次分层还没到），忽略即可。
    try {
      for (const name of fs.readdirSync(archiveDir)) {
        if (name.endsWith('.tmp')) unlinkQuietly(join(archiveDir, name))
      }
    } catch {
      // 目录还不存在 / 读不了：没有可清的半截文件
    }

    const groups = new Map<string, PackGroup>()
    let processed = 0

    for (const row of rows) {
      if (aborted || processed >= maxPerRun) break
      const plan = planShotRetention(row, now, params)
      if (plan.kind === 'keep') {
        stats.skipped += 1
        continue
      }
      if (plan.kind === 'encode') {
        try {
          applyEncode(row, plan.tier, plan.encoding, stats)
        } catch (error) {
          stats.failed += 1
          log('warn', 'chain retention: re-encode failed', { shotId: row.id, tier: plan.tier, error: String(error) })
        }
      } else {
        const dayKey = dayKeyOf(row.ts)
        const key = `${dayKey}|${plan.tier}`
        let group = groups.get(key)
        if (!group) {
          group = {
            dayKey,
            tier: plan.tier,
            encoding: plan.encoding,
            container: join(archiveDir, containerName(dayKey, plan.tier)),
            rows: []
          }
          groups.set(key, group)
        }
        group.rows.push(row)
      }
      processed += 1
      await yieldOnce()
    }

    for (const group of groups.values()) {
      if (aborted) break
      try {
        packGroup(group, stats)
      } catch (error) {
        stats.failed += group.rows.length
        log('warn', 'chain retention: archive pack failed', {
          dayKey: group.dayKey,
          tier: group.tier,
          shots: group.rows.length,
          error: String(error)
        })
      }
      await yieldOnce()
    }

    containerCache.current = null
    if (stats.encoded + stats.packed + stats.failed > 0) {
      log('info', 'chain retention sweep', {
        scanned: stats.scanned,
        encoded: stats.encoded,
        packed: stats.packed,
        failed: stats.failed,
        containers: stats.containers,
        bytesBefore: stats.bytesBefore,
        bytesAfter: stats.bytesAfter
      })
    }
    return stats
  }

  const run = (): Promise<RetentionStats> => {
    if (running) return running
    aborted = false
    running = runSweep()
      .catch((error) => {
        log('error', 'chain retention: sweep failed', { error: String(error) })
        return emptyStats()
      })
      .finally(() => {
        running = null
      })
    return running
  }

  const start = (): void => {
    if (timer !== null) return
    void run()
    if (intervalMs > 0) {
      timer = setInterval(() => void run(), intervalMs)
      timer.unref?.()
    }
  }

  const stop = (): void => {
    aborted = true
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    run,
    start,
    stop,
    get busy() {
      return running !== null
    }
  }
}
