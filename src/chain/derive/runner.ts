/**
 * 信息链 · 派生层执行器（契约 v0.8 / D45）
 *
 * 一段收口（或收口后又有内容回来）就产生一件「派生」工作：
 *
 * 1. **向量**（本地、零出网）：去重 / 截断后的正文 → 本地 embedding → `chain_vector`；
 * 2. **抽取**（要出网，受 D24 确认门 + D22 每日预算约束）：正文 → LLM → 标签 / 双链名字；
 * 3. **合并**：候选名字与已有名字先做本地语义比对（≥0.95 直接复用），模糊带（0.90–0.95）
 *    攒成一批问模型，<0.90 新建（契约 §5 第 4 条，D29 同款口径）。
 *
 * 三条纪律：
 * - **串行**：一次只处理一段、一次只发一个请求（与在线归属同款，主进程不做并发爆发）；
 * - **幂等**：`chain_derive.text_hash` 记「这一段这个指纹抽过了」，内容没变就不再花 token；
 *   `content_max_id` 是更便宜的水位——又读回来一条内容才重新看指纹；
 * - **可降级**：未确认出网 / 没 key / 模型缺失时只做能做的部分（向量不需要授权），
 *   缺的部分留在待办里，下次开始采集再补；**不静默假装抽过**。
 *
 * 生命周期跟采集总开关走：`start()` 先扫一轮（补最近 200 段）再每 10 分钟扫一次；
 * `stop()` 中止在途请求。收口 / 内容写入只是「叫醒」，真正的判断都在扫描里。
 */

import type { Embedder } from '../../understand/embedding/types'
import { recordUsage, readUsage } from '../../understand/induction'
import type { LlmClient } from '../../understand/cloud/llm-client'
import {
  buildChainExtractPayload,
  buildChainMergePayload,
  type ChainPairKind
} from '../../understand/cloud/redact'
import { getSetting } from '../../db/settings'
import type { ChainDb } from '../store'
import { getSegment } from '../store'
import { bestMatch, mergeBand, nameKey, normalizeName, type NamedVector } from './names'
import { parseExtractResult, parseMergeResult } from './parse'
import {
  getDeriveMarker,
  getSegmentVector,
  insertLink,
  listLinks,
  listSegmentContents,
  listTagNames,
  listPendingDeriveSegments,
  putDeriveMarker,
  putSegmentVector,
  replaceSegmentLinks,
  replaceSegmentTags,
  setLinkAliases,
  type LinkRow,
  type PendingSegment
} from './store'
import { buildDeriveText, MAX_DERIVE_TEXT_CHARS } from './text'

export type DeriveLog = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  data?: Record<string, unknown>
) => void

/** 与 `main/induction-runtime.ts` 的 `ClientResolution` 同形（避免 chain 依赖 main） */
export type DeriveClientResolution =
  | { ok: true; client: LlmClient }
  | { ok: false; reason: string }

export interface ChainDeriverOptions {
  db: ChainDb
  now?: () => number
  log?: DeriveLog
  /** 出网确认门（D24）；缺省按未确认处理（零出网） */
  readConsent?: () => boolean
  /** 当前供应商客户端；缺省按没有客户端处理 */
  resolveClient?: () => DeriveClientResolution
  /** 本地向量模型（返回 null = 未就绪，只做同名合并）；缺省按未就绪处理 */
  loadEmbedder?: () => Promise<Embedder | null>
  /** 送模型的正文字符上限（默认 6000） */
  maxTextChars?: number
  /** 每轮最多处理多少段（默认 200，最近优先） */
  sweepLimit?: number
  /** 定时扫描间隔（默认 10 分钟；测试传 0 关掉） */
  sweepIntervalMs?: number
  /** 收口 / 内容写入后的防抖（默认 5s；让晚到的内容先落库） */
  debounceMs?: number
}

