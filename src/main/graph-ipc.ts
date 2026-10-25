/**
 * 图谱窗口 IPC（M2 Phase 2）
 *
 * 权限面（§4.9）：`graph:*` 只接受图谱窗口主 frame；其它窗口 / iframe 一律拒绝。
 * 所有 handler 都是只读查询或显式用户动作（立即归纳 / 确认出网 / 保存设置 / 打开时间线），
 * 不暴露任意 SQL、路径或密钥。
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { BrowserWindow } from 'electron'
import type { GraphDayData, GraphGlobalData, NodeEventsResult } from '../understand/graph-query'
import { emptyGlobalGraph } from '../understand/graph-query'
import type { SaveNodePositionsResult } from '../understand/node-positions'
import { MAX_POSITIONS_PER_SAVE } from '../understand/node-positions'
import type { SearchHitEventsInput, SearchInput, SearchResult } from '../understand/search'
import type { ApiKeySource } from '../understand/cloud/providers'
import type { FetchModelsResult } from '../understand/cloud/models'
import type { GraphSettingsSaveResult, GraphSettingsView } from './graph-settings'
import type { InductionRunOutcome, InductionSnapshot } from './induction-runtime'
import type { HotkeyRegisterResult } from './hotkeys'
import type { RevertThemeMergeResult, ThemeMergeGroupView } from '../understand/theme-merge'

/** 跨进程返回时把 Error 摊平成字符串（structured clone 对 Error 的 message 不可靠） */
export type GraphInduceResult =
  | Exclude<InductionRunOutcome, { status: 'error' }>
  | { status: 'error'; message: string }

export interface ProviderModelsInput {
  providerId: string
  baseUrl: string
  /** 用户刚在输入框里填、尚未保存的密钥；留空则由主进程读已保存的密钥 */
  apiKey?: string
}

export type ProviderKeySaveResult =
  | {
      ok: true
      /** 已写入 .env，但同名环境变量优先（实际仍用环境变量里的密钥） */
      warning?: string
    }
  | { ok: false; error: string }

export type ProviderKeyStatus = Record<string, ApiKeySource>

/**
 * `graph:recompute`：按库里当前的相似度阈值重算相似连线（保存阈值后由渲染层调用）。
 * - `embeddings=false`：本地向量模型未就绪，只回填了结构，连线没动；
 * - `busy`：已有回填在跑（打开图谱的后台回填），本次没重算。
 */
export type GraphRecomputeResult =
  | { ok: true; edges: number; merges: number; embeddings: boolean }
  | { ok: false; reason: 'busy' | 'unavailable' }

export interface GraphIpcDeps {
  getGraphWindow(): BrowserWindow | null
  queryGraph(from: number, to: number): GraphDayData
  /** v0.3 全局图：一次取主题 / 时刻 / 归属 / embedding 边 / 位置 */
  queryGlobal(): GraphGlobalData
  queryNodeEvents(nodeId: number): NodeEventsResult
  /** 时刻下钻：`moments.event_ids` → events 行 */
  queryMomentEvents(momentId: number): NodeEventsResult
  /** 门一检索 v1：L0 全文 + app / 标题 / 时间窗过滤，结果按时刻成卡片 */
  search(input: SearchInput): SearchResult
  /** 检索卡片下钻（有 momentId 走时刻成员事件，否则按窗口现取） */
  searchHitEvents(input: SearchHitEventsInput): NodeEventsResult
  /** 检索的 app 过滤器候选项 */
  searchApps(): string[]
  /** Foam 沉降后回写主题坐标（下次打开作为 seed） */
  savePositions(input: unknown): SaveNodePositionsResult
  getSnapshot(): InductionSnapshot
  runInductionNow(dayStart?: number): Promise<InductionRunOutcome>
  setConsent(consented: boolean): void
  readSettings(): GraphSettingsView
  saveSettings(patch: unknown): GraphSettingsSaveResult
  /** 按当前阈值重算连线（不做节流：这是用户显式动作；在途回填时返回 busy） */
  recomputeGraph(): Promise<GraphRecomputeResult>
  /** 未撤销的主题合并记录（设置抽屉「合并记录」用） */
  listMerges(): ThemeMergeGroupView[]
  /** 撤销一次合并（传 group_id）；撤销后渲染层会再触发一次重算 + 重新拉图 */
  revertMerge(groupId: number): RevertThemeMergeResult
  /**
   * 保存成功后由主进程接手副作用（重绑热键 / 按确认门启停归纳）。
   * `previousConsent` 是**保存前**读到的确认门——保存后库里的值已经是新的，
   * 拿它和 `settings.outboundConsent` 比会永远相等，撤销 D24 就停不掉调度（也 abort 不了在途请求）。
   */
  onSettingsSaved(settings: GraphSettingsView, previousConsent: boolean): void
  getHotkeys(): readonly HotkeyRegisterResult[]
  openTimeline(day?: number): void
  fetchProviderModels(input: ProviderModelsInput): Promise<FetchModelsResult>
  saveProviderKey(providerId: string, apiKey: string): ProviderKeySaveResult
  getProviderKeyStatus(): ProviderKeyStatus
  log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>): void
}

