/**
 * 问记忆窗口（S3-lite）的 IPC
 *
 * 与 `graph-ipc.ts` 同一套纪律：**只收主框架的调用**（`mainFrame`），参数在边界上校验，
 * 出错变成可读结果（不把异常抛回渲染进程 —— 渲染层白屏比报错更坏）。
 *
 * 通道：
 * - `ask:query`        问题（+ 会话 id）→ `ChainAskResult`（S1 的 `askChain`），成功走完落一条对话记录
 * - `ask:resume`       「还要继续查吗」的选择（continue / stop）→ 恢复暂停的循环，结果落同一条对话
 * - `ask:cancel`       中止当前在途提问（用户点「停止」）
 * - `ask:segment`      段 id → 段证据（截图转 data URL 由 deps 注入）
 * - `ask:consent:get`  出云确认门状态
 * - `ask:consent:set`  就地确认 / 撤销
 * - `ask:history`      全部对话记录（最新在前）
 * - `ask:history:clear` 清空对话记录
 * - `ask:settings:get/save`、`ask:provider:models/key/keys`（D53）：
 *   图谱入口封存后，供应商 / 密钥 / 出网确认只能在这里配。校验与图谱窗口**同一套**
 *   （`graph-ipc.ts` 的字段规则直接复用），保存后副作用交给 `onSettingsSaved` 注入。
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { ChainAskResult, ChainAskResumeDecision, ChainAskTurnContext } from '../chain/agent/types'
import type { SegmentEvidence } from '../chain/agent/evidence'
import type { AskHistoryEntry } from './ask-history'
import type { GraphSettingsSaveResult, GraphSettingsView } from './graph-settings'
import type { MemorySettingsSaveResult, MemorySettingsView } from './memory-settings'
import type { ProviderKeySaveResult, ProviderModelsInput } from './graph-ipc'
import type { ApiKeySource } from '../understand/cloud/providers'
import type { FetchModelsResult } from '../understand/cloud/models'

export interface AskConsentView {
  /** D24 一次性出网授权 */
  consented: boolean
  /** 有没有可用的模型客户端（缺 key / 配置不合法时为 false） */
  clientReady: boolean
  /** 没有客户端时的原因（missing-key 等），给界面显示 */
  clientReason?: string
}

/** 一次提问的上下文：会话 id + 该会话之前的几轮 + 取消信号（+ 选区问答附带的截图路径） */
export interface AskQueryContext {
  conversationId: string
  history: readonly ChainAskTurnContext[]
  signal: AbortSignal
  /** 选区问答：随这条对话留存的截图（主进程校验后给绝对路径） */
  imagePath?: string
}

export interface AskIpcDeps {
  getWindow: () => BrowserWindow | null
  ask: (question: string, context: AskQueryContext) => Promise<ChainAskResult>
  segment: (segmentId: number) => SegmentEvidence | null
  consent: () => AskConsentView
  setConsent: (consented: boolean) => AskConsentView
  /** 成功走完一次提问就落一条历史（失败只记日志，不能影响回答）；`imagePath` 只有选区问答才有 */
  record: (question: string, result: ChainAskResult, conversationId: string, imagePath?: string) => void
  /** 截图路径 → data URL（渲染层读不了文件）；路径非法 / 读不到返回 null */
  image?: (path: string) => string | null
  /**
   * 续查：恢复上一次被暂停的循环（`continue-ask`）。
   * `decision=continue` 继续检索；`decision=stop` 按现有结果收尾。
   * 没接这个能力时 `ask:resume` 一律失败（老版本窗口不会用到）。
   */
  resume?: (
    resumeId: string,
    decision: ChainAskResumeDecision,
    context: AskQueryContext
  ) => Promise<ChainAskResult>
  /** 同一会话之前的几轮（主进程按 conversationId 从历史里筛；缺省按空对话处理） */
  conversationHistory?: (conversationId: string) => readonly ChainAskTurnContext[]
  /** 全部历史（最新在前） */
  history: () => AskHistoryEntry[]
  /** 清空历史 */
  clearHistory: () => void
  /**
   * D53：设置抽屉（供应商 / 密钥 / 出网确认）。
   * 与图谱窗口共用主进程实现——两边校验、密钥落盘路径、热键重绑必须是同一套。
   */
  settings?: () => GraphSettingsView | { error: string }
  saveSettings?: (patch: unknown) => GraphSettingsSaveResult
  /** 保存成功后主进程接手副作用（重绑热键 / 按确认门启停），和 `graph:settings:save` 同口径 */
  onSettingsSaved?: (settings: GraphSettingsView, previousConsent: boolean) => void
  providerModels?: (input: ProviderModelsInput) => Promise<FetchModelsResult>
  saveProviderKey?: (providerId: string, apiKey: string) => ProviderKeySaveResult
  providerKeys?: () => Record<string, ApiKeySource>
  /**
   * 个人记忆（vibe/free）：日记目录 + 人设。保存后主进程**立即同步**日记目录
   * （用户选的口径：保存即同步），同步结果随返回值一起回界面。
   */
  memorySettings?: () => MemorySettingsView | { error: string }
  saveMemorySettings?: (patch: unknown) => MemorySettingsSaveResult
  log: (level: 'warn' | 'error', message: string, data?: Record<string, unknown>) => void
}

