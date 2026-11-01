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
 * - `ask:memory:get/save`（vibe/free）：日记目录 + 人设；保存即同步。
 * - `ask:memory:list/delete/restore`（vibe/free）：设置抽屉里浏览 / 删除 / 撤销单条记忆。
 *   删除与同步一样要开写连接，**回答进行中一律拒绝**（否则会在只读连接还在读的时候关库）。
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import type { ChainAskResult, ChainAskResumeDecision, ChainAskTurnContext } from '../chain/agent/types'
import type { AskModeState } from '../chain/agent/mode'
import type { SegmentEvidence } from '../chain/agent/evidence'
import type { AskHistoryEntry } from './ask-history'
import type { GraphSettingsSaveResult, GraphSettingsView } from './graph-settings'
import type { MemorySettingsSaveResult, MemorySettingsView } from './memory-settings'
import type { MemoryRepoSettingsView } from './memory-repo-settings'
import type {
  MemoryDeleteView,
  MemoryListView,
  MemoryRestoreView
} from './memory-admin'
import type { ProviderKeySaveResult, ProviderModelsInput } from './graph-ipc'
import type { QqSettingsSaveResult, QqSettingsView } from './qq/qq-settings'
import type { NapcatView } from './qq/napcat'
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

/** 用户随问题上传的附件（渲染层已把图片压成 data URL、文本文件读成文本） */
export interface AskAttachmentInput {
  kind: 'image' | 'file'
  /** 文件名（展示用；图片可能是「截图」） */
  name?: string
  /** kind=image：图片 data URL（只收 png/jpeg/webp/gif） */
  dataUrl?: string
  /** kind=file：文本内容（渲染层已截断；主进程再校验上限） */
  text?: string
}

/** 附件在上下文里的形态：主进程落盘后补 `path`（历史回看用） */
export interface AskQueryAttachment extends AskAttachmentInput {
  path?: string
}

/** 一次提问的上下文：会话 id + 该会话之前的几轮 + 取消信号（+ 选区截图 / 上传附件） */
export interface AskQueryContext {
  conversationId: string
  history: readonly ChainAskTurnContext[]
  signal: AbortSignal
  /** 选区问答：随这条对话留存的截图（主进程校验后给绝对路径） */
  imagePath?: string
  /** 用户上传的附件（图片 / 文本文件；主进程在提问前落盘图片并回填 path） */
  attachments?: AskQueryAttachment[]
}

/** 附件上限：与渲染层一致（渲染层先挡一道，这里再挡一道） */
export const ASK_ATTACH_IMAGE_MAX = 4
export const ASK_ATTACH_FILE_MAX = 4
const ASK_ATTACH_NAME_MAX_CHARS = 120
const ASK_ATTACH_IMAGE_DATA_URL_MAX_CHARS = 6 * 1024 * 1024
const ASK_ATTACH_FILE_TEXT_MAX_CHARS = 200_000
const ASK_ATTACH_IMAGE_DATA_URL_RE = /^data:image\/(png|jpeg|webp|gif);base64,/i

function parseAttachments(raw: unknown): AskQueryAttachment[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length === 0) return []
  if (raw.length > ASK_ATTACH_IMAGE_MAX + ASK_ATTACH_FILE_MAX) return null
  const out: AskQueryAttachment[] = []
  let images = 0
  let files = 0
  for (const item of raw) {
    if (!isPlainObject(item)) return null
    const kind = item.kind
    const name =
      typeof item.name === 'string' ? item.name.trim().slice(0, ASK_ATTACH_NAME_MAX_CHARS) : undefined
    if (kind === 'image') {
      if (images >= ASK_ATTACH_IMAGE_MAX) return null
      const dataUrl = item.dataUrl
      if (typeof dataUrl !== 'string' || dataUrl.length > ASK_ATTACH_IMAGE_DATA_URL_MAX_CHARS) return null
      if (!ASK_ATTACH_IMAGE_DATA_URL_RE.test(dataUrl)) return null
      out.push({ kind: 'image', ...(name ? { name } : {}), dataUrl })
      images += 1
      continue
    }
    if (kind === 'file') {
      if (files >= ASK_ATTACH_FILE_MAX) return null
      const text = item.text
      if (typeof text !== 'string' || text.length > ASK_ATTACH_FILE_TEXT_MAX_CHARS) return null
      out.push({ kind: 'file', ...(name ? { name } : {}), text })
      files += 1
      continue
    }
    return null
  }
  return out
}

