/**
 * 问记忆 · 本地命令（memory-life M1/M2/M3/M5，2026-10-30）
 *
 * 命令是**一条普通消息**：文本以 `/` 开头就先过这里；命中就在本地执行、回一条文本，
 * 不经过模型、不进问答历史、不计生命、不占 QQ 限流（方案 §6 / §6.2）。
 *
 * M1：`/help` / `/backup`。
 * M2：`/log` `/new` `/use` `/del`——节点（git 分支）的看 / 开 / 切 / 删，
 * 外加历史提交只读查看（detached；第一次提问时由组合根自动分叉）。
 * M5（D72）：`/mode ask|chat` 切分支（分支即模式）、`/tool set|ele|add|rm` 改分支的工具白名单。
 *
 * 三条纪律：
 * - 任何切换前先提交当前节点；提交失败就**不切**（宁可报错，不可丢记忆）；
 * - 节点名统一走拼音 slug（`/new 春天` → `spring`），git 分支名只含 `[a-z0-9-]`；
 * - 家谱（权威）最后写：先让 git 就位，再改 active，免得家谱与 HEAD 打架。
 */

import { pinyin } from 'pinyin-pro'

import type { ChainAskResult, ChainAskStats } from '../chain/agent/types'
import {
  ASK_MODE_LABELS,
  askModeKindFromName,
  askModeKindOfBranch,
  modeSummary,
  type AskModeKind,
  type AskModeState
} from '../chain/agent/mode'
import {
  ASK_TOOL_LABELS,
  ASK_TOOL_NAMES,
  ASK_TOOL_SETS,
  defaultToolsForBranchKind,
  normalizeAskTools,
  type AskToolName,
  type AskToolSet
} from '../chain/agent/tool-catalog'
import {
  branchKindOf,
  childBranches,
  ensureLineage,
  findBranch,
  generationOf,
  isTrunkName,
  LEGACY_TRUNK_BRANCH,
  lineageSnapshot,
  readLineage,
  toolsOfBranch,
  TRUNK_BRANCH,
  withActive,
  withBranchAdded,
  withBranchRemoved,
  withBranchTools,
  withLastMode,
  writeLineage,
  type BranchKind,
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
export const KNOWN_COMMANDS = [
  'help',
  'log',
  'new',
  'use',
  'del',
  'backup',
  'cancel',
  'compact',
  'mode',
  'tool'
] as const

/** 当前已经接上的命令 */
export const READY_COMMANDS = [
  'help',
  'log',
  'new',
  'use',
  'del',
  'backup',
  'cancel',
  'compact',
  'mode',
  'tool'
] as const

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
export function commandResult(text: string, mode?: AskModeState): ChainAskResult {
  const stats: ChainAskStats = { hits: 0, evidence: 0, cited: 0, questionChars: 0 }
  return { kind: 'command', text, stats, ...(mode !== undefined ? { mode } : {}) }
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

/** 切活动节点（顺手记下「上次这个模式用的分支」）；返回更新后的家谱（无家谱 / 失败返回 undefined） */
async function syncActive(
  deps: CommandDeps,
  lineage: Lineage | null,
  branch: string,
  kind?: AskModeKind
): Promise<Lineage | undefined> {
  if (lineage === null) return undefined
  const activated = withActive(lineage, branch)
  if (activated === null) return undefined
  const next = kind !== undefined ? withLastMode(activated, kind, branch) : activated
  if (next !== lineage) await writeLineageQuietly(deps, next)
  return next
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
  const activeKind = read.status === 'ok' ? branchKindOf(read.lineage, active) : 'persona'
  return [
    '问记忆 · 记忆仓（M5 节点 + 生命 + 分支即模式）',
    '',
    '可用命令：',
    '  /help            看这一页',
    '  /log             看记忆节点（编号给 /use 用）',
    '  /new <名字>      从当前节点开新分支（assistant 分支 = 开空会话）',
    '  /use <名字|编号|提交>  切节点；切历史提交 = 只读查看',
    '  /del <名字>      删节点（要回 confirm）',
    '  /mode ask|chat   切模式（ask = 纯模型，chat = 带 persona；切分支）',
    '  /tool            看当前分支的工具；set / ele / add / rm',
    '  /compact         压旧段、保留最近几轮（过一次模型）',
    '  /backup          立即提交记忆；配了远端就推送',
    '  /cancel          取消等待中的命名 / 删除',
    '',
    `当前节点：${active}（${activeKind === 'assistant' ? '纯模型' : '聊天'}）`,
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
    const kindText = node === null ? '' : node.kind === 'assistant' ? '  [纯模型]' : node.kind === 'life' ? '  [主干]' : ''
    const current = head.branch === branch ? '  ← 当前' : ''
    lines.push(`[${index + 1}] ${branch}${kindText}${parentText}${current}`)
    const toolCount = lineage === null ? null : toolsOfBranch(lineage, branch).length
    lines.push(
      toolCount === null
        ? `    ${info.sha}  ${info.subject}`
        : `    ${info.sha}  ${info.subject}  · 工具 ${toolCount} 个`
    )
  })
  if (head.detached && head.sha !== null) {
    lines.push('')
    lines.push(`HEAD 停在历史提交 ${head.sha}（只读查看；发第一句话会从这里分叉）`)
  }
  lines.push('', '用法：/use <编号|名字> 切节点；/use <短 sha> 看历史提交。')
  return lines.join('\n')
}

/** 家谱里某分支的模式描述（`/mode`、`/use`、`ask:mode` 共用） */
export function modeStateOf(lineage: Lineage, branch: string): AskModeState {
  const kind = branchKindOf(lineage, branch) ?? 'persona'
  return { kind: askModeKindOfBranch(kind), branch, tools: toolsOfBranch(lineage, branch) }
}

/** 当前模式（命令回执 / 界面模式条用）：家谱读不到就按 default + persona 兜底，不编造别的分支 */
export async function currentModeState(deps: CommandDeps): Promise<AskModeState> {
  const read = await readLineage(deps.lineageFile)
  if (read.status === 'ok') return modeStateOf(read.lineage, read.lineage.active)
  return { kind: 'chat', branch: 'default', tools: defaultToolsForBranchKind('persona') }
}

/** 家谱里没有、但 git 里有（M4 出生线）：补一条主干节点，别让它变成幽灵分支 */
async function adoptTrunkBranch(
  deps: CommandDeps,
  lineage: Lineage,
  at: number,
  trunk: string
): Promise<Lineage | null> {
  if (findBranch(lineage, trunk) !== null) return lineage
  const branches = await deps.repo.listBranches()
  if (!branches.some((entry) => entry.branch === trunk)) return lineage
  return withBranchAdded(lineage, {
    branch: trunk,
    generation: lineage.generations[0]?.id ?? 'gen-1',
    parent: lineage.generations[0]?.branch ?? 'default',
    at,
    kind: 'life'
  })
}

/**
 * 确保出生主干存在（出生提交写在这里）；返回更新后的家谱与主干名。
 * D73：新仓用 `ask`；旧仓只有 `life` 就继续用 `life`（不迁移数据）。
 */
async function ensureTrunkBranch(
  deps: CommandDeps,
  lineage: Lineage,
  at: number
): Promise<{ lineage: Lineage; trunk: string; error?: string }> {
  const branches = await deps.repo.listBranches()
  const has = (name: string): boolean => branches.some((entry) => entry.branch === name)
  const trunk = has(TRUNK_BRANCH)
    ? TRUNK_BRANCH
    : has(LEGACY_TRUNK_BRANCH)
      ? LEGACY_TRUNK_BRANCH
      : TRUNK_BRANCH

  const adopted = await adoptTrunkBranch(deps, lineage, at, trunk)
  if (adopted === null) return { lineage, trunk, error: '主干加不进家谱（细节看日志）。' }
  if (findBranch(adopted, trunk) !== null) return { lineage: adopted, trunk }

  const saved = await saveBefore(deps, 'new')
  if (saved !== null) return { lineage, trunk, error: saved }
  const created = await deps.repo.switchCreateOrphan(trunk)
  if (!created.ok) {
    return { lineage, trunk, error: failureReasonText(created, `开出 ${trunk} 主干`) }
  }
  const added = withBranchAdded(adopted, {
    branch: trunk,
    generation: adopted.generations[0]?.id ?? 'gen-1',
    parent: adopted.generations[0]?.branch ?? 'default',
    at,
    kind: 'life'
  })
  if (added === null) return { lineage, trunk, error: '主干加不进家谱（细节看日志）。' }
  await writeLineageQuietly(deps, added)
  await deps.repo.commit(`memory: ${trunk}`)
  return { lineage: added, trunk }
}

/** 家谱里的主干节点名（新 `ask` / 旧 `life`），没有返回 null */
function trunkNodeOf(lineage: Lineage): string | null {
  const ask = findBranch(lineage, TRUNK_BRANCH)
  if (ask !== null) return ask.branch
  const life = findBranch(lineage, LEGACY_TRUNK_BRANCH)
  return life !== null ? life.branch : null
}

/** assistant 分支的候选名：`assistant` / `assistant-2` / … */
function nextAssistantName(lineage: Lineage, taken: readonly MemoryBranchInfo[]): string {
  const used = new Set<string>([
    ...lineage.branches.map((item) => item.branch),
    ...taken.map((item) => item.branch)
  ])
  if (!used.has('assistant')) return 'assistant'
  for (let index = 2; index < 1_000; index += 1) {
    const name = `assistant-${index}`
    if (!used.has(name)) return name
  }
  return `assistant-${Date.now().toString(36)}`
}

/** 开一条 assistant 空分支（orphan 空树：只有会话，没有别的记忆） */
async function createAssistantBranch(
  deps: CommandDeps,
  lineage: Lineage,
  at: number
): Promise<{ lineage?: Lineage; branch?: string; error?: string }> {
  const status = await deps.repo.status()
  if (!status.ok) return { error: `记忆仓不可用：${repoReasonText(status.reason)}` }
  const ensured = await ensureTrunkBranch(deps, lineage, at)
  if (ensured.error !== undefined) return { error: ensured.error }
  const base = ensured.lineage

  const saved = await saveBefore(deps, 'new')
  if (saved !== null) return { error: saved }
  const name = nextAssistantName(base, await deps.repo.listBranches())
  const created = await deps.repo.switchCreateOrphan(name)
  if (!created.ok) return { error: failureReasonText(created, `开出 ${name}`) }

  const added = withBranchAdded(base, {
    branch: name,
    generation: base.generations[0]?.id ?? 'gen-1',
    parent: trunkNodeOf(base),
    at,
    kind: 'assistant'
  })
  if (added === null) return { error: 'assistant 分支加不进家谱（细节看日志）。' }
  const next = withLastMode(withActive(added, name) ?? added, 'ask', name)
  await writeLineageQuietly(deps, next)
  // orphan 分支还没有提交：先落一个出生提交，否则 `/log` 看不到它（unborn branch）
  await deps.repo.commit(`memory: assistant ${name}`)
  deps.reloadConversations?.()
  return { lineage: next, branch: name }
}

async function createNode(
  deps: CommandDeps,
  slug: string,
  at: number
): Promise<{ text: string; mode?: AskModeState }> {
  const status = await deps.repo.status()
  if (!status.ok) return { text: `记忆仓不可用：${repoReasonText(status.reason)}` }
  const head = await deps.repo.head()
  if (head.detached) {
    return { text: '当前停在历史提交上——先发一句话从这里分叉，或 /use 回一个节点，再 /new。' }
  }
  const current = head.branch ?? status.branch
  const branches = await deps.repo.listBranches()
  if (isTrunkName(slug)) {
    return { text: `${slug} 是出生主干，不能当节点名。` }
  }
  if (branches.some((entry) => entry.branch === slug)) {
    return { text: `节点 ${slug} 已经存在（/log 看看有哪些）。` }
  }

  const read = await ensureLineage(deps.lineageFile, { now: at })
  const lineage = read.lineage
  const currentKind = branchKindOf(lineage, current) ?? 'persona'
  // assistant 分支的 `/new` = 开一条完全空的分支（只有会话，没有上下文）；persona 仍从当前节点分叉
  if (currentKind === 'assistant') {
    const saved = await saveBefore(deps, 'new')
    if (saved !== null) return { text: saved }
    const created = await deps.repo.switchCreateOrphan(slug)
    if (!created.ok) return { text: failureReasonText(created, `开出空会话 ${slug}`) }
    const tools = toolsOfBranch(lineage, current)
    const added = withBranchAdded(lineage, {
      branch: slug,
      generation: generationOf(lineage, current)?.id ?? lineage.generations[0]?.id ?? 'gen-1',
      parent: trunkNodeOf(lineage),
      at,
      kind: 'assistant',
      tools
    })
    if (added === null) return { text: '分支加不进家谱（细节看日志）。' }
    const next = withLastMode(withActive(added, slug) ?? added, 'ask', slug)
    await writeLineageQuietly(deps, next)
    await deps.repo.commit(`memory: assistant ${slug}`)
    deps.reloadConversations?.()
    return {
      text: [
        `===this is ${slug}===`,
        `新会话 ${slug} 已开出（空分支：只有之后的对话，没有之前的记忆）。`,
        '发一句话就开始记；/use 可以回以前的会话。'
      ].join('\n'),
      mode: modeStateOf(next, slug)
    }
  }

  const saved = await saveBefore(deps, 'new')
  if (saved !== null) return { text: saved }

  const created = await deps.repo.switchCreate(slug)
  if (!created.ok) return { text: failureReasonText(created, `开出节点 ${slug}`) }

  const parent = findBranch(lineage, current) !== null ? current : lineage.active
  const generation = generationOf(lineage, parent)?.id ?? lineage.generations[0]?.id ?? 'gen-1'
  const added = withBranchAdded(lineage, {
    branch: slug,
    generation,
    parent,
    at,
    kind: 'persona'
  })
  if (added !== null) await writeLineageQuietly(deps, withActive(added, slug) ?? added)
  deps.reloadConversations?.()

  return {
    text: [
      `===this is ${slug}===`,
      `新节点 ${slug} 已从 ${parent} 开出，当前在这里。`,
      '发一句话就开始记到这条线上；/use 可以切回去。'
    ].join('\n'),
    ...(added !== null ? { mode: modeStateOf(added, slug) } : {})
  }
}

async function useNode(
  deps: CommandDeps,
  target: string,
  at: number
): Promise<{ text: string; mode?: AskModeState }> {
  const status = await deps.repo.status()
  if (!status.ok) return { text: `记忆仓不可用：${repoReasonText(status.reason)}` }
  const head = await deps.repo.head()
  const branches = await deps.repo.listBranches()
  const read = await readLineage(deps.lineageFile)
  const lineage = read.status === 'ok' ? read.lineage : null

  let branchName: string | null = null
  if (/^\d+$/u.test(target)) {
    const index = Number(target) - 1
    branchName = orderBranches(lineage, branches)[index] ?? null
    if (branchName === null) return { text: `没有第 ${target} 个节点（/log 看看有哪些）。` }
  } else if (branches.some((entry) => entry.branch === target)) {
    branchName = target
  }

  if (branchName !== null) {
    const mode = lineage !== null ? modeStateOf(lineage, branchName) : undefined
    if (head.branch === branchName) {
      const synced = await syncActive(deps, lineage, branchName, mode?.kind)
      return {
        text: `===this is ${branchName}===\n已经在 ${branchName}。`,
        ...(synced !== undefined ? { mode: modeStateOf(synced, branchName) } : mode !== undefined ? { mode } : {})
      }
    }
    const saved = await saveBefore(deps, 'use')
    if (saved !== null) return { text: saved }
    const switched = await deps.repo.switchBranch(branchName)
    if (!switched.ok) return { text: failureReasonText(switched, `切到 ${branchName}`) }
    const synced = await syncActive(deps, lineage, branchName, mode?.kind)
    deps.reloadConversations?.()
    return {
      text: `===this is ${branchName}===\n已切到节点 ${branchName}。这一问开始用它的记忆。`,
      ...(synced !== undefined ? { mode: modeStateOf(synced, branchName) } : {})
    }
  }

  const sha = await deps.repo.revParse(target)
  if (sha === null) return { text: `没找到节点或提交「${target}」（/log 看看有哪些）。` }
  const saved = await saveBefore(deps, 'use')
  if (saved !== null) return { text: saved }
  const checkedOut = await deps.repo.checkoutCommit(sha)
  if (!checkedOut.ok) return { text: failureReasonText(checkedOut, `切到提交 ${sha}`) }
  deps.reloadConversations?.()

  const from = head.branch ?? lineage?.active ?? 'default'
  return {
    text: [
      `===this is 历史提交 ${sha}===`,
      `已停在 ${sha}——这里是只读的旧位置，家谱不变。`,
      `发第一句话会从这里分叉成 ${from}-<序号>；只看不聊不会留下分支。`
    ].join('\n')
  }
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
  if (node.kind === 'life') {
    return { ok: false, message: `${node.branch} 是出生主干（出生提交写在这里），不能删。` }
  }
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

/** 命令上下文：`/compact` 要知道压哪个会话（桌面窗口的 conversationId）；模式按家谱现算 */
export interface CommandContext {
  conversationId?: string
}

/* ------------------------------------------------------------------ */
/* `/mode`（D72：分支即模式）与 `/tool`（D72：按分支的工具白名单）        */
/* ------------------------------------------------------------------ */

function describeTools(tools: readonly AskToolName[]): string {
  return tools.length === 0 ? '无工具' : tools.join('、')
}

/** 目标分支：上次用过的那个还在就用它；否则 chat 回 default，ask 需要新建 */
function modeTarget(
  lineage: Lineage,
  branches: readonly MemoryBranchInfo[],
  kind: AskModeKind
): string | null {
  const has = (name: string | undefined): name is string =>
    name !== undefined &&
    branches.some((entry) => entry.branch === name) &&
    findBranch(lineage, name) !== null
  if (kind === 'ask') {
    const last = lineage.last?.ask
    if (has(last) && branchKindOf(lineage, last) === 'assistant') return last
    return null
  }
  const last = lineage.last?.chat
  if (has(last) && branchKindOf(lineage, last) !== 'assistant') return last
  if (has('default')) return 'default'
  return (
    lineage.branches.find(
      (node) => node.kind !== 'assistant' && branches.some((entry) => entry.branch === node.branch)
    )?.branch ?? null
  )
}

async function switchMode(deps: CommandDeps, kind: AskModeKind, at: number): Promise<ChainAskResult> {
  const status = await deps.repo.status()
  if (!status.ok) return commandResult(`记忆仓不可用：${repoReasonText(status.reason)}`)
  const head = await deps.repo.head()
  if (head.detached) {
    return commandResult('当前停在历史提交上——先 /use 回一个节点，再 /mode。')
  }
  const ensured = await ensureLineage(deps.lineageFile, { now: at })
  const lineage = ensured.lineage
  const branches = await deps.repo.listBranches()
  const target = modeTarget(lineage, branches, kind)

  if (target === null) {
    if (kind === 'ask') {
      const created = await createAssistantBranch(deps, lineage, at)
      if (created.error !== undefined || created.branch === undefined || created.lineage === undefined) {
        return commandResult(created.error ?? '开 assistant 分支失败（细节看日志）。')
      }
      const mode = modeStateOf(created.lineage, created.branch)
      return commandResult(
        [
          `===this is ${created.branch}===`,
          `模式：${modeSummary(mode)}（新开的 assistant 分支；只有之后的对话，没有之前的记忆）`,
          '可以直接问了；/mode chat 切回带 persona 的那条线。'
        ].join('\n'),
        mode
      )
    }
    return commandResult('家谱里没有可用的聊天分支（/log 看看有哪些）。')
  }

  const mode = modeStateOf(lineage, target)
  if (target === lineage.active) {
    await syncActive(deps, lineage, target, kind)
    return commandResult(`===this is ${target}===\n已经在 ${modeSummary(mode)}。`, mode)
  }
  const saved = await saveBefore(deps, 'use')
  if (saved !== null) return commandResult(saved)
  const switched = await deps.repo.switchBranch(target)
  if (!switched.ok) return commandResult(failureReasonText(switched, `切到 ${target}`))
  const next = await syncActive(deps, lineage, target, kind)
  deps.reloadConversations?.()
  return commandResult(
    [
      `===this is ${target}===`,
      `模式：${modeSummary(next !== undefined ? modeStateOf(next, target) : mode)}。`,
      kind === 'ask'
        ? '纯模型：不注 persona、默认不带工具；要工具就 /tool add。'
        : '带 persona：人格卡 / 默认人设，工具按这个分支的 /tool 配置。'
    ].join('\n'),
    next !== undefined ? modeStateOf(next, target) : mode
  )
}

/** 工具集 / 元素的编号：`/tool set` 与 `/tool ele` 共用，避免两套序号 */
function toolSetLine(index: number, set: AskToolSet): string {
  return `[${index}] ${set.id} · ${set.label}（${set.tools.length} 个）`
}

function toolSetText(): string {
  return [
    '工具集合（/tool ele <集合> 看元素）：',
    ...ASK_TOOL_SETS.map((set, index) => toolSetLine(index + 1, set)),
    '',
    'conceive_daughter 不在里面：生命 ≤15% 时自动出现。'
  ].join('\n')
}

function toolEleText(args: readonly string[]): string {
  const want = args.join(' ').trim()
  let sets = ASK_TOOL_SETS
  if (want !== '') {
    const set = resolveToolSet(want)
    if (set === null) return `没有集合「${want}」（/tool set 看看有哪些）。`
    sets = [set]
  }
  const lines = ['工具元素：']
  for (const set of sets) {
    const setIndex = ASK_TOOL_SETS.indexOf(set) + 1
    lines.push(`[${setIndex}] ${set.id} · ${set.label}`)
    set.tools.forEach((name, index) => {
      lines.push(`    [${index + 1}] ${name} · ${ASK_TOOL_LABELS[name]}`)
    })
  }
  lines.push('', '用法：/tool add screen:search_info,read_segment;diary；/tool rm 2')
  return lines.join('\n')
}

function resolveToolSet(token: string): AskToolSet | null {
  const raw = token.trim()
  if (raw === '') return null
  if (/^\d+$/u.test(raw)) return ASK_TOOL_SETS[Number(raw) - 1] ?? null
  return (
    ASK_TOOL_SETS.find(
      (set) => set.id === raw.toLowerCase() || set.label === raw
    ) ?? null
  )
}

type ToolSpecParse =
  | { ok: true; tools: AskToolName[] }
  | { ok: false; message: string }

/**
 * `/tool add|rm` 的参数：`screen:search_info,read_segment;diary` 或 `1:1,3;2`。
 * 集合可以写序号 / id / 中文名；元素可以写组内序号 / 名字；只写集合 = 整组。
 */
function parseToolSpec(raw: string): ToolSpecParse {
  const text = raw.trim()
  if (text === '') return { ok: false, message: '要一个工具集合（/tool set 看看有哪些）。' }
  const picked: AskToolName[] = []
  for (const group of text.split(';')) {
    if (group.trim() === '') continue
    const [setToken, eleToken] = group.split(':', 2)
    const set = resolveToolSet(setToken ?? '')
    if (set === null) return { ok: false, message: `没有集合「${(setToken ?? '').trim()}」（/tool set 看看有哪些）。` }
    const elems = (eleToken ?? '').split(',').map((item) => item.trim()).filter((item) => item !== '')
    if (elems.length === 0) {
      picked.push(...set.tools)
      continue
    }
    for (const elem of elems) {
      const name = /^\d+$/u.test(elem) ? set.tools[Number(elem) - 1] : elem
      if (name === undefined || !(set.tools as readonly string[]).includes(name)) {
        return {
          ok: false,
          message: `「${set.id}」里没有「${elem}」（/tool ele ${set.id} 看看）。`
        }
      }
      picked.push(name as AskToolName)
    }
  }
  if (picked.length === 0) return { ok: false, message: '没解析出任何工具（/tool set 看看有哪些）。' }
  return { ok: true, tools: normalizeAskTools(picked) }
}

async function toolSummary(deps: CommandDeps): Promise<string> {
  const read = await readLineage(deps.lineageFile)
  if (read.status !== 'ok') return '家谱读不出来（细节看日志）。'
  const branch = read.lineage.active
  const node = findBranch(read.lineage, branch)
  const tools = toolsOfBranch(read.lineage, branch)
  const kind = askModeKindOfBranch(node?.kind ?? 'persona')
  return [
    `当前分支：${branch}（${ASK_MODE_LABELS[kind]}）· ${tools.length} 个工具`,
    tools.length === 0 ? '  （无工具：纯模型）' : `  ${describeTools(tools)}`,
    '',
    '用法：',
    '  /tool set            列集合（带编号）',
    '  /tool ele [集合]     列元素（带组内编号）',
    '  /tool add screen:search_info,read_segment;diary',
    '  /tool rm diary:memory_profile',
    '改完从下一条消息生效；按分支存，/use 到别的节点不串。'
  ].join('\n')
}

async function toolEdit(
  deps: CommandDeps,
  action: 'add' | 'rm',
  raw: string,
  at: number
): Promise<string> {
  const parsed = parseToolSpec(raw)
  if (!parsed.ok) return parsed.message
  const ensured = await ensureLineage(deps.lineageFile, { now: at })
  const lineage = ensured.lineage
  const branch = lineage.active
  if (findBranch(lineage, branch) === null) return `家谱里没有当前分支 ${branch}（细节看日志）。`
  const current = toolsOfBranch(lineage, branch)
  const wanted = new Set<string>(action === 'add' ? current : current)
  for (const name of parsed.tools) {
    if (action === 'add') wanted.add(name)
    else wanted.delete(name)
  }
  const next = normalizeAskTools([...wanted])
  if (next.length === current.length && next.every((name, index) => name === current[index])) {
    return `工具没变：${describeTools(next)}。`
  }
  const updated = withBranchTools(lineage, branch, next)
  if (updated === null) return '工具写不进家谱（细节看日志）。'
  await writeLineageQuietly(deps, updated)
  return [
    `工具（${next.length} 个）：${describeTools(next)}`,
    `改在分支 ${branch} 上，下一条消息生效。`
  ].join('\n')
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
    const out = await createNode(deps, slug, at)
    return commandResult(out.text, out.mode)
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
      case 'mode': {
        const name = parsed.args.join(' ').trim()
        if (name === '') {
          const mode = await currentModeState(deps)
          return commandResult(
            `当前模式：${modeSummary(mode)}\n用法：/mode ask|chat（切分支；mem / 问记忆 = chat）`
          )
        }
        const kind = askModeKindFromName(name)
        if (kind === null) {
          return commandResult(`不认识「${name}」。用法：/mode ask|chat`)
        }
        return switchMode(deps, kind, at)
      }
      case 'tool': {
        const sub = (parsed.args[0] ?? '').toLowerCase()
        const raw = parsed.args.slice(1).join(' ').trim()
        if (sub === '') return commandResult(await toolSummary(deps))
        if (sub === 'set') return commandResult(toolSetText())
        if (sub === 'ele' || sub === 'element' || sub === 'elements') {
          return commandResult(toolEleText(parsed.args.slice(1)))
        }
        if (sub === 'add') {
          if (raw === '') return commandResult('用法：/tool add screen:search_info,read_segment;diary')
          return commandResult(await toolEdit(deps, 'add', raw, at))
        }
        if (sub === 'rm' || sub === 'remove' || sub === 'del') {
          if (raw === '') return commandResult('用法：/tool rm screen / /tool rm diary:memory_profile')
          return commandResult(await toolEdit(deps, 'rm', raw, at))
        }
        return commandResult(
          `不认识 /tool ${sub}。用法：/tool [set|ele|add|rm]\n（/tool set 看集合，/tool ele 看元素）`
        )
      }
      case 'new': {
        const name = parsed.args.join(' ').trim()
        if (name === '') {
          pending = { kind: 'name' }
          pendingAt = at
          return commandResult(
            '给新节点起个名字（中文会转成拼音，例如「春天」→ chun-tian），60 秒内发给我。\n（assistant 分支上 /new = 开一条只有会话的空分支）'
          )
        }
        return handleNodeName(name, at)
      }
      case 'use': {
        const target = parsed.args.join(' ').trim()
        if (target === '') {
          return commandResult('用法：/use <节点名|编号|提交>（先 /log 看看有哪些）')
        }
        const out = await useNode(deps, target, at)
        return commandResult(out.text, out.mode)
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
