/**
 * 问记忆 · 本地命令（memory-life M1/M2/M3/M5，2026-10-30）
 *
 * 命令是**一条普通消息**：文本以 `/` 开头就先过这里；命中就在本地执行、回一条文本，
 * 不经过模型、不进问答历史、不计生命、不占 QQ 限流（方案 §6 / §6.2）。
 *
 * M1：`/help` / `/backup`。
 * M2：`/log` `/new` `/use` `/del`——节点（git 分支）的看 / 开 / 切 / 删，
 * 外加历史提交只读查看（detached；第一次提问时由组合根自动分叉）。
 * D75：`/log` 是家谱树（`[0]` / `[0-1]` 父子编号，按代排序），`/log <编号|名字>` 看该节点的
 * 记忆历史；切换前保存 / `/backup` 的提交主题默认 `memory: 2026-10-30 18:05`（回执可起名）。
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
  TRUNK_BRANCH,
  lineageSnapshot,
  lifeOf,
  readLineage,
  toolsOfBranch,
  withActive,
  withBranchAdded,
  withBranchRemoved,
  withBranchTools,
  withLastMode,
  writeLineage,
  type BranchKind,
  type Lineage,
  type LineageBranch,
  type LineageRead
} from './lineage'
import { displayNameOf, handoverReceiptOf, RECEIPT_HEAD, receiptText } from './handover'
import type {
  GitRunResult,
  MemoryBranchInfo,
  MemoryHead,
  MemoryRepo,
  MemorySwitchResult
} from './memory-repo'
import { nextForkName } from './node-fork'

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
      /** 摘要本身 token（响应里的 completion_tokens，原样） */
      summaryTokens: number
      /** 压缩前这一问的上下文 token（上一次请求的用量） */
      beforeTokens: number
      /** 压缩后估算的上下文 token（旧用量 − 被压掉的旧轮 + 摘要） */
      afterTokens: number
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
  'life',
  'mode',
  'tool',
  'git'
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
  'life',
  'mode',
  'tool',
  'git'
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