export interface DeriveStats {
  started: boolean
  sweeping: boolean
  /** 最近一轮看到的待办数 */
  pending: number
  /** 本实例写入 / 更新的段向量数（含只推水位的） */
  vectors: number
  /** 本实例成功抽取的段数 */
  extracted: number
  /** 本实例通过合并复用已有双链的候选次数（精确同名不算） */
  mergedLinks: number
  mergedTags: number
  /** 因敏感规则整段没出云的段数 */
  blocked: number
  failed: number
  /** 因未确认出网 / 没客户端 / 超预算而没抽取的段数（累计） */
  skippedConsent: number
  skippedClient: number
  skippedBudget: number
  lastError: string | null
}

export const DEFAULT_SWEEP_INTERVAL_MS = 10 * 60_000
export const DEFAULT_SWEEP_LIMIT = 200
export const DEFAULT_DEBOUNCE_MS = 5_000

/** 抽取失败后的退避（解析失败 / 请求失败都会退，避免每轮重抽同一段白烧 token） */
const FAILURE_BACKOFF_BASE_MS = 60_000
const FAILURE_BACKOFF_MAX_MS = 30 * 60_000

interface FailureBackoff {
  attempts: number
  until: number
}

type NameKind = ChainPairKind

interface CandidateResolution {
  kind: NameKind
  /** 归一后的候选写法（写库 / 问模型都用它） */
  candidate: string
  action: 'new' | 'reuse'
  /** 复用时的已有写法（链名 / 标签名） */
  canonical: string
  /** 复用时与已有写法的相似度（精确同名 = 1） */
  similarity: number
  /** 在模糊带里，等模型判 */
  ask: boolean
}

type SkipReason = 'consent' | 'client' | null
export class ChainDeriver {
  private readonly db: ChainDb
  private readonly now: () => number
  private readonly log: DeriveLog
  private readonly readConsent: () => boolean
  private readonly resolveClient: () => DeriveClientResolution
  private readonly loadEmbedder: () => Promise<Embedder | null>
  private readonly maxTextChars: number
  private readonly sweepLimit: number
  private readonly sweepIntervalMs: number
  private readonly debounceMs: number

  private running = false
  private timer: ReturnType<typeof setInterval> | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private controller: AbortController | null = null
  private sweeping: Promise<void> | null = null
  private rerun = false
  private embedderPromise: Promise<Embedder | null> | null = null
  /** 名字向量的进程内缓存（键：`link:` / `tag:` + nameKey） */
  private readonly nameVectors = new Map<string, Float32Array>()
  private readonly failures = new Map<number, FailureBackoff>()
  private readonly noted = new Set<string>()
  private readonly counters: DeriveStats