/** 附件 → 历史元信息（图片带 path 才能回看；文本只记字数，不落盘） */
function historyAttachments(
  attachments: readonly AskQueryAttachment[] | undefined
): { kind: 'image' | 'file'; name?: string; path?: string; chars?: number }[] {
  const out: { kind: 'image' | 'file'; name?: string; path?: string; chars?: number }[] = []
  for (const item of attachments ?? []) {
    if (item.kind === 'image') {
      out.push({ kind: 'image', ...(item.name ? { name: item.name } : {}), ...(item.path ? { path: item.path } : {}) })
    } else {
      out.push({ kind: 'file', ...(item.name ? { name: item.name } : {}), chars: (item.text ?? '').length })
    }
  }
  return out
}

export interface AskIpcDeps {
  getWindow: () => BrowserWindow | null
  ask: (question: string, context: AskQueryContext) => Promise<ChainAskResult>
  /**
   * 本地命令（memory-life M1/M2/M3 / D70 / D72）：`/help`、`/log`、`/backup`、`/compact`、
   * `/mode`、`/tool`… 返回非 null = 命中命令（回执直接给界面，不调模型、不进历史）；
   * null = 不是命令，照常提问。`context.conversationId` 给 `/compact` 用（压哪个会话）。
   */
  command?: (
    text: string,
    context?: { conversationId?: string }
  ) => Promise<ChainAskResult | null>
  /** 当前模式（D72 分支即模式）：界面启动 / 每条结果后刷新模式条 */
  mode?: () => Promise<AskModeState | null>
  segment: (segmentId: number) => SegmentEvidence | null
  consent: () => AskConsentView
  setConsent: (consented: boolean) => AskConsentView
  /** 成功走完一次提问就落一条历史（失败只记日志，不能影响回答）；`imagePath` 只有选区问答才有 */
  record: (
    question: string,
    result: ChainAskResult,
    conversationId: string,
    imagePath?: string,
    attachments?: { kind: 'image' | 'file'; name?: string; path?: string; chars?: number }[]
  ) => void | Promise<void>
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
  /** 同一会话之前的几轮（主进程按 conversationId + 当前分支筛；缺省按空对话处理） */
  conversationHistory?: (
    conversationId: string
  ) => readonly ChainAskTurnContext[] | Promise<readonly ChainAskTurnContext[]>
  /** 全部历史（最新在前） */
  history: () => AskHistoryEntry[]
  /** 清空历史（接记忆仓时会先提交一次再删会话文件，允许返回 Promise） */
  clearHistory: () => void | Promise<void>
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
  /**
   * 人格卡（D62）：保存一张卡（导入 / 覆盖）→ 更新后的视图；文本由渲染层读好，
   * 主进程再按上限校验（不静默截断）。读取单张卡给预览用。
   */
  savePersonaCard?: (name: string, text: string) => { ok: boolean; error?: string; view?: MemorySettingsView }
  readPersonaCard?: (name: string) => string | null
  /** 在文件资源管理器里打开卡片目录（目录不存在时先建） */
  openPersonaCardDir?: () => boolean
  /**
   * 设置抽屉「记忆条目」：浏览（关键词 / 日期前缀 / 类别，分页）、删除单条（进回收站）、撤销。
   * 删除与撤销都走写连接，回答进行中拒绝（handler 里按在途提问判定）。
   */
  memoryList?: (query: unknown) => MemoryListView
  memoryDelete?: (input: unknown) => MemoryDeleteView
  memoryRestore?: (input: unknown) => MemoryRestoreView
  /**
   * QQ 通道（D63）：读设置视图 / 保存并热生效。
   * 保存会起停本机 WS 端口（默认关），失败原因随 `view.lastError` 回界面，不抛异常。
   */
  qqSettings?: () => QqSettingsView | { error: string }
  saveQqSettings?: (patch: unknown) => QqSettingsSaveResult | Promise<QqSettingsSaveResult>
  /**
   * NapCat 托管（D66）：状态（含二维码 data URL）、启动 / 停止、下载安装、选目录。
   * 安装是长任务：这里只负责踢一脚，进度由 `qqNapcatStatus` 轮询回界面。
   */
  qqNapcatStatus?: () => NapcatView
  qqNapcatStart?: () => Promise<{ ok: boolean; error?: string }>
  qqNapcatStop?: () => Promise<void>
  qqNapcatInstall?: () => Promise<{ ok: boolean; error?: string }>
  qqNapcatChooseDir?: () => Promise<{ ok: boolean; error?: string; view?: NapcatView }>
  /**
   * 记忆仓（D90）：远端绑定 / 推送状态 / 定时。
   * 地址写进仓的 git 配置（不落设置表）；间隔进设置表。
   */
  memoryRepo?: () => Promise<MemoryRepoSettingsView | { error: string }>
  saveMemoryRepo?: (
    patch: unknown
  ) => Promise<{ ok: boolean; error?: string; view?: MemoryRepoSettingsView }>
  pushMemoryRepo?: () => Promise<{
    ok: boolean
    error?: string
    view?: MemoryRepoSettingsView
  }>
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
    {
      question: string
      conversationId: string
      imagePath?: string
      attachments?: AskQueryAttachment[]
    }
  >()