/** token 数 → 人看的短写（≥10k 取整到 k；1k–10k 留一位小数；不足 1k 写原数） */
function formatTokens(tokens: number): string {
  const value = Math.max(0, Math.round(Number.isFinite(tokens) ? tokens : 0))
  if (value < 1000) return String(value)
  if (value < 10_000) {
    const short = (value / 1000).toFixed(1)
    return short.endsWith('.0') ? `${short.slice(0, -2)}k` : `${short}k`
  }
  return `${Math.round(value / 1000)}k`
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

/**
 * 记忆提交的默认名字（D75）：`2026-10-30 18:05`（本地时间到分钟）。
 * 每日固定提交只到日（`memory: 2026-10-30`），两者在历史里分得开。
 */
export function defaultMemoryName(at: number): string {
  return `${memoryDayKey(at)} ${clockOf(at)}`
}

/** 自定义记忆名的上限（提交主题别太长，历史里一行放得下） */
const MEMORY_NAME_MAX = 60

/** 回执里给的名字：空白折叠、去掉首尾空白、截断；空名返回 null（用默认名） */
export function normalizeMemoryName(raw: string): string | null {
  const text = raw.replace(/\s+/gu, ' ').trim()
  if (text === '') return null
  return text.slice(0, MEMORY_NAME_MAX)
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

/**
 * 当前节点先落一次；干净（clean）也算成功。返回错误文本时不切换。
 * 主题默认是时间戳名（`memory: 2026-10-30 18:05`，D75），自定义名由回执命名传进来。
 */
async function saveBefore(deps: CommandDeps, at: number, name?: string): Promise<string | null> {
  // detached（历史提交只读查看）没有「当前节点」可保存：直接切，脏树由 repo 层拒绝
  const head = await deps.repo.head()
  if (head.detached) return null
  const result = await deps.repo.commit(`memory: ${name ?? defaultMemoryName(at)}`)
  if (result.committed || result.reason === 'clean' || result.reason === 'already') return null
  if (result.reason === 'unavailable') return '记忆仓不可用，没有切换（记忆不会丢）。'
  return `保存当前节点失败${result.detail ? `（${result.detail}）` : ''}，没有切换。`
}

/* ------------------------------------------------------------------ */
/* 家谱树（D75）：编号 `0` / `0-1` / `0-1-0`，父子关系来自家谱 parent   */
/* ------------------------------------------------------------------ */

/** 家谱树节点：编号（根 `0`，第 n 个子节点 `<父>-<n>`，从 0 起）、分支名、子节点 */
export interface GenealogyNode {
  id: string
  branch: string
  children: GenealogyNode[]
}

/**
 * 同一层里的顺序（D75）：代 → 种类 → 创建时间。
 * 「原始代」= assistant 分支（无 persona / 无生命），它跟第一代同属 `gen-1`，
 * 但用 kind 排在前面：`[0-0] ask · 纯模型` 在 `[0-1] default` 之前。
 */
function compareGenealogy(lineage: Lineage, a: LineageBranch, b: LineageBranch): number {
  const rank = (node: LineageBranch): [number, number, number, string] => {
    const generation = /^gen-(\d+)$/u.exec(node.generation)
    return [
      generation === null ? Number.MAX_SAFE_INTEGER : Number(generation[1]),
      node.kind === 'assistant' ? 0 : node.kind === 'life' ? 2 : 1,
      node.created_at,
      node.branch
    ]
  }
  const [ga, ka, ta, na] = rank(a)
  const [gb, kb, tb, nb] = rank(b)
  return ga - gb || ka - kb || ta - tb || na.localeCompare(nb)
}

/**
 * 家谱树（`/log` 的渲染与 `/use <编号>` 的同一口径）。
 * - 根：出生主干 `life` 优先，其次第一代主分支，最后家谱里第一条还在的节点；
 * - `parent=null` 的代主分支（女儿那一代）与断链的子节点挂到根下，不丢；
 * - git 有、家谱没有的分支老实列在后面（编号 `1`、`2`…），不编造父子关系。
 */
export function genealogyTree(
  lineage: Lineage | null,
  branches: readonly MemoryBranchInfo[]
): GenealogyNode[] {
  const names = branches.map((item) => item.branch)
  const nodes = (lineage?.branches ?? []).filter((node) => names.includes(node.branch))
  if (lineage === null || nodes.length === 0) {
    return [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((branch, index) => ({ id: String(index), branch, children: [] }))
  }

  const known = new Set(nodes.map((node) => node.branch))
  const childrenOf = new Map<string, LineageBranch[]>()
  const roots: LineageBranch[] = []
  for (const node of nodes) {
    const parent = node.parent
    if (parent !== null && parent !== node.branch && known.has(parent)) {
      const list = childrenOf.get(parent)
      if (list === undefined) childrenOf.set(parent, [node])
      else list.push(node)
    } else {
      roots.push(node)
    }
  }

  const firstGeneration = lineage.generations[0]?.branch
  const rootBranch = names.includes(TRUNK_BRANCH)
    ? TRUNK_BRANCH
    : firstGeneration !== undefined && known.has(firstGeneration)
      ? firstGeneration
      : (nodes[0]?.branch ?? '')

  const seen = new Set<string>()
  const build = (list: readonly LineageBranch[], prefix: string): GenealogyNode[] => {
    const out: GenealogyNode[] = []
    for (const node of [...list].sort((a, b) => compareGenealogy(lineage, a, b))) {
      if (seen.has(node.branch)) continue
      seen.add(node.branch)
      const id = `${prefix}-${out.length}`
      out.push({ id, branch: node.branch, children: build(childrenOf.get(node.branch) ?? [], id) })
    }
    return out
  }

  const rootNode = nodes.find((node) => node.branch === rootBranch)
  const rootChildren =
    rootNode === undefined
      ? roots
      : [...(childrenOf.get(rootBranch) ?? []), ...roots.filter((node) => node.branch !== rootBranch)]
  seen.add(rootBranch)
  const out: GenealogyNode[] = [
    { id: '0', branch: rootBranch, children: build(rootChildren, '0') }
  ]

  const extra = names
    .filter((name) => !known.has(name) && name !== rootBranch)
    .sort((a, b) => a.localeCompare(b))
  extra.forEach((branch, index) => {
    out.push({ id: String(index + 1), branch, children: [] })
  })
  return out
}

/** 树 → 逐行（先父后子） */
export function flattenGenealogy(nodes: readonly GenealogyNode[]): GenealogyNode[] {
  const out: GenealogyNode[] = []
  for (const node of nodes) {
    out.push(node)
    out.push(...flattenGenealogy(node.children))
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
    '  /log [节点]      看家谱；给编号（0 / 0-1）看那个节点的记忆（/log n|l 翻页）',
    '  /new <名字>      从当前节点开新分支（ask 分支 = 从它分叉并清空会话）',
    '  /use <编号|名字|提交> [-d]  切节点；切历史提交 = 只读查看',
    '  /del <名字>      删节点（要回 confirm）',
    '  /mode ask|chat   切模式（ask = 纯模型，chat = 带 persona；切分支）',
    '  /tool            看当前分支的工具；set / ele / add / rm',
    '  /compact         压旧段、保留最近几轮（过一次模型）',
    '  /life            看剩余生命（token；纯模型分支也有，但不冻结）',
    '  /backup [-d]     立即提交记忆；不加 -d 回执起名，配了远端就推送',
    '  /git <参数>      在记忆仓里跑原生命令（/git n|l 翻页）',
    '  /cancel          取消等待中的命名 / 删除',
    '',
    `当前节点：${active}（${activeKind === 'assistant' ? '纯模型' : '聊天'}）`,
    `记忆仓：${repoLine}`
  ].join('\n')
}

/**
 * 提交主题 → 人话（D75：切换前保存 / 备份是时间戳名 `memory: 2026-10-30 18:05`，
 * 自定义名原样显示；D75 之前的 `save before` 只留一句「记忆（旧）」）。
 */
function labelCommitSubject(line: string): string {
  const rules: [RegExp, string][] = [
    [/^memory: (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/u, '记忆 $1 $2'],
    [/^memory: (\d{4}-\d{2}-\d{2})$/u, '记忆 $1'],
    [/^memory: backup (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/u, '记忆 $1 $2'],
    [/^memory: save before .*$/u, '记忆（旧）'],
    [/^memory: birth (\S+)$/u, '出生 $1'],
    [/^memory: born (\S+)$/u, '$1 出生（分支首个提交）'],
    [/^memory: ask (\S+)$/u, '提问会话 $1'],
    [/^memory: ask$/u, '提问会话（挂载）'],
    // D73 / D74 之前建的旧分支：名字还叫 assistant / life，主题也按人话显示
    [/^memory: assistant (\S+)$/u, '提问会话 $1（旧名）'],
    [/^memory: assistant$/u, '提问会话（旧挂载）'],
    [/^memory: life$/u, '主干建立'],
    [/^memory: compact (\S+)$/u, '压缩 $1'],
    [/^memory: fork (\S+)$/u, '分叉 $1'],
    [/^memory: 清空问答历史前$/u, '清空历史前'],
    [/^memory: init$/u, '建仓'],
    [/^memory: (.+)$/u, '$1']
  ]
  let out = line
  for (const [pattern, text] of rules) out = out.replace(pattern, text)
  return out
}

/**
 * 家谱树的一行：`[0-1] 鱼苗 (yumiao) · 7 个工具  ← 当前`。
 * 名字（D82）：有真名就 `真名 (分支)`，没起过名只写分支；`life` 不显示工具数（D75 的样例口径）。
 * 停在历史提交时，家谱 `active` 那个节点标 `← 正在看`（表明这一问会从它分叉）。
 */
function genealogyLine(
  lineage: Lineage | null,
  node: GenealogyNode,
  headBranch: string | null,
  viewedBranch: string | null
): string {
  const info = lineage === null ? null : findBranch(lineage, node.branch)
  const generation = lineage === null ? null : generationOf(lineage, node.branch)
  // 真名挂在这一代的**主分支**上；同代的其他节点（ask / spring）仍只显示分支名
  const realName =
    generation !== null && generation.branch === node.branch ? displayNameOf(generation) : ''
  const label = realName !== '' && realName !== node.branch ? `${realName} (${node.branch})` : node.branch
  let suffix = ''
  if (info !== null && lineage !== null) {
    if (info.kind === 'life') suffix = ' · 主干'
    else {
      if (info.kind === 'assistant') suffix = ' · 纯模型'
      suffix += ` · ${toolsOfBranch(lineage, node.branch).length} 个工具`
    }
  }
  const marker =
    headBranch === node.branch
      ? '  ← 当前'
      : viewedBranch === node.branch
        ? '  ← 正在看'
        : ''
  return `[${node.id}] ${label}${suffix}${marker}`
}

/** 短 sha 比较：`%h` 与 `rev-parse --short` 的位数可能不同，按前缀认同一个提交 */
function sameCommit(a: string, b: string | null): boolean {
  if (b === null || a === '' || b === '') return false
  return a === b || (a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a)))
}

/** `/log <节点>` 一页多少条记忆 */
const HISTORY_PAGE = 20

/** 从 child 沿家谱 parent 往上走，能否走到 root（只看真正的后代） */
function descendsFrom(lineage: Lineage, child: string, root: string): boolean {
  let current = findBranch(lineage, child)
  for (let guard = 0; current !== null && current.parent !== null && guard < 64; guard += 1) {
    if (current.parent === root) return true
    current = findBranch(lineage, current.parent)
  }
  return false
}

/** 短 sha（`%h`）与完整 sha（`merge-base`）是不是同一个提交 */
function sameFullCommit(short: string, full: string): boolean {
  return short.length >= 7 && full.startsWith(short)
}

/**
 * `/log`（D75）：家谱树——父子关系来自家谱 `parent`，编号是 `[父]-[在兄弟里的第几个]`。
 * 树只到分支级；具体记忆用 `/log <节点>`（D77 的提交级页）。
 */
async function treeText(deps: CommandDeps): Promise<string> {
  const status = await deps.repo.status()
  if (!status.ok) return `记忆仓不可用：${repoReasonText(status.reason)}`
  const head = await deps.repo.head()
  const branches = await deps.repo.listBranches()
  if (branches.length === 0) return '记忆仓里还没有节点。'
  const read = await readLineage(deps.lineageFile)
  const lineage = read.status === 'ok' ? read.lineage : null
  const flat = flattenGenealogy(genealogyTree(lineage, branches))
  const viewed = head.detached ? (lineage?.active ?? null) : null
  const lines = flat.map((node) => genealogyLine(lineage, node, head.branch, viewed))
  if (head.detached && head.sha !== null) {
    lines.push('', `HEAD 停在历史提交 ${head.sha}（只读查看；发第一句话会从这里分叉）`)
  }
  return lines.join('\n')
}

/** `/log <节点>` 的节点解析（树编号 / 分支名）；找不到返回 null */
async function resolveLogNode(deps: CommandDeps, target: string): Promise<string | null> {
  const branches = await deps.repo.listBranches()
  if (branches.length === 0) return null
  const read = await readLineage(deps.lineageFile)
  const lineage = read.status === 'ok' ? read.lineage : null
  const flat = flattenGenealogy(genealogyTree(lineage, branches))
  return (
    (flat.find((node) => node.id === target) ?? flat.find((node) => node.branch === target))
      ?.branch ?? null
  )
}

/**
 * `/log <节点>`（D77）：这个节点的记忆页——提交**旧 → 新**；从某条提交分出去的分支
 * 挂在那条提交下面（只到分支名，它的记忆再 `/log <分支>` 看）。
 * `offset` 从最旧一条数起；`/log n` 下一页（更新）、`/log l` 上一页（更旧）。
 */
async function historyPage(
  deps: CommandDeps,
  branch: string,
  offset: number
): Promise<{ text: string; offset: number }> {
  const head = await deps.repo.head()
  const total = await deps.repo.commitCount(branch)
  const lastPage = total === 0 ? 0 : Math.floor((total - 1) / HISTORY_PAGE) * HISTORY_PAGE
  const start = Math.max(0, Math.min(offset, lastPage))
  const commits = total === 0 ? [] : await deps.repo.branchLog(branch, total - start)
  const window = [...commits].reverse().slice(0, HISTORY_PAGE)

  const read = await readLineage(deps.lineageFile)
  const lineage = read.status === 'ok' ? read.lineage : null
  const names = new Set((await deps.repo.listBranches()).map((item) => item.branch))
  const forks = new Map<string, string[]>()
  if (lineage !== null) {
    for (const child of lineage.branches) {
      if (child.branch === branch || !names.has(child.branch)) continue
      if (!descendsFrom(lineage, child.branch, branch)) continue
      const base = await deps.repo.mergeBase(child.branch, branch)
      if (base === null) continue
      const hit = window.find((commit) => sameFullCommit(commit.hash, base))
      if (hit === undefined) continue
      const list = forks.get(hit.hash) ?? []
      list.push(child.branch)
      forks.set(hit.hash, list)
    }
  }

  const lines = [`[0] ${branch}${head.branch === branch ? '  ← 当前' : ''}`]
  if (window.length === 0) lines.push('（还没有提交）')
  window.forEach((commit, index) => {
    const inUse = head.branch === branch && sameCommit(commit.hash, head.sha) ? '  ← 正在用' : ''
    lines.push(`[0-${index}] ${labelCommitSubject(commit.subject)} · ${commit.hash}${inUse}`)
    const children = forks.get(commit.hash) ?? []
    children.forEach((child, childIndex) => {
      const marker =
        head.branch === child
          ? '  ← 当前'
          : head.detached && lineage?.active === child
            ? '  ← 正在看'
            : ''
      lines.push(`[0-${index}-${childIndex}] ${child}${marker}`)
    })
  })

  const hasOlder = start > 0
  const hasNewer = start + HISTORY_PAGE < total
  if (hasOlder || hasNewer) {
    lines.push(
      '',
      [hasOlder ? '/log l 上一页（更旧）' : '', hasNewer ? '/log n 下一页（更新）' : '']
        .filter((item) => item !== '')
        .join(' · ')
    )
  }
  return { text: lines.join('\n'), offset: start }
}

/** `/git` 输出每页多少行（D78） */
const GIT_PAGE = 20
const GIT_LINE_MAX = 300

interface GitPage {
  command: string
  lines: string[]
  page: number
  code: number | null
}

/** `/git` 的 stdout + stderr → 逐行（去掉首尾空行、每行截断） */
function gitOutputLines(result: GitRunResult): string[] {
  const out: string[] = []
  for (const line of result.stdout.split('\n')) {
    if (line === '' && out.length === 0) continue
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  if (result.stderr.trim() !== '') {
    if (out.length > 0) out.push('')
    out.push('[stderr]')
    for (const line of result.stderr.split('\n')) {
      if (line.trim() !== '') out.push(line)
    }
  }
  if (out.length === 0) out.push('（没有输出）')
  return out.map((line) => (line.length > GIT_LINE_MAX ? `${line.slice(0, GIT_LINE_MAX)}…` : line))
}

function gitPageText(state: GitPage): string {
  const total = Math.max(1, Math.ceil(state.lines.length / GIT_PAGE))
  const page = Math.max(0, Math.min(state.page, total - 1))
  const lines = state.lines.slice(page * GIT_PAGE, page * GIT_PAGE + GIT_PAGE)
  const footer = [
    `第 ${page + 1}/${total} 页`,
    page > 0 ? '/git l 上一页' : '',
    page + 1 < total ? '/git n 下一页' : '',
    state.code === null ? '没跑起来' : `退出码 ${state.code}`
  ]
    .filter((item) => item !== '')
    .join(' · ')
  return [`/git ${state.command}`, ...lines, '', `（${footer}）`].join('\n')
}

/** `/git` 改了 HEAD 之后：同步家谱 active、回执里说明（detached 只写仓外家谱，D76 口径） */
async function syncAfterGit(deps: CommandDeps, head: MemoryHead): Promise<string> {
  const read = await readLineage(deps.lineageFile)
  if (read.status !== 'ok') return '（HEAD 变了，但家谱读不出来，细节看日志）'
  const lineage = read.lineage
  const branch = head.detached ? lineage.active : head.branch
  if (branch === null) return ''
  if (findBranch(lineage, branch) === null) {
    return `（HEAD 切到 ${branch}，但家谱里没有这个节点，先 /log 看看）`
  }
  const next = withActive(lineage, branch)
  if (next !== null && next !== lineage) {
    if (head.detached) await writeLineage(deps.lineageFile, next)
    else await writeLineageQuietly(deps, next)
  }
  return head.detached
    ? `（HEAD 停在 ${head.sha ?? '未知'}，家谱当前节点记作 ${branch}）`
    : `（HEAD 已切到 ${branch}，家谱当前节点同步）`
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
 * D74：主干固定叫 `life`（D73 那次改名 `ask` 作废——`ask` 现在是纯模型分支）。
 */
async function ensureTrunkBranch(
  deps: CommandDeps,
  lineage: Lineage,
  at: number
): Promise<{ lineage: Lineage; trunk: string; error?: string }> {
  const branches = await deps.repo.listBranches()
  const trunk = TRUNK_BRANCH

  const adopted = await adoptTrunkBranch(deps, lineage, at, trunk)
  if (adopted === null) return { lineage, trunk, error: '主干加不进家谱（细节看日志）。' }
  if (findBranch(adopted, trunk) !== null) return { lineage: adopted, trunk }

  const saved = await saveBefore(deps, at)
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
  // D74：主干的第一个提交记「第一代出生」，让往下/向右的图从 gen-1 开始
  await deps.repo.commit(`memory: birth ${added.generations[0]?.branch ?? 'default'}`)
  return { lineage: added, trunk }
}

/** 纯模型会话分支的候选名：`ask` / `ask-2` / …（D74：原 assistant） */
function nextAskName(lineage: Lineage, taken: readonly MemoryBranchInfo[]): string {
  const used = new Set<string>([
    ...lineage.branches.map((item) => item.branch),
    ...taken.map((item) => item.branch)
  ])
  if (!used.has('ask')) return 'ask'
  for (let index = 2; index < 1_000; index += 1) {
    const name = `ask-${index}`
    if (!used.has(name)) return name
  }
  return `ask-${Date.now().toString(36)}`
}

/**
 * 开纯模型挂载分支 `ask`（D74）：从**出生主干**分叉（主干里只有家谱快照、没有对话，
 * 所以 ask 天然是空上下文）；图上是真分支（life → ask）。
 */
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
  const trunk = ensured.trunk

  const saved = await saveBefore(deps, at)
  if (saved !== null) return { error: saved }
  const onTrunk = await deps.repo.switchBranch(trunk)
  if (!onTrunk.ok) return { error: failureReasonText(onTrunk, `切到 ${trunk} 主干`) }
  const name = nextAskName(base, await deps.repo.listBranches())
  const created = await deps.repo.switchCreate(name)
  if (!created.ok) return { error: failureReasonText(created, `开出 ${name}`) }

  const added = withBranchAdded(base, {
    branch: name,
    generation: base.generations[0]?.id ?? 'gen-1',
    parent: trunk,
    at,
    kind: 'assistant'
  })
  if (added === null) return { error: '纯模型分支加不进家谱（细节看日志）。' }
  const next = withLastMode(withActive(added, name) ?? added, 'ask', name)
  await writeLineageQuietly(deps, next)
  await deps.repo.commit(`memory: ask ${name}`)
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
  // 纯模型分支的 `/new` = 从当前 ask 分叉（图上是真分支）+ 清空会话（上下文空白）；
  // persona 分支仍从当前节点分叉，带着它的记忆（D74）
  if (currentKind === 'assistant') {
    const saved = await saveBefore(deps, at)
    if (saved !== null) return { text: saved }
    const created = await deps.repo.switchCreate(slug)
    if (!created.ok) return { text: failureReasonText(created, `开出空会话 ${slug}`) }
    const cleared = await deps.repo.clearConversations()
    if (!cleared) {
      await deps.repo.switchBranch(current)
      return { text: '清空新会话的上下文失败，没有切换（细节看日志）。' }
    }
    const tools = toolsOfBranch(lineage, current)
    const added = withBranchAdded(lineage, {
      branch: slug,
      generation: generationOf(lineage, current)?.id ?? lineage.generations[0]?.id ?? 'gen-1',
      parent: current,
      at,
      kind: 'assistant',
      tools
    })
    if (added === null) return { text: '分支加不进家谱（细节看日志）。' }
    const next = withLastMode(withActive(added, slug) ?? added, 'ask', slug)
    await writeLineageQuietly(deps, next)
    await deps.repo.commit(`memory: ask ${slug}`)
    deps.reloadConversations?.()
    return {
      text: [
        RECEIPT_HEAD,
        `新会话 ✨${slug} 已开出（从 ✨${current} 分叉，上下文清空：只有之后的对话）。`,
        '发一句话就开始记；/use 可以回以前的会话。'
      ].join('\n'),
      mode: modeStateOf(next, slug)
    }
  }

  const saved = await saveBefore(deps, at)
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
      RECEIPT_HEAD,
      `新节点 ✨${slug} 已从 ✨${parent} 开出，当前在这里。`,
      '发一句话就开始记到这条线上；/use 可以切回去。'
    ].join('\n'),
    ...(added !== null ? { mode: modeStateOf(added, slug) } : {})
  }
}

interface MemoryOutcome {
  text: string
  mode?: AskModeState
}

/**
 * 回执命名之后的动作（D75）：先给当前记忆起名，再切换 / 只读查看 / 备份。
 * 起名之前这些动作一律不做——HEAD 不动、提交不落，超时才按默认名继续。
 */
type MemoryAction =
  | { kind: 'branch'; branch: string; mode?: AskModeState }
  | {
      kind: 'commit'
      sha: string
      from: string
      /** 这条提交属于哪个节点（`/use <sha>` 之前在看的那页；没有就沿用 active） */
      owner?: string
      /** 下一句会分叉出来的名字（`<owner>-<n>`） */
      forkName?: string
    }
  | { kind: 'backup' }

/** `/use` 的 `-d`：带上就用默认时间戳名，不带则回执起名（D75）；名字只走回执，不跟在命令上 */
function parseUseArgs(args: readonly string[]): { target: string; defaultName: boolean } {
  const defaultName = args.some((arg) => arg === '-d' || arg === '--default')
  return {
    target: args.filter((arg) => arg !== '-d' && arg !== '--default').join(' ').trim(),
    defaultName
  }
}

/** 回执起名的提示：`0`（或空）= 默认时间戳名 */
function namePromptText(kind: 'use' | 'backup', at: number): string {
  return [
    RECEIPT_HEAD,
    kind === 'use' ? '切换前先把当前记忆存一份。' : '先把当前记忆存一份。',
    `给它起个名字？回 0 用默认：记忆 ${defaultMemoryName(at)}`,
    '（60 秒内回；/cancel 放弃这次切换 / 备份）'
  ].join('\n')
}

/** 名字到手（或超时用默认名）之后，把保存 + 切换 / 查看 / 备份做完 */
async function finishMemoryAction(
  deps: CommandDeps,
  action: MemoryAction,
  at: number,
  name?: string
): Promise<MemoryOutcome> {
  if (action.kind === 'backup') return { text: await backupText(deps, at, name) }

  const saved = await saveBefore(deps, at, name)
  if (saved !== null) return { text: saved }

  if (action.kind === 'commit') {
    const checkedOut = await deps.repo.checkoutCommit(action.sha)
    if (!checkedOut.ok) return { text: failureReasonText(checkedOut, `切到提交 ${action.sha}`) }
    // 记下「正在看哪个节点」：下一句自动分叉就从它出发（D76）；
    // 只写权威家谱，不动仓里的快照——detached 时写快照会让工作区变脏，`/use` 就切不回去了
    if (action.owner !== undefined) {
      const read = await readLineage(deps.lineageFile)
      if (read.status === 'ok') {
        const next = withActive(read.lineage, action.owner)
        if (next !== null && next !== read.lineage) {
          await writeLineage(deps.lineageFile, next)
        }
      }
    }
    deps.reloadConversations?.()
    if (action.owner === undefined) {
      return {
        text: [
          RECEIPT_HEAD,
          `已停在历史提交 ✨${action.sha}——这里是只读的旧位置，家谱不变。`,
          `发第一句话会从这里分叉成 ✨${action.from}-<序号>；只看不聊不会留下分支。`
        ].join('\n')
      }
    }
    return {
      text: [
        RECEIPT_HEAD,
        `已停在历史提交 ✨${action.sha}——只读旧位置，家谱当前节点记作 ✨${action.owner}。`,
        `发第一句话会从 ✨${action.owner} 分叉${action.forkName !== undefined ? `成 ✨${action.forkName}` : ''}；只看不聊不会留下分支。`
      ].join('\n')
    }
  }

  const read = await readLineage(deps.lineageFile)
  const lineage = read.status === 'ok' ? read.lineage : null
  const switched = await deps.repo.switchBranch(action.branch)
  if (!switched.ok) return { text: failureReasonText(switched, `切到 ${action.branch}`) }
  const synced = await syncActive(deps, lineage, action.branch, action.mode?.kind)
  deps.reloadConversations?.()
  // 切到的是一代已经交接过的母亲（D82）：顺手把那一行交接回执补给她看（同一个抬头下）
  const receipt = synced !== undefined ? handoverReceiptOf(synced, action.branch) : null
  return {
    text: receiptText(
      `已切到节点 ✨${action.branch}。这一问开始用它的记忆。${receipt !== null ? `\n\n${receipt}` : ''}`
    ),
    ...(synced !== undefined ? { mode: modeStateOf(synced, action.branch) } : action.mode !== undefined ? { mode: action.mode } : {})
  }
}

async function useNode(
  deps: CommandDeps,
  target: string,
  at: number,
  defaultName: boolean,
  viewedNode: string | null
): Promise<MemoryOutcome & { pending?: MemoryAction }> {
  const status = await deps.repo.status()
  if (!status.ok) return { text: `记忆仓不可用：${repoReasonText(status.reason)}` }
  const head = await deps.repo.head()
  const branches = await deps.repo.listBranches()
  const read = await readLineage(deps.lineageFile)
  const lineage = read.status === 'ok' ? read.lineage : null
  // 只有「真会落一份提交」时才要起名：干净工作区 / detached 都不用问
  const needsSave = !head.detached && status.dirty

  let branchName: string | null = null
  if (/^\d+(?:-\d+)*$/u.test(target)) {
    const hit = flattenGenealogy(genealogyTree(lineage, branches)).find((node) => node.id === target)
    if (hit === undefined) return { text: `没有节点 ${target}（/log 看家谱）。` }
    branchName = hit.branch
  } else if (branches.some((entry) => entry.branch === target)) {
    branchName = target
  }

  if (branchName !== null) {
    if (lineage !== null && branchKindOf(lineage, branchName) === 'life') {
      return {
        text: `${branchName} 是出生主干，只放出生提交；先 /new 从它开一条节点再聊。`
      }
    }
    const mode = lineage !== null ? modeStateOf(lineage, branchName) : undefined
    if (head.branch === branchName) {
      const synced = await syncActive(deps, lineage, branchName, mode?.kind)
      const receipt =
        synced !== undefined
          ? handoverReceiptOf(synced, branchName)
          : lineage !== null
            ? handoverReceiptOf(lineage, branchName)
            : null
      return {
        text: receiptText(
          `已经在 ✨${branchName}。${receipt !== null ? `\n\n${receipt}` : ''}`
        ),
        ...(synced !== undefined ? { mode: modeStateOf(synced, branchName) } : mode !== undefined ? { mode } : {})
      }
    }
    const plan: MemoryAction = {
      kind: 'branch',
      branch: branchName,
      ...(mode !== undefined ? { mode } : {})
    }
    if (needsSave && !defaultName) return { text: namePromptText('use', at), pending: plan }
    return finishMemoryAction(deps, plan, at)
  }

  const sha = await deps.repo.revParse(target)
  if (sha === null) return { text: `没找到节点或提交「${target}」（/log 看家谱）。` }
  // 这条提交属于哪个节点（D76）：优先用刚 `/log <节点>` 看的那页，其次沿用自己的当前节点
  const owner =
    viewedNode !== null && lineage !== null && findBranch(lineage, viewedNode) !== null
      ? viewedNode
      : (lineage?.active ?? null)
  const forkName =
    owner !== null
      ? nextForkName(
          owner,
          branches.map((entry) => entry.branch)
        )
      : undefined
  const plan: MemoryAction = {
    kind: 'commit',
    sha,
    from: head.branch ?? lineage?.active ?? 'default',
    ...(owner !== null ? { owner } : {}),
    ...(forkName !== undefined ? { forkName } : {})
  }
  if (needsSave && !defaultName) return { text: namePromptText('use', at), pending: plan }
  return finishMemoryAction(deps, plan, at)
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

async function deleteNode(deps: CommandDeps, branch: string, at: number): Promise<string> {
  const saved = await saveBefore(deps, at)
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

type Pending =
  | { kind: 'name' }
  | { kind: 'delete'; branch: string }
  | { kind: 'memory'; action: MemoryAction }
  | null

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
        return commandResult(created.error ?? '开纯模型分支失败（细节看日志）。')
      }
      const mode = modeStateOf(created.lineage, created.branch)
      return commandResult(
        [
          RECEIPT_HEAD,
          `模式：${modeSummary(mode)}（新开的纯模型分支；只有之后的对话，没有之前的记忆）`,
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
    return commandResult(receiptText(`已经在 ${modeSummary(mode)}。`), mode)
  }
  const saved = await saveBefore(deps, at)
  if (saved !== null) return commandResult(saved)
  const switched = await deps.repo.switchBranch(target)
  if (!switched.ok) return commandResult(failureReasonText(switched, `切到 ${target}`))
  const next = await syncActive(deps, lineage, target, kind)
  deps.reloadConversations?.()
  return commandResult(
    [
      RECEIPT_HEAD,
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
    'give_birth 不在里面：生命 ≤15% 时自动出现。'
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
  /** 最近一次 `/log <节点>` 看的是哪个节点（D76：`/use <sha>` 之后从它分叉） */
  let viewedNode: string | null = null
  /** 当前翻到哪一页（D77：`/log n` 下一页、`/log l` 上一页） */
  let history: { node: string; offset: number } | null = null
  /** `/git` 上一次的输出（D78：翻页用，不重跑命令） */
  let gitPage: GitPage | null = null

  /**
   * 超时的等待：命名等待（D75）按默认名把动作做完（切换 / 备份照做），
   * 其余（`/new` 起名、删除确认）直接作废。
   */
  const takeExpired = (at: number): MemoryAction | null => {
    if (pending === null || at - pendingAt <= COMMAND_WAIT_TIMEOUT_MS) return null
    const action = pending.kind === 'memory' ? pending.action : null
    pending = null
    return action
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
      const contextLine =
        outcome.beforeTokens > 0 && outcome.afterTokens > 0
          ? `上下文 ${formatTokens(outcome.beforeTokens)} → ${formatTokens(outcome.afterTokens)} token（估算）`
          : '上下文 token 数这轮没读到（细节看日志）'
      return commandResult(
        [
          RECEIPT_HEAD,
          `压掉 ${outcome.dropped} 轮（保留最近 ${outcome.kept} 轮原文），摘要 ${outcome.summaryTokens} token。`,
          `${contextLine}；生命按压完的上下文重算，下一问可以接着聊。`
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
    const expired = takeExpired(at)
    // 超时的起名等待按默认名做完（切换 / 备份照做），这条输入再照常处理
    if (expired !== null) await finishMemoryAction(deps, expired, at)
    const trimmed = text.trim()

    if (pending !== null && !trimmed.startsWith('/')) {
      if (pending.kind === 'name') {
        pending = null
        return handleNodeName(trimmed, at)
      }
      if (pending.kind === 'memory') {
        const action = pending.action
        pending = null
        const name =
          trimmed === '' || trimmed === '0' ? undefined : (normalizeMemoryName(trimmed) ?? undefined)
        const out = await finishMemoryAction(deps, action, at, name)
        return commandResult(out.text, out.mode)
      }
      const branch = pending.branch
      if (trimmed.toLowerCase() === 'confirm') {
        pending = null
        return commandResult(await deleteNode(deps, branch, at))
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
      case 'log': {
        const target = parsed.args.join(' ').trim()
        if ((target === 'n' || target === 'l') && history !== null) {
          const offset =
            target === 'n'
              ? history.offset + HISTORY_PAGE
              : Math.max(0, history.offset - HISTORY_PAGE)
          const out = await historyPage(deps, history.node, offset)
          history = { node: history.node, offset: out.offset }
          return commandResult(out.text)
        }
        if (target === '') return commandResult(await treeText(deps))
        const node = await resolveLogNode(deps, target)
        if (node === null) return commandResult(`没有节点 ${target}（/log 看家谱）。`)
        const out = await historyPage(deps, node, 0)
        history = { node, offset: out.offset }
        viewedNode = node
        return commandResult(out.text)
      }
      case 'backup': {
        const args = parsed.args.filter((arg) => arg !== '')
        const defaultName = args.some((arg) => arg === '-d' || arg === '--default')
        const rest = args.filter((arg) => arg !== '-d' && arg !== '--default')
        if (rest.length > 0) {
          return commandResult('用法：/backup [-d]\n名字在回执里给（回 0 = 默认名）。')
        }
        if (defaultName) return commandResult(await backupText(deps, at))
        pending = { kind: 'memory', action: { kind: 'backup' } }
        pendingAt = at
        return commandResult(namePromptText('backup', at))
      }
      case 'git': {
        const args = parsed.args.filter((arg) => arg !== '')
        if (args.length === 1 && (args[0] === 'n' || args[0] === 'l')) {
          if (gitPage === null) {
            return commandResult('先跑一条 /git 命令，再用 /git n 下一页 / /git l 上一页。')
          }
          const total = Math.max(1, Math.ceil(gitPage.lines.length / GIT_PAGE))
          const page = args[0] === 'n' ? gitPage.page + 1 : gitPage.page - 1
          gitPage = { ...gitPage, page: Math.max(0, Math.min(page, total - 1)) }
          return commandResult(gitPageText(gitPage))
        }
        if (args.length === 0) {
          return commandResult(
            '用法：/git <git 参数>（在记忆仓里跑，例如 /git log --oneline -8；/git n|l 翻页）'
          )
        }
        const before = await deps.repo.head()
        const result = await deps.repo.git(args)
        if (result.error !== undefined) {
          const why =
            result.error === 'git-missing'
              ? '没找到 git（装一个再重开应用）'
              : result.error === 'timeout'
                ? '超时了（20 秒）'
                : `跑不起来（${result.error}）`
          return commandResult(`git ${why}，细节看日志。`)
        }
        const after = await deps.repo.head()
        let note = ''
        if (before.branch !== after.branch || before.sha !== after.sha) {
          deps.reloadConversations?.()
          note = await syncAfterGit(deps, after)
        }
        gitPage = {
          command: args.join(' '),
          lines: gitOutputLines(result),
          page: 0,
          code: result.code
        }
        return commandResult(note === '' ? gitPageText(gitPage) : `${gitPageText(gitPage)}\n\n${note}`)
      }
      case 'cancel': {
        if (pending === null) return commandResult('没有等待中的操作。')
        pending = null
        return commandResult('已取消。')
      }
      case 'compact':
        return handleCompact(context)
      case 'life': {
        const read = await readLineage(deps.lineageFile)
        if (read.status !== 'ok') return commandResult('家谱还没建好，看不到生命（细节看日志）。')
        const life = lifeOf(read.lineage, read.lineage.active)
        if (life === null) return commandResult('这条分支还没记过生命。')
        return commandResult(
          [
            `❤️剩余生命✨${life.percent}%`,
            `🔤上下文 已使用✨${formatTokens(life.used)}，剩余✨${formatTokens(life.remaining)}（${formatTokens(life.limit)}）`
          ].join('\n')
        )
      }
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
            '给新节点起个名字（中文会转成拼音，例如「春天」→ chun-tian），60 秒内发给我。\n（ask 分支上 /new = 从它分叉并清空会话）'
          )
        }
        return handleNodeName(name, at)
      }
      case 'use': {
        const { target, defaultName } = parseUseArgs(parsed.args)
        if (target === '') {
          return commandResult('用法：/use <编号|名字|提交> [-d]（先 /log 看家谱）')
        }
        const out = await useNode(deps, target, at, defaultName, viewedNode)
        if (out.pending !== undefined) {
          pending = { kind: 'memory', action: out.pending }
          pendingAt = at
        }
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

async function backupText(deps: CommandDeps, at: number, name?: string): Promise<string> {
  const result = await deps.repo.commit(`memory: ${name ?? defaultMemoryName(at)}`)
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
