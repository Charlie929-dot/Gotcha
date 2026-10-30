/**
 * 问记忆 · 本地命令（memory-life M1/M2，2026-10-30）
 *
 * 命令是**一条普通消息**：文本以 `/` 开头就先过这里；命中就在本地执行、回一条文本，
 * 不经过模型、不进问答历史、不计生命、不占 QQ 限流（方案 §6 / §6.2）。
 *
 * M1：`/help` / `/backup`。
 * M2：`/log` `/new` `/use` `/del`——节点（git 分支）的看 / 开 / 切 / 删，
 * 外加历史提交只读查看（detached；第一次提问时由组合根自动分叉）。
 *
 * 两条纪律：
 * - 任何切换前先提交当前节点；提交失败就**不切**（宁可报错，不可丢记忆）；
 * - 节点名统一走拼音 slug（`/new 春天` → `spring`），git 分支名只含 `[a-z0-9-]`。
 */

import { pinyin } from 'pinyin-pro'

import type { ChainAskResult, ChainAskStats } from '../chain/agent/types'
import {
  ASK_MODE_LABELS,
  ASK_MODE_PRESETS,
  askModePresetFromName,
  askModePresetOf,
  DEFAULT_ASK_MODE,
  type AskModeConfig
} from '../chain/agent/mode'
import {
  childBranches,
  ensureLineage,
  findBranch,
  generationOf,
  lineageSnapshot,
  readLineage,
  withActive,
  withBranchAdded,
  withBranchRemoved,
  writeLineage,
  type Lineage,
  type LineageRead
} from './lineage'
import type { MemoryBranchInfo, MemoryRepo, MemorySwitchResult } from './memory-repo'

export interface ParsedCommand {
  /** 命令名，已转小写（`/HELP` 与 `/help` 一样） */
  name: string
  args: string[]
}

export interface CommandDeps {
  repo: MemoryRepo
  /** 家谱权威文件（仓外） */
  lineageFile: string
  /** 切节点后清掉会话内存缓存：下次提问从盘上（目标节点）重读 */
  reloadConversations?: () => void
  /**
   * `/compact`（M3）：压当前会话的旧轮。由组合根注入（要调模型 + 写会话 + 提交），
   * 没注入就回「还没接上」。
   */
  compact?: (conversationId: string | undefined) => Promise<CompactOutcome>
  now?: () => number
  /** 名字 → slug；测试可注入固定实现（默认 pinyin-pro） */
  slugify?: (name: string) => string | null
}

/** `/compact` 的结果（M3）：成功只报数字，失败报原因，不把底层异常原文漏到界面 */
export type CompactOutcome =
  | {
      ok: true
      /** 压掉几轮 */
      dropped: number
      /** 保留几轮原文 */
      kept: number
      /** 摘要字符数 */
      summaryChars: number
      beforeChars: number
      afterChars: number
    }
  | {
      ok: false
      reason:
        | 'no-session'
        | 'too-short'
        | 'consent'
        | 'budget'
        | 'blocked'
        | 'no-client'
        | 'failed'
        | 'unavailable'
      detail?: string
    }

/** 方案里定义过的命令（含未实现的）：用于区分「拼错」与「还没做」 */
export const KNOWN_COMMANDS = ['help', 'log', 'new', 'use', 'del', 'backup', 'cancel', 'compact', 'mode'] as const

/** 当前已经接上的命令 */
export const READY_COMMANDS = ['help', 'log', 'new', 'use', 'del', 'backup', 'cancel', 'compact', 'mode'] as const

/** 命名 / 删除确认的等待时限（方案 §6.2：60 秒超时，可 /cancel） */
export const COMMAND_WAIT_TIMEOUT_MS = 60_000

const SLUG_MAX_CHARS = 40
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/u

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const [head, ...args] = trimmed.slice(1).split(/\s+/u)
  const name = (head ?? '').toLowerCase()
  if (name === '') return null
  return { name, args }
}

/**
 * 名字 → git 分支名：英文原样、中文转无声调拼音，只留 `[a-z0-9-]`。
 * 转不出合法 slug（全符号 / 空）返回 null，由调用方如实报错。
 */