  /**
   * 一次问答收口：暂停（continue-ask）暂时不落历史——用户还没决定、答案还没出来；
   * 其余结果照常落一条。历史写失败不能让提问失败，记一条 warn 就行。
   */
  const settle = async (
    question: string,
    conversationId: string,
    result: ChainAskResult,
    imagePath?: string,
    attachments?: readonly AskQueryAttachment[]
  ): Promise<ChainAskResult> => {
    const recorded = historyAttachments(attachments)
    if (result.kind === 'continue-ask') {
      if (result.resumeId) {
        while (pendingResume.size >= PENDING_RESUME_MAX) {
          const oldest = pendingResume.keys().next().value
          if (oldest === undefined) break
          pendingResume.delete(oldest)
        }
        pendingResume.set(result.resumeId, {
          question,
          conversationId,
          ...(imagePath ? { imagePath } : {}),
          ...(recorded.length > 0 ? { attachments: [...attachments!] } : {})
        })
      }
      return result
    }
    try {
      // 不带图 / 附件时保持老调用形状
      if (imagePath || recorded.length > 0) {
        await deps.record(question, result, conversationId, imagePath, recorded)
      } else {
        await deps.record(question, result, conversationId)
      }
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
        // 会话 id：老调用方（纯字符串）没有就现造一个，保证每次提问都有归属。
        // 命令（尤其 `/compact`）也要用它，所以放在命令之前解析。
        const conversationId =
          typeof payload.conversationId === 'string' && CONVERSATION_ID_RE.test(payload.conversationId)
            ? payload.conversationId
            : `c${Date.now().toString(36)}`
        // 模式（D72）：模式 = 当前分支的 kind，主进程按家谱现算，渲染层不再传。
        // 本地命令先过（方案 §6）：命中就在本地执行、回一条文本，不调模型、不写会话 / 历史。
        // 放在问题长度校验之前：命令的参数长度不该受「提问 500 字」限制。
        if (deps.command) {
          try {
            const handled = await deps.command(asked, { conversationId })
            if (handled !== null) return handled
          } catch (error) {
            deps.log('warn', 'ask command failed', { error: String(error) })
            return failure('命令执行失败，细节看日志')
          }
        }
        if (asked.length > ASK_QUESTION_MAX_CHARS) {
          return failure(`问题太长（上限 ${ASK_QUESTION_MAX_CHARS} 字）`)
        }

        // 选区问答：截图路径只做形状校验，真正的「在不在 ask-shots 里」由主进程 deps 校验
        const rawImage = payload.imagePath
        const imagePath =
          typeof rawImage === 'string' && rawImage.length > 0 && rawImage.length <= 512
            ? rawImage
            : undefined
        const attachments = parseAttachments(payload.attachments)
        if (attachments === null) return failure('附件不合法（只收图片和文本文件，条数 / 大小有上限）')

        // 在途状态先挂上：读历史（现在要读家谱、异步）也算这一次提问已经开始，
        // 期间不允许开写连接（删除 / 撤销 / 清空）。
        active?.abort()
        const controller = new AbortController()
        active = controller

        let history: readonly ChainAskTurnContext[] = []
        try {
          history = (await deps.conversationHistory?.(conversationId)) ?? []
        } catch (error) {
          deps.log('warn', 'ask history context failed', { error: String(error) })
        }

        try {
          const result = await deps.ask(asked, {
            conversationId,
            history,
            signal: controller.signal,
            ...(imagePath ? { imagePath } : {}),
            ...(attachments.length > 0 ? { attachments } : {})
          })
          return await settle(asked, conversationId, result, imagePath, attachments)
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

        active?.abort()
        const controller = new AbortController()
        active = controller

        let history: readonly ChainAskTurnContext[] = []
        try {
          history = (await deps.conversationHistory?.(pending.conversationId)) ?? []
        } catch (error) {
          deps.log('warn', 'ask history context failed', { error: String(error) })
        }

        try {
          const result = await deps.resume(resumeId, decision, {
            conversationId: pending.conversationId,
            history,
            signal: controller.signal,
            ...(pending.imagePath ? { imagePath: pending.imagePath } : {}),
            ...(pending.attachments && pending.attachments.length > 0
              ? { attachments: pending.attachments }
              : {})
          })
          return await settle(
            pending.question,
            pending.conversationId,
            result,
            pending.imagePath,
            pending.attachments
          )
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
      'ask:mode:get',
      async (event) => {
        if (!ensureSender(event)) return null
        if (!deps.mode) return null
        try {
          return await deps.mode()
        } catch (error) {
          deps.log('warn', 'ask mode read failed', { error: String(error) })
          return null
        }
      }
    ],
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
      'ask:memory:list',
      (event, query) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' } satisfies MemoryListView
        if (!deps.memoryList) {
          return { ok: false, error: '当前版本不支持浏览记忆条目' } satisfies MemoryListView
        }
        try {
          return deps.memoryList(query)
        } catch (error) {
          deps.log('error', 'ask memory list failed', { error: String(error) })
          return { ok: false, error: '读取记忆条目失败' } satisfies MemoryListView
        }
      }
    ],
    [
      'ask:memory:delete',
      (event, input) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' } satisfies MemoryDeleteView
        if (!deps.memoryDelete) {
          return { ok: false, error: '当前版本不支持删除记忆条目' } satisfies MemoryDeleteView
        }
        // 删除要开写连接（会关掉只读连接）：在途提问正读着库，等它结束再删
        if (active !== null) {
          return { ok: false, error: '等这次回答结束再删（删除会短暂占用数据库）' } satisfies MemoryDeleteView
        }
        try {
          return deps.memoryDelete(input)
        } catch (error) {
          deps.log('error', 'ask memory delete failed', { error: String(error) })
          return { ok: false, error: '删除失败' } satisfies MemoryDeleteView
        }
      }
    ],
    [
      'ask:memory:restore',
      (event, input) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' } satisfies MemoryRestoreView
        if (!deps.memoryRestore) {
          return { ok: false, error: '当前版本不支持撤销删除' } satisfies MemoryRestoreView
        }
        if (active !== null) {
          return { ok: false, error: '等这次回答结束再撤销（会短暂占用数据库）' } satisfies MemoryRestoreView
        }
        try {
          return deps.memoryRestore(input)
        } catch (error) {
          deps.log('error', 'ask memory restore failed', { error: String(error) })
          return { ok: false, error: '撤销失败' } satisfies MemoryRestoreView
        }
      }
    ],
    [
      'ask:qq:get',
      (event) => {
        if (!ensureSender(event)) return { error: 'forbidden' }
        try {
          return deps.qqSettings?.() ?? { error: 'unsupported' }
        } catch (error) {
          deps.log('error', 'ask qq settings read failed', { error: String(error) })
          return { error: 'qq-settings-read-failed' }
        }
      }
    ],
    [
      'ask:qq:save',
      async (event, patch) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' } satisfies QqSettingsSaveResult
        if (!deps.saveQqSettings) {
          return { ok: false, error: '当前版本不支持 QQ 通道' } satisfies QqSettingsSaveResult
        }
        try {
          return await deps.saveQqSettings(patch)
        } catch (error) {
          deps.log('error', 'ask qq settings save failed', { error: String(error) })
          return { ok: false, error: '保存失败' } satisfies QqSettingsSaveResult
        }
      }
    ],
    [
      'ask:qq:napcat:get',
      (event) => {
        if (!ensureSender(event)) return { error: 'forbidden' }
        try {
          return deps.qqNapcatStatus?.() ?? { error: 'unsupported' }
        } catch (error) {
          deps.log('error', 'ask qq napcat status failed', { error: String(error) })
          return { error: 'napcat-status-failed' }
        }
      }
    ],
    [
      'ask:qq:napcat:start',
      async (event) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' }
        if (!deps.qqNapcatStart) return { ok: false, error: '当前版本不支持托管 NapCat' }
        try {
          return await deps.qqNapcatStart()
        } catch (error) {
          deps.log('error', 'ask qq napcat start failed', { error: String(error) })
          return { ok: false, error: '启动 NapCat 失败' }
        }
      }
    ],
    [
      'ask:qq:napcat:stop',
      async (event) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' }
        if (!deps.qqNapcatStop) return { ok: false, error: '当前版本不支持托管 NapCat' }
        try {
          await deps.qqNapcatStop()
          return { ok: true }
        } catch (error) {
          deps.log('error', 'ask qq napcat stop failed', { error: String(error) })
          return { ok: false, error: '停止 NapCat 失败' }
        }
      }
    ],
    [
      'ask:qq:napcat:install',
      async (event) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' }
        if (!deps.qqNapcatInstall) return { ok: false, error: '当前版本不支持下载安装 NapCat' }
        try {
          return await deps.qqNapcatInstall()
        } catch (error) {
          deps.log('error', 'ask qq napcat install failed', { error: String(error) })
          return { ok: false, error: '安装 NapCat 失败' }
        }
      }
    ],
    [
      'ask:qq:napcat:dir',
      async (event) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' }
        if (!deps.qqNapcatChooseDir) return { ok: false, error: '当前版本不支持选择目录' }
        try {
          return await deps.qqNapcatChooseDir()
        } catch (error) {
          deps.log('error', 'ask qq napcat choose dir failed', { error: String(error) })
          return { ok: false, error: '选择目录失败' }
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
      'ask:memory:card:save',
      (event, input) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' }
        if (
          !isPlainObject(input) ||
          typeof input.name !== 'string' ||
          typeof input.text !== 'string'
        ) {
          return { ok: false, error: '参数不合法' }
        }
        if (!deps.savePersonaCard) return { ok: false, error: '当前版本不支持人格卡' }
        try {
          return deps.savePersonaCard(input.name, input.text)
        } catch (error) {
          deps.log('error', 'ask persona card save failed', { error: String(error) })
          return { ok: false, error: '保存人格卡失败' }
        }
      }
    ],
    [
      'ask:memory:card:get',
      (event, name) => {
        if (!ensureSender(event)) return null
        if (typeof name !== 'string' || name.length === 0 || name.length > 120) return null
        if (!deps.readPersonaCard) return null
        try {
          return deps.readPersonaCard(name)
        } catch (error) {
          deps.log('warn', 'ask persona card read failed', { error: String(error) })
          return null
        }
      }
    ],
    [
      'ask:memory:card:open',
      (event) => {
        if (!ensureSender(event)) return false
        if (!deps.openPersonaCardDir) return false
        try {
          return deps.openPersonaCardDir()
        } catch (error) {
          deps.log('warn', 'ask persona card dir open failed', { error: String(error) })
          return false
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
      async (event) => {
        if (!ensureSender(event)) return false
        try {
          await deps.clearHistory()
          return true
        } catch (error) {
          deps.log('error', 'ask:history:clear failed', { error: String(error) })
          return false
        }
      }
    ],
    [
      'ask:memoryrepo:get',
      async (event) => {
        if (!ensureSender(event)) return { error: 'forbidden' }
        if (!deps.memoryRepo) return { error: 'unsupported' }
        try {
          return await deps.memoryRepo()
        } catch (error) {
          deps.log('error', 'ask memory repo read failed', { error: String(error) })
          return { error: 'memory-repo-read-failed' }
        }
      }
    ],
    [
      'ask:memoryrepo:save',
      async (event, patch) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' }
        if (!deps.saveMemoryRepo) return { ok: false, error: '当前版本不支持保存记忆仓设置' }
        try {
          return await deps.saveMemoryRepo(patch)
        } catch (error) {
          deps.log('error', 'ask memory repo save failed', { error: String(error) })
          return { ok: false, error: '保存失败' }
        }
      }
    ],
    [
      'ask:memoryrepo:push',
      async (event) => {
        if (!ensureSender(event)) return { ok: false, error: 'forbidden' }
        if (!deps.pushMemoryRepo) return { ok: false, error: '当前版本不支持手动推送' }
        try {
          return await deps.pushMemoryRepo()
        } catch (error) {
          deps.log('error', 'ask memory repo push failed', { error: String(error) })
          return { ok: false, error: '推送失败，细节看日志' }
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