  constructor(options: ChainDeriverOptions) {
    this.db = options.db
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? (() => {})
    this.readConsent = options.readConsent ?? (() => false)
    this.resolveClient = options.resolveClient ?? (() => ({ ok: false, reason: 'not-configured' }))
    this.loadEmbedder = options.loadEmbedder ?? (async () => null)
    this.maxTextChars = options.maxTextChars ?? MAX_DERIVE_TEXT_CHARS
    this.sweepLimit = Math.max(1, options.sweepLimit ?? DEFAULT_SWEEP_LIMIT)
    this.sweepIntervalMs = Math.max(0, options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS)
    this.debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS)
    this.counters = {
      started: false,
      sweeping: false,
      pending: 0,
      vectors: 0,
      extracted: 0,
      mergedLinks: 0,
      mergedTags: 0,
      blocked: 0,
      failed: 0,
      skippedConsent: 0,
      skippedClient: 0,
      skippedBudget: 0,
      lastError: null
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.controller = new AbortController()
    this.counters.started = true
    this.noted.clear()
    // 开采集先补一轮（最近 200 段），之后按间隔扫
    this.schedule(0)
    if (this.sweepIntervalMs > 0) {
      this.timer = setInterval(() => this.schedule(0), this.sweepIntervalMs)
      this.timer.unref?.()
    }
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.counters.started = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.debounce) {
      clearTimeout(this.debounce)
      this.debounce = null
    }
    // 中止在途请求：结果丢弃、不写库、不推指纹（下一轮重试）
    this.controller?.abort()
    this.controller = null
  }

  /** 段收口了（记录器回调）：等晚到的内容落库再扫 */
  notifySegmentClosed(_segmentId: number): void {
    if (this.running) this.schedule(this.debounceMs)
  }

  /** 收口后的段又写回内容（UIA / OCR 晚到）：内容水位变了，再扫 */
  notifyContentWritten(_segmentId: number): void {
    if (this.running) this.schedule(this.debounceMs)
  }

  status(): DeriveStats {
    return { ...this.counters, sweeping: this.sweeping !== null }
  }

  /** 等当前一轮扫描跑完（测试 / 退出用；没有扫描时立即返回） */
  async drain(): Promise<void> {
    if (this.debounce) {
      clearTimeout(this.debounce)
      this.debounce = null
    }
    const current = this.sweeping
    if (current) await current
  }

  /** 立即扫一轮（测试 / 手动补做用；与定时器共用串行语义） */
  runNow(): Promise<void> {
    return this.sweep()
  }

  /* ---------------------------------------------------------------- */

  private schedule(delayMs: number): void {
    if (!this.running) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.sweep()
    }, delayMs)
    this.debounce.unref?.()
  }

  private sweep(): Promise<void> {
    if (!this.running) return Promise.resolve()
    if (this.sweeping) {
      this.rerun = true
      return this.sweeping
    }
    this.sweeping = (async () => {
      do {
        this.rerun = false
        try {
          await this.runOnce()
        } catch (error) {
          this.recordFailure(error)
        }
      } while (this.rerun && this.running)
    })().finally(() => {
      this.sweeping = null
    })
    return this.sweeping
  }

  private async runOnce(): Promise<void> {
    if (!this.running) return
    const signal = this.controller?.signal
    if (!signal) return
    const consent = this.readConsent()
    let client: LlmClient | null = null
    if (consent) {
      const resolution = this.resolveClient()
      if (resolution.ok) client = resolution.client
    }
    const includeExtract = consent && client !== null
    const pending = listPendingDeriveSegments(this.db, {
      includeExtract,
      limit: this.sweepLimit
    })
    this.counters.pending = pending.length
    if (pending.length === 0) return
    const skipReason: SkipReason = includeExtract ? null : consent ? 'client' : 'consent'

    let budgetExhausted = false
    let embeddedThisSweep = false
    for (const item of pending) {
      if (!this.running || signal.aborted) break
      const backoff = this.failures.get(item.segmentId)
      if (backoff && this.now() < backoff.until) continue
      try {
        const result = await this.deriveOne(item, {
          client: includeExtract ? client : null,
          signal,
          budgetExhausted,
          skipReason: includeExtract ? null : skipReason
        })
        budgetExhausted = budgetExhausted || result.budgetExhausted
        embeddedThisSweep = embeddedThisSweep || result.embedded
      } catch (error) {
        // 取消不算失败（暂停 / 退出）
        if (!this.running || signal.aborted) break
        this.counters.failed += 1
        this.recordFailure(error, item.segmentId)
      }
    }

    if (skipReason !== null) {
      const message =
        skipReason === 'consent'
          ? 'chain derive: 未确认出网，只建向量不抽标签 / 双链'
          : 'chain derive: 没有可用的 LLM 客户端，只建向量'
      this.noteOnce(skipReason, message, { pending: pending.length })
    }

    this.log('info', 'chain derive sweep', {
      pending: pending.length,
      vectors: this.counters.vectors,
      extracted: this.counters.extracted,
      merged: this.counters.mergedLinks + this.counters.mergedTags,
      blocked: this.counters.blocked,
      failed: this.counters.failed,
      budget: budgetExhausted,
      embedded: embeddedThisSweep
    })
  }

  private recordFailure(error: unknown, segmentId?: number): void {
    const message = error instanceof Error ? error.message : String(error)
    this.counters.lastError = message.slice(0, 200)
    if (segmentId !== undefined) {
      // 同一段失败后先退避，别让每 10 分钟一轮把它重抽成「固定支出」
      const previous = this.failures.get(segmentId)
      const attempts = (previous?.attempts ?? 0) + 1
      const delay = Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_BASE_MS * 2 ** (attempts - 1))
      this.failures.set(segmentId, { attempts, until: this.now() + delay })
    }
    this.log('warn', 'chain derive failed', {
      segmentId: segmentId ?? null,
      error: message.slice(0, 200)
    })
  }

  private noteOnce(key: string, msg: string, data?: Record<string, unknown>): void {
    if (this.noted.has(key)) return
    this.noted.add(key)
    this.log('info', msg, data)
  }

  /* ---------------------------------------------------------------- */
  /* 单段派生                                                          */
  /* ---------------------------------------------------------------- */

  private async deriveOne(
    item: PendingSegment,
    context: {
      client: LlmClient | null
      signal: AbortSignal
      budgetExhausted: boolean
      skipReason: SkipReason
    }
  ): Promise<{ budgetExhausted: boolean; embedded: boolean }> {
    const segment = getSegment(this.db, item.segmentId)
    if (!segment) return { budgetExhausted: context.budgetExhausted, embedded: false }

    const rows = listSegmentContents(this.db, item.segmentId)
    const text = buildDeriveText(rows, { maxChars: this.maxTextChars })
    if (text.text === '') {
      // 理论上不该发生（记录器拒绝空正文）；真发生了也不写空指纹，留给人工看日志
      this.log('warn', 'chain derive: 段正文去重后为空', { segmentId: item.segmentId })
      return { budgetExhausted: context.budgetExhausted, embedded: false }
    }

    const embedded = await this.ensureVector(item, text.hash, text.text)

    const marker = getDeriveMarker(this.db, item.segmentId)
    if (marker && marker.text_hash === text.hash) {
      // 指纹没变：只推水位，不重抽
      if (marker.content_max_id !== item.maxContentId) {
        putDeriveMarker(this.db, {
          segmentId: item.segmentId,
          textHash: text.hash,
          contentMaxId: item.maxContentId,
          derivedAt: marker.derived_at
        })
      }
      return { budgetExhausted: false, embedded }
    }

    if (context.budgetExhausted) return { budgetExhausted: true, embedded }
    if (!context.client) {
      if (context.skipReason === 'consent') this.counters.skippedConsent += 1
      else if (context.skipReason === 'client') this.counters.skippedClient += 1
      return { budgetExhausted: false, embedded }
    }
    if (this.overBudget()) {
      this.counters.skippedBudget += 1
      this.noteOnce('budget', 'chain derive: 今日 token 预算已用完，抽取暂停')
      return { budgetExhausted: true, embedded }
    }

    const built = buildChainExtractPayload(
      [
        {
          segmentId: item.segmentId,
          app: segment.app ?? '',
          title: segment.title_last ?? segment.title_first ?? '',
          text: text.text,
          truncated: text.truncated
        }
      ],
      { textMaxChars: this.maxTextChars }
    )
    if (built.payload.segments.length === 0) {
      // 脱敏后仍命中敏感规则：整段不出云。写空指纹免得每轮重试，但记清楚原因。
      this.counters.blocked += 1
      replaceSegmentTags(this.db, item.segmentId, [])
      replaceSegmentLinks(this.db, item.segmentId, [])
      putDeriveMarker(this.db, {
        segmentId: item.segmentId,
        textHash: text.hash,
        contentMaxId: item.maxContentId,
        derivedAt: this.now()
      })
      this.log('info', 'chain derive: 段内容被敏感规则挡下，未出云', {
        segmentId: item.segmentId
      })
      return { budgetExhausted: false, embedded }
    }

    const extract = await context.client.completeChainExtract(built.payload, {
      signal: context.signal
    })
    this.recordTokens(extract.usage.promptTokens, extract.usage.completionTokens, 1)
    const parsed = parseExtractResult(extract.json)

    const embedder = await this.getEmbedder()
    const resolved = await this.resolveNames(
      [
        ...parsed.links.map((name) => ({ name, kind: 'link' as const })),
        ...parsed.tags.map((name) => ({ name, kind: 'tag' as const }))
      ],
      { client: context.client, signal: context.signal, embedder }
    )

    this.writeResolved(item.segmentId, resolved)
    putDeriveMarker(this.db, {
      segmentId: item.segmentId,
      textHash: text.hash,
      contentMaxId: item.maxContentId,
      derivedAt: this.now()
    })
    this.counters.extracted += 1
    this.failures.delete(item.segmentId)
    return { budgetExhausted: false, embedded }
  }

  /** 建 / 更新段向量；返回「这次真的跑了模型」 */
  private async ensureVector(item: PendingSegment, hash: string, text: string): Promise<boolean> {
    const existing = getSegmentVector(this.db, item.segmentId)
    const embedder = await this.getEmbedder()
    if (embedder && existing && existing.textHash === hash && existing.model === embedder.model) {
      if (existing.contentMaxId !== item.maxContentId) {
        putSegmentVector(this.db, {
          segmentId: item.segmentId,
          model: existing.model,
          vec: existing.vec,
          textHash: hash,
          contentMaxId: item.maxContentId
        })
        this.counters.vectors += 1
      }
      return false
    }
    if (!embedder) {
      this.noteOnce('embedder', 'chain derive: 本地向量模型未就绪，段向量暂不建')
      return false
    }
    const [vec] = await embedder.embed([text])
    if (!vec || vec.length === 0) {
      this.noteOnce('embedder-empty', 'chain derive: 本地向量模型返回空向量')
      return false
    }
    putSegmentVector(this.db, {
      segmentId: item.segmentId,
      model: embedder.model,
      vec,
      textHash: hash,
      contentMaxId: item.maxContentId
    })
    this.counters.vectors += 1
    return true
  }

  private async getEmbedder(): Promise<Embedder | null> {
    if (!this.embedderPromise) {
      this.embedderPromise = this.loadEmbedder()
        .then((embedder) => {
          if (embedder === null) this.embedderPromise = null
          return embedder
        })
        .catch(() => {
          this.embedderPromise = null
          return null
        })
    }
    return this.embedderPromise
  }

  /* ---------------------------------------------------------------- */
  /* 名字合并                                                          */
  /* ---------------------------------------------------------------- */

  private async resolveNames(
    candidates: readonly { name: string; kind: NameKind }[],
    context: { client: LlmClient; signal: AbortSignal; embedder: Embedder | null }
  ): Promise<CandidateResolution[]> {
    const links = listLinks(this.db)
    const tags = listTagNames(this.db)
    const linkByKey = new Map<string, { id: number; name: string }>()
    for (const link of links) {
      linkByKey.set(nameKey(link.name), { id: link.id, name: link.name })
      for (const alias of link.aliases) linkByKey.set(nameKey(alias), { id: link.id, name: link.name })
    }
    const tagByKey = new Map<string, string>()
    for (const tag of tags) tagByKey.set(nameKey(tag), tag)

    const resolutions: CandidateResolution[] = []
    const needVector: Array<{ index: number; name: string; kind: NameKind }> = []

    for (const candidate of candidates) {
      const display = normalizeName(candidate.name)
      if (display === '') continue
      const key = nameKey(display)
      if (candidate.kind === 'link') {
        const hit = linkByKey.get(key)
        if (hit) {
          resolutions.push({
            kind: 'link',
            candidate: display,
            action: 'reuse',
            canonical: hit.name,
            similarity: 1,
            ask: false
          })
          continue
        }
      } else {
        const hit = tagByKey.get(key)
        if (hit) {
          resolutions.push({
            kind: 'tag',
            candidate: display,
            action: 'reuse',
            canonical: hit,
            similarity: 1,
            ask: false
          })
          continue
        }
      }
      // 没有精确命中：先占位，等向量 / 模型
      resolutions.push({
        kind: candidate.kind,
        candidate: display,
        action: 'new',
        canonical: display,
        similarity: 0,
        ask: false
      })
      if (context.embedder) needVector.push({ index: resolutions.length - 1, name: display, kind: candidate.kind })
    }

    if (needVector.length > 0 && context.embedder) {
      const embedder = context.embedder
      const candidateVectors = await this.embedDirect(
        embedder,
        needVector.map((entry) => entry.name)
      )
      // 双链的匹配池要带别名，但**名字要归到链本身**——否则命中的是别名时，
      // 写库会把别名当成另一条链（第一版就踩过：多了个「记忆系统设计」链）。
      const linkEntries = await this.linkEntries(embedder, links)
      const tagEntries = await this.namedVectors(embedder, 'tag', tags)

      for (const entry of needVector) {
        const vec = candidateVectors.get(entry.name)
        if (!vec) continue
        const pool = entry.kind === 'link' ? linkEntries : tagEntries
        const best = bestMatch(vec, pool)
        const resolution = resolutions[entry.index]
        if (!best) continue
        const band = mergeBand(best.similarity)
        if (band === 'reuse') {
          resolution.action = 'reuse'
          resolution.canonical = best.name
          resolution.similarity = best.similarity
        } else if (band === 'ask') {
          resolution.ask = true
          resolution.canonical = best.name
          resolution.similarity = best.similarity
        }
      }
    }

    const asks = resolutions
      .map((resolution, index) => ({ resolution, index }))
      .filter((entry) => entry.resolution.ask)
    if (asks.length > 0) {
      const built = buildChainMergePayload(
        asks.map((entry) => ({
          candidate: entry.resolution.candidate,
          existing: entry.resolution.canonical,
          kind: entry.resolution.kind
        }))
      )
      if (built.payload.pairs.length > 0) {
        const answer = await context.client.completeChainMerge(built.payload, {
          signal: context.signal
        })
        this.recordTokens(answer.usage.promptTokens, answer.usage.completionTokens, 1)
        const same = parseMergeResult(answer.json, built.payload.pairs.length)
        built.payload.pairs.forEach((pair, position) => {
          const entry = asks[pair.index]
          if (!entry) return
          entry.resolution.action = same[position] ? 'reuse' : 'new'
          if (!same[position]) entry.resolution.canonical = entry.resolution.candidate
          entry.resolution.ask = false
        })
      }
      // 被敏感规则挡下的对：不问了，按新建处理
      for (const blockedIndex of built.blocked) {
        const entry = asks[blockedIndex]
        if (!entry) continue
        entry.resolution.action = 'new'
        entry.resolution.canonical = entry.resolution.candidate
        entry.resolution.ask = false
      }
    }

    return resolutions
  }

  /** 一批名字 → 向量（带进程内缓存） */
  private async embedCached(
    embedder: Embedder,
    names: readonly string[],
    prefix: string
  ): Promise<Map<string, Float32Array>> {
    const result = new Map<string, Float32Array>()
    const missing: string[] = []
    const missingKeys: string[] = []
    for (const name of names) {
      const key = `${prefix}${nameKey(name)}`
      const cached = this.nameVectors.get(key)
      if (cached) result.set(name, cached)
      else {
        missing.push(name)
        missingKeys.push(key)
      }
    }
    if (missing.length > 0) {
      const vectors = await embedder.embed(missing)
      missing.forEach((name, index) => {
        const vec = vectors[index]
        if (!vec || vec.length === 0) return
        this.nameVectors.set(missingKeys[index], vec)
        result.set(name, vec)
      })
    }
    return result
  }

  /** 候选名字向量：不进缓存（每段都不同，缓存只会涨内存） */
  private async embedDirect(
    embedder: Embedder,
    names: readonly string[]
  ): Promise<Map<string, Float32Array>> {
    const result = new Map<string, Float32Array>()
    const unique: string[] = []
    const seen = new Set<string>()
    for (const name of names) {
      const key = nameKey(name)
      if (seen.has(key)) continue
      seen.add(key)
      unique.push(name)
    }
    if (unique.length === 0) return result
    const vectors = await embedder.embed(unique)
    unique.forEach((name, index) => {
      const vec = vectors[index]
      if (vec && vec.length > 0) result.set(name, vec)
    })
    return result
  }

  private async namedVectors(
    embedder: Embedder,
    kind: NameKind,
    names: readonly string[]
  ): Promise<NamedVector[]> {
    const map = await this.embedCached(embedder, names, `${kind}:`)
    const entries: NamedVector[] = []
    for (const name of names) {
      const vec = map.get(name)
      if (vec) entries.push({ name, vec })
    }
    return entries
  }

  /** 双链匹配池：每条链的正式名与别名都参与比对，但命中后都归到链的正式名 */
  private async linkEntries(embedder: Embedder, links: readonly LinkRow[]): Promise<NamedVector[]> {
    const spellings: string[] = []
    for (const link of links) {
      spellings.push(link.name, ...link.aliases)
    }
    const map = await this.embedCached(embedder, spellings, 'link:')
    const entries: NamedVector[] = []
    for (const link of links) {
      for (const spelling of [link.name, ...link.aliases]) {
        const vec = map.get(spelling)
        if (vec) entries.push({ name: link.name, vec })
      }
    }
    return entries
  }

  private writeResolved(segmentId: number, resolutions: readonly CandidateResolution[]): void {
    const linkRows = new Map<string, number>()
    for (const link of listLinks(this.db)) linkRows.set(nameKey(link.name), link.id)
    const seenLinks = new Set<number>()
    const linkUses: Array<{ linkId: number; weight: number }> = []
    const aliasAdds = new Map<number, Set<string>>()
    const tagNames: Array<{ name: string; source: string }> = []
    const seenTags = new Set<string>()

    for (const resolution of resolutions) {
      if (resolution.kind === 'link') {
        let linkId: number
        if (resolution.action === 'reuse') {
          const key = nameKey(resolution.canonical)
          const existing = linkRows.get(key)
          if (existing === undefined) {
            // 理论上不会发生（canonical 来自已有名字）；退化为新建，别丢这一条
            linkId = insertLink(this.db, resolution.canonical)
            linkRows.set(key, linkId)
          } else {
            linkId = existing
          }
          if (nameKey(resolution.candidate) !== key) {
            const set = aliasAdds.get(linkId) ?? new Set<string>()
            set.add(resolution.candidate)
            aliasAdds.set(linkId, set)
          }
          if (resolution.similarity < 1) this.counters.mergedLinks += 1
        } else {
          linkId = insertLink(this.db, resolution.candidate)
          linkRows.set(nameKey(resolution.candidate), linkId)
        }
        if (seenLinks.has(linkId)) continue
        seenLinks.add(linkId)
        linkUses.push({ linkId, weight: 1 })
      } else {
        const name = resolution.action === 'reuse' ? resolution.canonical : resolution.candidate
        const key = nameKey(name)
        if (seenTags.has(key)) continue
        seenTags.add(key)
        tagNames.push({ name, source: 'llm' })
        if (resolution.action === 'reuse' && resolution.similarity < 1) this.counters.mergedTags += 1
      }
    }

    replaceSegmentLinks(this.db, segmentId, linkUses)
    replaceSegmentTags(this.db, segmentId, tagNames)
    for (const [linkId, additions] of aliasAdds) {
      const current = readLink(this.db, linkId)
      if (!current) continue
      setLinkAliases(this.db, linkId, [...current.aliases, ...additions])
    }
  }

  /* ---------------------------------------------------------------- */
  /* 预算                                                              */
  /* ---------------------------------------------------------------- */

  private budgetTokens(): number {
    const parsed = Number(getSetting(this.db, 'graph.budget_tokens_per_day'))
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_000_000
  }

  private overBudget(): boolean {
    const usage = readUsage(this.db, this.now())
    return usage.promptTokens + usage.completionTokens >= this.budgetTokens()
  }

  private recordTokens(promptTokens: number, completionTokens: number, calls: number): void {
    if (promptTokens + completionTokens <= 0) return
    recordUsage(this.db, this.now(), { calls, promptTokens, completionTokens })
  }
}

/** 按 id 读一条双链（用于追加别名） */
function readLink(db: ChainDb, linkId: number): LinkRow | null {
  const row = db.prepare('SELECT id, name, aliases FROM chain_link WHERE id = ?').get(linkId) as
    | { id: number; name: string; aliases: string | null }
    | undefined
  if (!row) return null
  let aliases: string[] = []
  if (row.aliases) {
    try {
      const parsed: unknown = JSON.parse(row.aliases)
      if (Array.isArray(parsed)) {
        aliases = parsed.filter((item): item is string => typeof item === 'string')
      }
    } catch {
      aliases = []
    }
  }
  return { id: row.id, name: row.name, aliases }
}