export function slugifyNodeName(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return null
  const ascii = /^[\x20-\x7e]+$/u.test(trimmed)
  const raw = ascii ? trimmed : pinyin(trimmed, { toneType: 'none', type: 'array' }).join(' ')
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+/u, '')
    .slice(0, SLUG_MAX_CHARS)
    .replace(/-+$/u, '')
  return slug !== '' && SLUG_RE.test(slug) ? slug : null
}

/** 命令回执：形状与问答复保持一致，界面当一条普通答复显示 */
export function commandResult(text: string, mode?: AskModeConfig): ChainAskResult {
  const stats: ChainAskStats = { hits: 0, evidence: 0, cited: 0, questionChars: 0 }
  return { kind: 'command', text, stats, ...(mode !== undefined ? { mode } : {}) }
}

/** 模式的人话摘要（`/mode` 回执用）：`聊天（屏幕记忆关 · 日记开 · 人格卡开）` */
function modeSummary(mode: AskModeConfig): string {
  const preset = askModePresetOf(mode)
  const label = preset === null ? '组合' : ASK_MODE_LABELS[preset]
  const parts = [
    mode.screen ? '屏幕记忆开' : '屏幕记忆关',
    mode.diary ? '日记开' : '日记关',
    mode.card ? '人格卡开' : '人格卡关'
  ]
  return `${label}（${parts.join(' · ')}）`
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** 本地日（提交主题用，跟用户的日历一致） */
export function memoryDayKey(at: number): string {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function clockOf(at: number): string {
  const date = new Date(at)
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function repoReasonText(reason: 'git-missing' | 'init-failed' | 'broken'): string {
  switch (reason) {
    case 'git-missing':
      return '没找到 git（装一个 git 再重开应用）'
    case 'init-failed':
      return '建仓失败（细节看日志）'
    case 'broken':
      return '仓读不出来（细节看日志）'
  }
}

function failureReasonText(result: MemorySwitchResult, action: string): string {
  switch (result.reason) {
    case 'unavailable':
      return '记忆仓不可用，没有动。'
    case 'dirty':
      return `${action}失败：工作区还有未提交的改动（先 /backup 再试）。`
    case 'not-found':
      return `${action}失败：没找到（/log 看看有哪些）。`
    case 'exists':
      return `${action}失败：分支已经存在。`
    case 'invalid':
      return `${action}失败：名字不合法（用英文 / 数字 / 连字符）。`
    case 'current':
      return `${action}失败：不能对当前分支这么做。`
    default:
      return `${action}失败（细节看日志）。`
  }
}

/** 当前节点先落一次；干净（clean）也算成功。返回错误文本时不切换。 */
async function saveBefore(deps: CommandDeps, why: 'new' | 'use' | 'del'): Promise<string | null> {
  // detached（历史提交只读查看）没有「当前节点」可保存：直接切，脏树由 repo 层拒绝
  const head = await deps.repo.head()
  if (head.detached) return null
  const result = await deps.repo.commit(`memory: save before ${why}`)
  if (result.committed || result.reason === 'clean' || result.reason === 'already') return null
  if (result.reason === 'unavailable') return '记忆仓不可用，没有切换（记忆不会丢）。'
  return `保存当前节点失败${result.detail ? `（${result.detail}）` : ''}，没有切换。`
}

/** 家谱里的节点顺序（`/log` 的编号与 `/use <编号>` 同一口径），家谱外分支接在后面 */
function orderBranches(lineage: Lineage | null, branches: readonly MemoryBranchInfo[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  if (lineage !== null) {
    for (const item of lineage.branches) {
      if (seen.has(item.branch)) continue
      if (!branches.some((entry) => entry.branch === item.branch)) continue
      out.push(item.branch)
      seen.add(item.branch)
    }
  }
  for (const item of branches) {
    if (seen.has(item.branch)) continue
    out.push(item.branch)
    seen.add(item.branch)
  }
  return out
}

async function syncActive(deps: CommandDeps, lineage: Lineage | null, branch: string): Promise<void> {
  if (lineage === null) return
  const next = withActive(lineage, branch)
  if (next === null || next === lineage) return
  await writeLineageQuietly(deps, next)
}

async function writeLineageQuietly(deps: CommandDeps, lineage: Lineage): Promise<void> {
  await writeLineage(deps.lineageFile, lineage)
  await deps.repo.writeFile('lineage.snapshot.json', lineageSnapshot(lineage))
}

async function helpText(deps: CommandDeps): Promise<string> {
  const status = await deps.repo.status()
  let repoLine: string
  if (!status.ok) {
    repoLine = `不可用 · ${repoReasonText(status.reason)}`
  } else {
    const last = await deps.repo.lastCommit()
    repoLine = [
      '可用',
      `分支 ${status.branch}`,
      last === null ? '还没有提交' : `最近提交「${last.subject}」`,
      ...(status.dirty ? ['有未提交改动'] : [])
    ].join(' · ')
  }
  let read: LineageRead
  try {
    read = await readLineage(deps.lineageFile)
  } catch {
    read = { status: 'invalid', detail: 'read' }
  }
  const active = read.status === 'ok' ? read.lineage.active : 'default'
  return [
    '问记忆 · 记忆仓（M3 节点 + 生命）',
    '',
    '可用命令：',
    '  /help            看这一页',
    '  /log             看记忆节点（编号给 /use 用）',
    '  /new <名字>      从当前节点开新分支（中文转拼音）',
    '  /use <名字|编号|提交>  切节点；切历史提交 = 只读查看',
    '  /del <名字>      删节点（要回 confirm）',
    '  /compact         压旧段、保留最近几轮（过一次模型）',
    '  /mode [chat|ask|mem]  切模式（问记忆 / 聊天 / 提问；下一条生效）',
    '  /backup          立即提交记忆；配了远端就推送',
    '  /cancel          取消等待中的命名 / 删除',
    '',
    `当前节点：${active}`,
    `记忆仓：${repoLine}`
  ].join('\n')
}

async function logText(deps: CommandDeps): Promise<string> {
  const status = await deps.repo.status()
  if (!status.ok) return `记忆仓不可用：${repoReasonText(status.reason)}`
  const head = await deps.repo.head()
  const branches = await deps.repo.listBranches()
  if (branches.length === 0) return '记忆仓里还没有节点。'
  const read = await readLineage(deps.lineageFile)
  const lineage = read.status === 'ok' ? read.lineage : null
  const ordered = orderBranches(lineage, branches)

  const lines = ['问记忆 · 记忆节点', '']
  ordered.forEach((branch, index) => {
    const info = branches.find((entry) => entry.branch === branch)
    if (info === undefined) return
    const node = lineage === null ? null : findBranch(lineage, branch)
    const parentText = node?.parent ? `（从 ${node.parent} 分叉）` : ''
    const current = head.branch === branch ? '  ← 当前' : ''
    lines.push(`[${index + 1}] ${branch}${parentText}${current}`)
    lines.push(`    ${info.sha}  ${info.subject}`)
  })
  if (head.detached && head.sha !== null) {
    lines.push('')
    lines.push(`HEAD 停在历史提交 ${head.sha}（只读查看；发第一句话会从这里分叉）`)
  }
  lines.push('', '用法：/use <编号|名字> 切节点；/use <短 sha> 看历史提交。')
  return lines.join('\n')
}

async function createNode(deps: CommandDeps, slug: string, at: number): Promise<string> {
  const status = await deps.repo.status()
  if (!status.ok) return `记忆仓不可用：${repoReasonText(status.reason)}`
  const head = await deps.repo.head()
  if (head.detached) {
    return '当前停在历史提交上——先发一句话从这里分叉，或 /use 回一个节点，再 /new。'
  }
  const current = head.branch ?? status.branch
  const branches = await deps.repo.listBranches()
  if (branches.some((entry) => entry.branch === slug)) {
    return `节点 ${slug} 已经存在（/log 看看有哪些）。`
  }

  const saved = await saveBefore(deps, 'new')
  if (saved !== null) return saved

  const created = await deps.repo.switchCreate(slug)
  if (!created.ok) return failureReasonText(created, `开出节点 ${slug}`)

  const read = await ensureLineage(deps.lineageFile, { now: at })
  const lineage = read.lineage
  const parent = findBranch(lineage, current) !== null ? current : lineage.active
  const generation = generationOf(lineage, parent)?.id ?? lineage.generations[0]?.id ?? 'gen-1'
  const added = withBranchAdded(lineage, { branch: slug, generation, parent, at })
  if (added !== null) await writeLineageQuietly(deps, added)
  deps.reloadConversations?.()

  return [
    `===this is ${slug}===`,
    `新节点 ${slug} 已从 ${parent} 开出，当前在这里。`,
    '发一句话就开始记到这条线上；/use 可以切回去。'
  ].join('\n')
}

async function useNode(deps: CommandDeps, target: string, at: number): Promise<string> {
  const status = await deps.repo.status()
  if (!status.ok) return `记忆仓不可用：${repoReasonText(status.reason)}`
  const head = await deps.repo.head()
  const branches = await deps.repo.listBranches()
  const read = await readLineage(deps.lineageFile)
  const lineage = read.status === 'ok' ? read.lineage : null

  let branchName: string | null = null
  if (/^\d+$/u.test(target)) {
    const index = Number(target) - 1
    branchName = orderBranches(lineage, branches)[index] ?? null
    if (branchName === null) return `没有第 ${target} 个节点（/log 看看有哪些）。`
  } else if (branches.some((entry) => entry.branch === target)) {
    branchName = target
  }

  if (branchName !== null) {
    if (head.branch === branchName) {
      await syncActive(deps, lineage, branchName)
      return `===this is ${branchName}===\n已经在 ${branchName}。`
    }
    const saved = await saveBefore(deps, 'use')
    if (saved !== null) return saved
    const switched = await deps.repo.switchBranch(branchName)
    if (!switched.ok) return failureReasonText(switched, `切到 ${branchName}`)
    await syncActive(deps, lineage, branchName)
    deps.reloadConversations?.()
    return `===this is ${branchName}===\n已切到节点 ${branchName}。这一问开始用它的记忆。`
  }

  const sha = await deps.repo.revParse(target)
  if (sha === null) return `没找到节点或提交「${target}」（/log 看看有哪些）。`
  const saved = await saveBefore(deps, 'use')
  if (saved !== null) return saved
  const checkedOut = await deps.repo.checkoutCommit(sha)
  if (!checkedOut.ok) return failureReasonText(checkedOut, `切到提交 ${sha}`)
  deps.reloadConversations?.()

  const from = head.branch ?? lineage?.active ?? 'default'
  return [
    `===this is 历史提交 ${sha}===`,
    `已停在 ${sha}——这里是只读的旧位置，家谱不变。`,
    `发第一句话会从这里分叉成 ${from}-<序号>；只看不聊不会留下分支。`
  ].join('\n')
}

interface DeletableOk {
  ok: true
  branch: string
}
interface DeletableNo {
  ok: false
  message: string
}

async function checkDeletable(deps: CommandDeps, slug: string): Promise<DeletableOk | DeletableNo> {
  const status = await deps.repo.status()
  if (!status.ok) return { ok: false, message: `记忆仓不可用：${repoReasonText(status.reason)}` }
  const head = await deps.repo.head()
  const read = await readLineage(deps.lineageFile)
  if (read.status !== 'ok') return { ok: false, message: '家谱读不出来（细节看日志），先不删。' }
  const lineage = read.lineage
  const node = findBranch(lineage, slug)
  if (node === null) {
    const branches = await deps.repo.listBranches()
    if (!branches.some((entry) => entry.branch === slug)) {
      return { ok: false, message: `没有节点 ${slug}。` }
    }
    if (head.branch === slug) return { ok: false, message: '不能删当前节点。' }
    return { ok: true, branch: slug }
  }
  if (slug === head.branch) return { ok: false, message: '不能删当前节点。' }
  if (lineage.generations.some((item) => item.branch === slug)) {
    return { ok: false, message: `${slug} 是一代鱼的主分支，不能删。` }
  }
  const children = childBranches(lineage, slug)
  if (children.length > 0) {
    return {
      ok: false,
      message: `${slug} 下面还有 ${children.map((item) => item.branch).join('、')}，先删它们。`
    }
  }
  return { ok: true, branch: slug }
}

async function deleteNode(deps: CommandDeps, branch: string): Promise<string> {
  const saved = await saveBefore(deps, 'del')
  if (saved !== null) return saved
  const removed = await deps.repo.deleteBranch(branch)
  if (!removed.ok) return failureReasonText(removed, `删除 ${branch}`)

  const read = await readLineage(deps.lineageFile)
  if (read.status === 'ok') {
    const next = withBranchRemoved(read.lineage, branch)
    if (next !== null) await writeLineageQuietly(deps, next)
  }
  return `已删除节点 ${branch}（提交还在仓里，/use 短 sha 仍能找回）。`
}

type Pending = { kind: 'name' } | { kind: 'delete'; branch: string } | null

/** 命令上下文：`/compact` 要知道压哪个会话（桌面窗口的 conversationId）；`/mode` 要知道当前模式 */
export interface CommandContext {
  conversationId?: string
  /** 渲染层这次提问带的模式（D62）；`/mode` 无参数时据此报「当前」 */
  mode?: AskModeConfig
}

/** `/mode`：不带参数报当前；带名字切预设，回执里带目标模式由界面落地 */
function modeText(context: CommandContext | undefined, args: readonly string[]): ChainAskResult {
  const current = context?.mode ?? DEFAULT_ASK_MODE
  const currentText = modeSummary(current)
  const name = args.join(' ').trim()
  if (name === '') {
    return commandResult(
      `当前模式：${currentText}\n用法：/mode [chat|ask|mem]（切了从下一条消息生效）`
    )
  }
  const preset = askModePresetFromName(name)
  if (preset === null) {
    return commandResult(`不认识「${name}」。用法：/mode [chat|ask|mem]\n当前：${currentText}`)
  }
  const next = ASK_MODE_PRESETS[preset]
  const cardHint = preset === 'chat' ? '\n（聊天模式用人格卡；还没启用卡时先用默认人设）' : ''
  return commandResult(`模式：${modeSummary(next)}（下一条生效）${cardHint}`, next)
}

/**
 * 返回处理函数：不是命令 → null（调用方继续走模型）；
 * 是命令 → 一条 `command` 回执（永不出网，除了 /backup 的 git push 与 /compact 的摘要）。
 *
 * 等待状态（命名 / 删除确认）也在这里：等待中的**非命令文本**会被当名字或 confirm，
 * 其它输入视为放弃等待、照常走模型。
 */
export function createCommandHandler(
  deps: CommandDeps
): (text: string, context?: CommandContext) => Promise<ChainAskResult | null> {
  const now = deps.now ?? Date.now
  const slugify = deps.slugify ?? slugifyNodeName
  let pending: Pending = null
  let pendingAt = 0

  const expire = (at: number): void => {
    if (pending !== null && at - pendingAt > COMMAND_WAIT_TIMEOUT_MS) pending = null
  }

  const handleNodeName = async (raw: string, at: number): Promise<ChainAskResult> => {
    const slug = slugify(raw)
    if (slug === null) {
      return commandResult(`「${raw}」转不出可用的节点名（用英文 / 数字 / 短一些的中文名）。`)
    }
    return commandResult(await createNode(deps, slug, at))
  }

  const handleCompact = async (context: CommandContext | undefined): Promise<ChainAskResult> => {
    if (deps.compact === undefined) return commandResult('/compact 还没接上。')
    const outcome = await deps.compact(context?.conversationId)
    if (outcome.ok) {
      return commandResult(
        [
          '===compact===',
          `压掉 ${outcome.dropped} 轮（保留最近 ${outcome.kept} 轮原文），摘要 ${outcome.summaryChars} 字。`,
          `会话从 ${outcome.beforeChars} 字降到 ${outcome.afterChars} 字；下一问按新上下文重算生命。`
        ].join('\n')
      )
    }
    switch (outcome.reason) {
      case 'no-session':
        return commandResult('/compact 得在桌面窗口里用（这里不知道压哪个会话）。')
      case 'too-short':
        return commandResult(outcome.detail ?? '轮数还不够，没什么可压的。')
      case 'consent':
        return commandResult('还没确认出云，先不压缩（摘要要过一次模型）。')
      case 'budget':
        return commandResult('今天的模型额度用完了，压不了。')
      case 'blocked':
        return commandResult('这段会话里有敏感内容，不能送去摘要。')
      case 'no-client':
        return commandResult('没有可用的模型客户端（缺 key / 配置不对）。')
      case 'unavailable':
        return commandResult('记忆仓不可用，没有压缩。')
      default:
        return commandResult('摘要失败（网络 / 模型），细节看日志。')
    }
  }

  return async (text, context) => {
    const at = now()
    expire(at)
    const trimmed = text.trim()

    if (pending !== null && !trimmed.startsWith('/')) {
      if (pending.kind === 'name') {
        pending = null
        return handleNodeName(trimmed, at)
      }
      const branch = pending.branch
      if (trimmed.toLowerCase() === 'confirm') {
        pending = null
        return commandResult(await deleteNode(deps, branch))
      }
      pending = null
      return null
    }

    const parsed = parseCommand(text)
    if (parsed === null) return null
    if (!(KNOWN_COMMANDS as readonly string[]).includes(parsed.name)) {
      return commandResult(`未知命令：/${parsed.name}\n发 /help 看看能做什么。`)
    }
    switch (parsed.name) {
      case 'help':
        return commandResult(await helpText(deps))
      case 'log':
        return commandResult(await logText(deps))
      case 'backup':
        return commandResult(await backupText(deps, at))
      case 'cancel': {
        if (pending === null) return commandResult('没有等待中的操作。')
        pending = null
        return commandResult('已取消。')
      }
      case 'compact':
        return handleCompact(context)
      case 'mode':
        return modeText(context, parsed.args)
      case 'new': {
        const name = parsed.args.join(' ').trim()
        if (name === '') {
          pending = { kind: 'name' }
          pendingAt = at
          return commandResult(
            '给新节点起个名字（中文会转成拼音，例如「春天」→ chun-tian），60 秒内发给我。'
          )
        }
        return handleNodeName(name, at)
      }
      case 'use': {
        const target = parsed.args.join(' ').trim()
        if (target === '') {
          return commandResult('用法：/use <节点名|编号|提交>（先 /log 看看有哪些）')
        }
        return commandResult(await useNode(deps, target, at))
      }
      case 'del': {
        const raw = parsed.args.join(' ').trim()
        if (raw === '') return commandResult('用法：/del <节点名>（先 /log 看看有哪些）')
        const slug = slugify(raw)
        if (slug === null) return commandResult(`「${raw}」不是有效的节点名。`)
        const check = await checkDeletable(deps, slug)
        if (!check.ok) return commandResult(check.message)
        pending = { kind: 'delete', branch: check.branch }
        pendingAt = at
        return commandResult(
          `确定删除节点 ${check.branch}？回复 confirm 确认（60 秒内）；发别的话就不删。`
        )
      }
      default:
        return commandResult(`/${parsed.name} 还没接上。`)
    }
  }
}

async function backupText(deps: CommandDeps, at: number): Promise<string> {
  const day = memoryDayKey(at)
  const result = await deps.repo.commit(`memory: backup ${day} ${clockOf(at)}`)
  if (!result.committed) {
    switch (result.reason) {
      case 'clean':
        return '没有新内容要提交。'
      case 'unavailable':
        return '记忆仓不可用：没找到 git 或仓读不出来。'
      default:
        return '提交失败（细节看日志）。'
    }
  }
  const head = result.hash !== undefined ? `已提交 ${result.hash}。` : '已提交。'
  const pushed = await deps.repo.push()
  if (pushed.ok) return `${head}推送成功。`
  switch (pushed.reason) {
    case 'no-remote':
      return `${head}没配远端，只提交在本地。`
    case 'unavailable':
      return `${head}记忆仓不可用，没有推送。`
    default:
      return `${head}推送失败（网络 / 凭据），下次 /backup 再试。`
  }
}