const EMPTY_NODE_EVENTS: NodeEventsResult = {
  found: false,
  events: [],
  missingIds: [],
  malformed: false
}

const EMPTY_SEARCH: SearchResult = {
  query: '',
  mode: 'empty',
  hits: [],
  matchedEvents: 0,
  truncated: false
}

/** 检索输入上限（IPC 是信任边界，长度先卡死再进查询层） */
const MAX_QUERY_LENGTH = 200
const MAX_FILTER_TEXT_LENGTH = 200

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function serializeOutcome(outcome: InductionRunOutcome): GraphInduceResult {
  if (outcome.status === 'error') return { status: 'error', message: outcome.error.message }
  return outcome
}

/** IPC 入参校验：非法直接当空检索，不把原始输入塞进查询层 */
function readSearchInput(input: unknown): SearchInput | null {
  if (!isPlainObject(input)) return null
  if (typeof input.query !== 'string' || input.query.length > MAX_QUERY_LENGTH) return null

  const optionalText = (value: unknown): string | null | undefined => {
    if (value === undefined || value === null) return null
    if (typeof value !== 'string' || value.length > MAX_FILTER_TEXT_LENGTH) return undefined
    return value
  }
  const optionalTs = (value: unknown): number | null | undefined => {
    if (value === undefined || value === null) return null
    return isFiniteNumber(value) ? value : undefined
  }

  const app = optionalText(input.app)
  const titleContains = optionalText(input.titleContains)
  const fromTs = optionalTs(input.fromTs)
  const toTs = optionalTs(input.toTs)
  if (app === undefined || titleContains === undefined || fromTs === undefined || toTs === undefined) {
    return null
  }
  return { query: input.query, app, titleContains, fromTs, toTs }
}

function readSearchHitEventsInput(input: unknown): SearchHitEventsInput | null {
  if (!isPlainObject(input)) return null
  if (typeof input.app !== 'string' || input.app.length > MAX_FILTER_TEXT_LENGTH) return null
  const windowTitle = input.windowTitle
  if (
    windowTitle !== undefined &&
    windowTitle !== null &&
    (typeof windowTitle !== 'string' || windowTitle.length > MAX_FILTER_TEXT_LENGTH)
  ) {
    return null
  }
  if (!isFiniteNumber(input.startTs) || !isFiniteNumber(input.endTs)) return null
  const momentId = input.momentId
  if (momentId !== undefined && momentId !== null) {
    if (!Number.isInteger(momentId) || (momentId as number) <= 0) return null
  }
  return {
    momentId: (momentId as number | null | undefined) ?? null,
    app: input.app,
    windowTitle: (windowTitle as string | null | undefined) ?? null,
    startTs: input.startTs,
    endTs: input.endTs
  }
}

/**
 * 组装 `graph:*` 的 handler 表（不碰 ipcMain，便于单测直接调用某个通道）。
 * 权限面在 `ensureSender` 里：只认图谱窗口主 frame。
 */