/** 问题长度上限：和 `buildChainAskPayload` 的 500 字对齐 */
export const ASK_QUESTION_MAX_CHARS = 500
/** 会话 id 的形态上限（渲染层生成；只作分组键，不落 SQL） */
const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** 续查句柄形态（主进程生成：r + 时间 + 随机） */
const RESUME_ID_RE = /^r[a-z0-9]{4,40}$/
/** 同时挂起的「还要继续吗」上限：正常一次只有一个，多窗口也不会无限攒 */
const PENDING_RESUME_MAX = 8

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只认问记忆窗口自己的主框架（子框架 / 其它 webContents 一律拒） */
function createSenderCheck(deps: AskIpcDeps): (event: IpcMainInvokeEvent) => boolean {
  return (event) => {
    const window = deps.getWindow()
    if (!window || window.isDestroyed()) return false
    return (
      event.sender.id === window.webContents.id &&
      event.senderFrame === window.webContents.mainFrame
    )
  }
}

function failure(message: string): ChainAskResult {
  return {
    kind: 'error',
    reason: 'failed',
    message,
    stats: { hits: 0, evidence: 0, cited: 0, questionChars: 0 }
  }
}

export function createAskIpcHandlers(deps: AskIpcDeps): Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown> {
  const ensureSender = createSenderCheck(deps)
  /** 在途提问（同一时刻只跑一次；新提问会中止旧的，避免两次回答交错落进同一会话） */
  let active: AbortController | null = null
  /** 挂起的「还要继续吗」：resumeId → 原始问题 + 会话 + 截图（答案没出来前不落历史） */
  const pendingResume = new Map<
    string,
    { question: string; conversationId: string; imagePath?: string }
  >()

  /**
   * 一次问答收口：暂停（continue-ask）暂时不落历史——用户还没决定、答案还没出来；
   * 其余结果照常落一条。历史写失败不能让提问失败，记一条 warn 就行。
   */
  const settle = (
    question: string,
    conversationId: string,
    result: ChainAskResult,
    imagePath?: string
  ): ChainAskResult => {
    if (result.kind === 'continue-ask') {
      if (result.resumeId) {
        while (pendingResume.size >= PENDING_RESUME_MAX) {
          const oldest = pendingResume.keys().next().value
          if (oldest === undefined) break
          pendingResume.delete(oldest)
        }
        pendingResume.set(result.resumeId, { question, conversationId, ...(imagePath ? { imagePath } : {}) })
      }
      return result
    }
    try {
      // 不带图时只传三个参数：老测试 / 老调用方的入参形状保持不变
      if (imagePath) deps.record(question, result, conversationId, imagePath)
      else deps.record(question, result, conversationId)
    } catch (error) {
      deps.log('warn', 'ask history record failed', { error: String(error) })
    }
    return result
  }

  return new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>([
    [
      'ask:query',
      async (event, input) => {
        if (!ensureSender(event)) return failure('forbidden')
        const payload = isPlainObject(input) ? input : { question: input }
        const rawQuestion = payload.question
        if (typeof rawQuestion !== 'string') return failure('问题不合法')
        const asked = rawQuestion.trim()
        if (asked === '') return failure('问题是空的')
        if (asked.length > ASK_QUESTION_MAX_CHARS) {
          return failure(`问题太长（上限 ${ASK_QUESTION_MAX_CHARS} 字）`)
        }
        // 会话 id：老调用方（纯字符串）没有就现造一个，保证每次提问都有归属
        const conversationId =
          typeof payload.conversationId === 'string' && CONVERSATION_ID_RE.test(payload.conversationId)
            ? payload.conversationId
            : `c${Date.now().toString(36)}`

        // 选区问答：截图路径只做形状校验，真正的「在不在 ask-shots 里」由主进程 deps 校验
        const rawImage = payload.imagePath
        const imagePath =
          typeof rawImage === 'string' && rawImage.length > 0 && rawImage.length <= 512
            ? rawImage
            : undefined

        let history: readonly ChainAskTurnContext[] = []
        try {
          history = deps.conversationHistory?.(conversationId) ?? []
        } catch (error) {
          deps.log('warn', 'ask history context failed', { error: String(error) })
        }

        active?.abort()
        const controller = new AbortController()
        active = controller
        try {
          const result = await deps.ask(asked, {
            conversationId,
            history,
            signal: controller.signal,
            ...(imagePath ? { imagePath } : {})
          })
          return settle(asked, conversationId, result, imagePath)
        } catch (error) {
          deps.log('error', 'ask:query failed', { error: String(error) })
          return failure('问记忆出错，看日志')
        } finally {
          if (active === controller) active = null
        }
      }
    ],
    [
      'ask:resume',
      async (event, input) => {
        if (!ensureSender(event)) return failure('forbidden')
        if (!isPlainObject(input)) return failure('续查参数不合法')
        const resumeId = input.resumeId
        const decision = input.decision
        if (typeof resumeId !== 'string' || !RESUME_ID_RE.test(resumeId)) {
          return failure('续查参数不合法')
        }
        if (decision !== 'continue' && decision !== 'stop') return failure('续查参数不合法')
        if (!deps.resume) return failure('当前版本不支持续查')
        const pending = pendingResume.get(resumeId)
        if (!pending) return failure('这次追问已经过期（窗口重开或等太久），重新问一遍就好')
        pendingResume.delete(resumeId)

        let history: readonly ChainAskTurnContext[] = []
        try {
          history = deps.conversationHistory?.(pending.conversationId) ?? []
        } catch (error) {
          deps.log('warn', 'ask history context failed', { error: String(error) })
        }

        active?.abort()
        const controller = new AbortController()
        active = controller
        try {
          const result = await deps.resume(resumeId, decision, {
            conversationId: pending.conversationId,
            history,
            signal: controller.signal,
            ...(pending.imagePath ? { imagePath: pending.imagePath } : {})
          })
          return settle(pending.question, pending.conversationId, result, pending.imagePath)
        } catch (error) {
          deps.log('error', 'ask:resume failed', { error: String(error) })
          return failure('续查出错，看日志')
        } finally {
          if (active === controller) active = null
        }
      }
    ],
    [
      'ask:cancel',
      (event) => {
        if (!ensureSender(event)) return false
        active?.abort()
        return true
      }
    ],
    [
      'ask:segment',
      (event, segmentId) => {
        if (!ensureSender(event)) return null
        if (typeof segmentId !== 'number' || !Number.isInteger(segmentId) || segmentId <= 0) return null
        try {
          return deps.segment(segmentId)
        } catch (error) {
          deps.log('error', 'ask:segment failed', { segmentId, error: String(error) })
          return null
        }
      }
    ],
    ['ask:consent:get', (event) => (ensureSender(event) ? deps.consent() : null)],
    [
      'ask:image',
      (event, path) => {
        if (!ensureSender(event)) return null
        if (typeof path !== 'string' || path.length === 0 || path.length > 512) return null
        if (!deps.image) return null
        try {
          return deps.image(path)
        } catch (error) {
          deps.log('warn', 'ask image read failed', { error: String(error) })
          return null
        }
      }
    ],
    [
      'ask:consent:set',
      (event, input) => {
        if (!ensureSender(event)) return null
        if (!isPlainObject(input) || typeof input.consented !== 'boolean') return null
        try {
          return deps.setConsent(input.consented)
        } catch (error) {
          deps.log('error', 'ask:consent:set failed', { error: String(error) })
          return null
        }
      }
    ],
    [
      'ask:settings:get',
      (event) => {
        if (!ensureSender(event)) return { error: 'forbidden' }
        try {
          return deps.settings?.() ?? { error: 'unsupported' }
        } catch (error) {
          deps.log('error', 'ask settings read failed', { error: String(error) })
          return { error: 'settings-read-failed' }
        }
      }
    ],
    [
      'ask:settings:save',
      (event, patch) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' } satisfies GraphSettingsSaveResult
        if (!deps.saveSettings) {
          return { ok: false, error: '当前版本不支持保存设置' } satisfies GraphSettingsSaveResult
        }
        try {
          // 必须在写库**之前**读旧确认门：保存后库里的值已经是新的（D24 漏洞的修法同 graph:settings:save）
          const previous = deps.settings?.()
          const previousConsent =
            previous && !('error' in previous) ? previous.outboundConsent : false
          const result = deps.saveSettings(patch)
          if (result.ok) deps.onSettingsSaved?.(result.settings, previousConsent)
          return result
        } catch (error) {
          deps.log('error', 'ask settings save failed', { error: String(error) })
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          } satisfies GraphSettingsSaveResult
        }
      }
    ],
    [
      'ask:memory:get',
      (event) => {
        if (!ensureSender(event)) return { error: 'forbidden' }
        try {
          return deps.memorySettings?.() ?? { error: 'unsupported' }
        } catch (error) {
          deps.log('error', 'ask memory settings read failed', { error: String(error) })
          return { error: 'memory-settings-read-failed' }
        }
      }
    ],
    [
      'ask:memory:save',
      (event, patch) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' }
        if (!deps.saveMemorySettings) {
          return { ok: false, error: '当前版本不支持保存个人记忆设置' }
        }
        try {
          return deps.saveMemorySettings(patch)
        } catch (error) {
          deps.log('error', 'ask memory settings save failed', { error: String(error) })
          return { ok: false, error: '保存失败' }
        }
      }
    ],
    [
      'ask:provider:models',
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
        if (!deps.providerModels) {
          return { ok: false, error: '当前版本不支持获取模型' } satisfies FetchModelsResult
        }
        try {
          return await deps.providerModels({
            providerId: input.providerId,
            baseUrl: input.baseUrl,
            ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {})
          })
        } catch (error) {
          // 只记「失败了」，不记 URL / 密钥 / 响应正文
          deps.log('warn', 'ask provider models fetch failed', { error: String(error) })
          return { ok: false, error: '获取模型失败，请检查供应商配置' } satisfies FetchModelsResult
        }
      }
    ],
    [
      'ask:provider:key',
      (event, input) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' } satisfies ProviderKeySaveResult
        if (
          !isPlainObject(input) ||
          typeof input.providerId !== 'string' ||
          typeof input.apiKey !== 'string'
        ) {
          return { ok: false, error: '参数不合法' } satisfies ProviderKeySaveResult
        }
        if (!deps.saveProviderKey) {
          return { ok: false, error: '当前版本不支持保存密钥' } satisfies ProviderKeySaveResult
        }
        try {
          return deps.saveProviderKey(input.providerId, input.apiKey)
        } catch (error) {
          deps.log('error', 'ask provider key save failed', { error: String(error) })
          return { ok: false, error: '密钥保存失败' } satisfies ProviderKeySaveResult
        }
      }
    ],
    [
      'ask:provider:keys',
      (event) => {
        if (!ensureSender(event)) return {}
        try {
          return deps.providerKeys?.() ?? {}
        } catch (error) {
          deps.log('error', 'ask provider key status failed', { error: String(error) })
          return {}
        }
      }
    ],
    [
      'ask:history',
      (event) => {
        if (!ensureSender(event)) return []
        try {
          return deps.history()
        } catch (error) {
          deps.log('error', 'ask:history read failed', { error: String(error) })
          return []
        }
      }
    ],
    [
      'ask:history:clear',
      (event) => {
        if (!ensureSender(event)) return false
        try {
          deps.clearHistory()
          return true
        } catch (error) {
          deps.log('error', 'ask:history:clear failed', { error: String(error) })
          return false
        }
      }
    ]
  ])
}

/** 注册到 ipcMain；卸载函数用于窗口关闭 / 测试清理 */
export function registerAskIpc(deps: AskIpcDeps): () => void {
  const handlers = createAskIpcHandlers(deps)
  for (const [channel, handler] of handlers) ipcMain.handle(channel, handler)
  return () => {
    for (const [channel] of handlers) ipcMain.removeHandler(channel)
  }
}