export function createGraphIpcHandlers(
  deps: GraphIpcDeps
): Array<[string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown]> {
  const ensureSender = (event: IpcMainInvokeEvent): boolean => {
    const window = deps.getGraphWindow()
    if (!window || window.isDestroyed()) return false
    return (
      event.sender.id === window.webContents.id &&
      event.senderFrame === window.webContents.mainFrame
    )
  }

  return [
    [
      'graph:query',
      (event, from, to) => {
        if (!ensureSender(event) || !isFiniteNumber(from) || !isFiniteNumber(to) || to < from) {
          return { nodes: [], edges: [] } satisfies GraphDayData
        }
        try {
          return deps.queryGraph(from, to)
        } catch (error) {
          deps.log('warn', 'graph query failed', { error: String(error) })
          return { nodes: [], edges: [] } satisfies GraphDayData
        }
      }
    ],
    [
      'graph:global',
      (event) => {
        if (!ensureSender(event)) return emptyGlobalGraph()
        try {
          return deps.queryGlobal()
        } catch (error) {
          deps.log('warn', 'graph global query failed', { error: String(error) })
          return emptyGlobalGraph()
        }
      }
    ],
    [
      'graph:node-events',
      (event, nodeId) => {
        if (!ensureSender(event) || !Number.isInteger(nodeId) || (nodeId as number) <= 0) {
          return EMPTY_NODE_EVENTS
        }
        try {
          return deps.queryNodeEvents(nodeId as number)
        } catch (error) {
          deps.log('warn', 'graph node events failed', { error: String(error) })
          return EMPTY_NODE_EVENTS
        }
      }
    ],
    [
      'graph:moment-events',
      (event, momentId) => {
        if (!ensureSender(event) || !Number.isInteger(momentId) || (momentId as number) <= 0) {
          return EMPTY_NODE_EVENTS
        }
        try {
          return deps.queryMomentEvents(momentId as number)
        } catch (error) {
          deps.log('warn', 'graph moment events failed', { error: String(error) })
          return EMPTY_NODE_EVENTS
        }
      }
    ],
    [
      'graph:search',
      (event, input) => {
        if (!ensureSender(event)) return EMPTY_SEARCH
        const parsed = readSearchInput(input)
        if (!parsed) return EMPTY_SEARCH
        try {
          return deps.search(parsed)
        } catch (error) {
          // 只记「失败了」，不记查询串 / OCR 原文
          deps.log('warn', 'graph search failed', { error: String(error) })
          return EMPTY_SEARCH
        }
      }
    ],
    [
      'graph:search-hit-events',
      (event, input) => {
        if (!ensureSender(event)) return EMPTY_NODE_EVENTS
        const parsed = readSearchHitEventsInput(input)
        if (!parsed) return EMPTY_NODE_EVENTS
        try {
          return deps.searchHitEvents(parsed)
        } catch (error) {
          deps.log('warn', 'graph search hit events failed', { error: String(error) })
          return EMPTY_NODE_EVENTS
        }
      }
    ],
    ['graph:search-apps', (event) => (ensureSender(event) ? deps.searchApps() : [])],
    [
      'graph:positions:save',
      (event, positions) => {
        if (
          !ensureSender(event) ||
          !Array.isArray(positions) ||
          positions.length > MAX_POSITIONS_PER_SAVE
        ) {
          return { ok: false, error: '参数不合法' } satisfies SaveNodePositionsResult
        }
        try {
          return deps.savePositions(positions)
        } catch (error) {
          deps.log('warn', 'graph positions save failed', { error: String(error) })
          return { ok: false, error: '保存布局坐标失败' } satisfies SaveNodePositionsResult
        }
      }
    ],
    [
      'graph:status',
      (event) => (ensureSender(event) ? deps.getSnapshot() : { error: 'forbidden' })
    ],
    [
      'graph:induce-now',
      async (event, dayStart) => {
        if (!ensureSender(event)) return { status: 'error', message: 'forbidden' } satisfies GraphInduceResult
        try {
          const day = isFiniteNumber(dayStart) ? dayStart : undefined
          return serializeOutcome(await deps.runInductionNow(day))
        } catch (error) {
          deps.log('error', 'graph induce failed', { error: String(error) })
          return {
            status: 'error',
            message: error instanceof Error ? error.message : String(error)
          } satisfies GraphInduceResult
        }
      }
    ],
    [
      'graph:set-consent',
      (event, consented) => {
        if (!ensureSender(event) || typeof consented !== 'boolean') {
          return { error: 'forbidden' }
        }
        try {
          deps.setConsent(consented)
          return deps.getSnapshot()
        } catch (error) {
          deps.log('error', 'graph consent write failed', { error: String(error) })
          return { error: 'consent-write-failed' }
        }
      }
    ],
    [
      'graph:settings:get',
      (event) => (ensureSender(event) ? deps.readSettings() : { error: 'forbidden' })
    ],
    [
      'graph:settings:save',
      (event, patch) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' } satisfies GraphSettingsSaveResult
        try {
          // 必须在写库**之前**读旧确认门：保存后库里的值已经是新的
          const previousConsent = deps.readSettings().outboundConsent
          const result = deps.saveSettings(patch)
          if (result.ok) deps.onSettingsSaved(result.settings, previousConsent)
          return result
        } catch (error) {
          deps.log('error', 'graph settings save failed', { error: String(error) })
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          } satisfies GraphSettingsSaveResult
        }
      }
    ],
    [
      'graph:recompute',
      async (event) => {
        if (!ensureSender(event)) return { ok: false, reason: 'unavailable' } satisfies GraphRecomputeResult
        try {
          return await deps.recomputeGraph()
        } catch (error) {
          // 只记「失败了」，不记主题正文 / 向量
          deps.log('warn', 'graph recompute failed', { error: String(error) })
          return { ok: false, reason: 'unavailable' } satisfies GraphRecomputeResult
        }
      }
    ],
    [
      'graph:merges:list',
      (event) => {
        if (!ensureSender(event)) return []
        try {
          return deps.listMerges()
        } catch (error) {
          deps.log('warn', 'graph merges list failed', { error: String(error) })
          return []
        }
      }
    ],
    [
      'graph:merges:revert',
      (event, groupId) => {
        if (!ensureSender(event)) return { ok: false, reason: 'not-found' } satisfies RevertThemeMergeResult
        if (typeof groupId !== 'number' || !Number.isInteger(groupId) || groupId <= 0) {
          return { ok: false, reason: 'not-found' } satisfies RevertThemeMergeResult
        }
        try {
          return deps.revertMerge(groupId)
        } catch (error) {
          // 只记「失败了」，不记主题正文
          deps.log('warn', 'graph merge revert failed', { error: String(error) })
          return { ok: false, reason: 'not-found' } satisfies RevertThemeMergeResult
        }
      }
    ],
    [
      'graph:hotkeys',
      (event) => (ensureSender(event) ? deps.getHotkeys() : [])
    ],
    [
      'graph:provider:models',
      async (event, input) => {
        if (!ensureSender(event)) {
          return { ok: false, error: 'forbidden' } satisfies FetchModelsResult
        }
        if (
          !isPlainObject(input) ||
          typeof input.providerId !== 'string' ||
          typeof input.baseUrl !== 'string' ||
          (input.apiKey !== undefined && typeof input.apiKey !== 'string')
        ) {
          return { ok: false, error: '参数不合法' } satisfies FetchModelsResult
        }
        try {
          return await deps.fetchProviderModels({
            providerId: input.providerId,
            baseUrl: input.baseUrl,
            apiKey: input.apiKey
          })
        } catch (error) {
          // 只记「失败了」，不记 URL / 密钥 / 响应正文
          deps.log('warn', 'provider models fetch failed', { error: String(error) })
          return {
            ok: false,
            error: '获取模型失败，请检查供应商配置'
          } satisfies FetchModelsResult
        }
      }
    ],
    [
      'graph:provider:key',
      (event, input) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' } satisfies ProviderKeySaveResult
        if (
          !isPlainObject(input) ||
          typeof input.providerId !== 'string' ||
          typeof input.apiKey !== 'string'
        ) {
          return { ok: false, error: '参数不合法' } satisfies ProviderKeySaveResult
        }
        try {
          return deps.saveProviderKey(input.providerId, input.apiKey)
        } catch (error) {
          deps.log('error', 'provider key save failed', { error: String(error) })
          return { ok: false, error: '密钥保存失败' } satisfies ProviderKeySaveResult
        }
      }
    ],
    [
      'graph:provider:keys',
      (event) => (ensureSender(event) ? deps.getProviderKeyStatus() : {})
    ],
    [
      'graph:open-timeline',
      (event, day) => {
        if (!ensureSender(event)) return false
        const target =
          typeof day === 'number' && Number.isFinite(day) ? day : undefined
        deps.openTimeline(target)
        return true
      }
    ]
  ]
}

/** 注册到 ipcMain；卸载函数用于窗口关闭 / 测试清理 */
export function registerGraphIpc(deps: GraphIpcDeps): () => void {
  const handlers = createGraphIpcHandlers(deps)

  for (const [channel, handler] of handlers) ipcMain.handle(channel, handler)

  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel)
  }
}
