/**
 * 记忆仓 · 家谱（memory-life M1，2026-10-30）
 *
 * 家谱是**仓外**的权威文件：`<userData>/memory-lineage.json`。
 * 每代鱼、每条分支、当前节点、生命额度都在这里；仓里只放一份只读快照
 * （`lineage.snapshot.json`），这样 checkout 任何分支都不会把家谱切旧。
 *
 * 纪律：
 * - 写入是「临时文件 + rename」的原子替换，替换前留一份 `.bak`；
 * - 读失败 / 结构不认识都返回明确状态，调用方决定怎么降级，不静默编造；
 * - 缺省家谱 = 第一代 `gen-1`，分支 `default`（`life` 主干在 M4 传承时才出生）。
 */

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const LINEAGE_VERSION = 1
/** 一条命的上下文额度（方案 §5.1） */
export const LINEAGE_LIFE_TOKENS = 500_000

export type BranchStatus = 'alive' | 'dead' | 'frozen'

export interface LineageGeneration {
  id: string
  branch: string
  nickname: string
  /** 谁生的；第一代为 null */
  mother: string | null
  born_at: number
  died_at: number | null
  /** 当前节点最近一次请求的上下文占用（M3 记账；M1 恒为 0） */
  life_tokens_used: number
  letter: string | null
}

export interface LineageBranch {
  branch: string
  generation: string
  /** 从哪个节点分出来；第一代 / 代分支为 null */
  parent: string | null
  created_at: number
  status: BranchStatus
  /**
   * 这个节点的上下文占用（最近一次请求的 prompt+completion，M3）。
   * 按**节点**记而不是按代：同一代的不同分支各有各的上下文（方案 §4 / §5.1）。
   */
  life_tokens_used: number
}

export interface Lineage {
  version: typeof LINEAGE_VERSION
  life_tokens: number
  /** 当前节点（分支名） */
  active: string
  generations: LineageGeneration[]
  branches: LineageBranch[]
}

export type LineageRead =
  | { status: 'ok'; lineage: Lineage }
  | { status: 'missing' }
  | { status: 'invalid'; detail: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseGeneration(value: unknown): LineageGeneration | null {
  if (!isRecord(value)) return null
  const id = readString(value.id)
  const branch = readString(value.branch)
  const nickname = readString(value.nickname)
  const bornAt = readNumber(value.born_at)
  if (id === null || branch === null || nickname === null || bornAt === null) return null
  const mother = value.mother === null ? null : readString(value.mother)
  const diedAt = value.died_at === null ? null : readNumber(value.died_at)
  return {
    id,
    branch,
    nickname,
    mother,
    born_at: bornAt,
    died_at: diedAt,
    life_tokens_used: readNumber(value.life_tokens_used) ?? 0,
    letter: value.letter === null ? null : readString(value.letter)
  }
}

function parseBranch(value: unknown): LineageBranch | null {
  if (!isRecord(value)) return null
  const branch = readString(value.branch)
  const generation = readString(value.generation)
  const createdAt = readNumber(value.created_at)
  const status = value.status
  if (branch === null || generation === null || createdAt === null) return null
  if (status !== 'alive' && status !== 'dead' && status !== 'frozen') return null
  return {
    branch,
    generation,
    parent: value.parent === null ? null : readString(value.parent),
    created_at: createdAt,
    status,
    // M2 之前写的家谱没有这个字段：缺省 0（旧节点从下一次请求开始计）
    life_tokens_used: readNumber(value.life_tokens_used) ?? 0
  }
}

/** 结构校验：认不出就 invalid，不半信半疑地修补字段 */
export function parseLineage(raw: unknown): Lineage | null {
  if (!isRecord(raw)) return null
  if (raw.version !== LINEAGE_VERSION) return null
  const lifeTokens = readNumber(raw.life_tokens)
  const active = readString(raw.active)
  if (lifeTokens === null || lifeTokens <= 0 || active === null) return null
  if (!Array.isArray(raw.generations) || !Array.isArray(raw.branches)) return null
  const generations: LineageGeneration[] = []
  for (const item of raw.generations) {
    const parsed = parseGeneration(item)
    if (parsed === null) return null
    generations.push(parsed)
  }
  const branches: LineageBranch[] = []
  for (const item of raw.branches) {
    const parsed = parseBranch(item)
    if (parsed === null) return null
    branches.push(parsed)
  }
  if (generations.length === 0 || branches.length === 0) return null
  if (!branches.some((branch) => branch.branch === active)) return null
  return { version: LINEAGE_VERSION, life_tokens: lifeTokens, active, generations, branches }
}

export function emptyLineage(now: number): Lineage {
  return {
    version: LINEAGE_VERSION,
    life_tokens: LINEAGE_LIFE_TOKENS,
    active: 'default',
    generations: [
      {
        id: 'gen-1',
        branch: 'default',
        nickname: 'default',
        mother: null,
        born_at: now,
        died_at: null,
        life_tokens_used: 0,
        letter: null
      }
    ],
    branches: [
      {
        branch: 'default',
        generation: 'gen-1',
        parent: null,
        created_at: now,
        status: 'alive',
        life_tokens_used: 0
      }
    ]
  }
}

/** 读家谱：文件不存在 / 结构不认识分开报，调用方据此决定是新建还是备份损坏文件 */
export async function readLineage(filePath: string): Promise<LineageRead> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { status: 'missing' }
    return { status: 'invalid', detail: String(error) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'invalid', detail: 'json' }
  }
  const lineage = parseLineage(parsed)
  return lineage === null ? { status: 'invalid', detail: 'shape' } : { status: 'ok', lineage }
}

/** 原子写 + 旧文件留一份 `.bak`（写失败返回 false，不抛给调用方） */
export async function writeLineage(filePath: string, lineage: Lineage): Promise<boolean> {
  const tmp = `${filePath}.tmp`
  try {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(tmp, `${JSON.stringify(lineage, null, 2)}\n`, 'utf8')
    try {
      await copyFile(filePath, `${filePath}.bak`)
    } catch {
      // 第一次写没有旧文件
    }
    await rename(tmp, filePath)
    return true
  } catch {
    return false
  }
}

export interface EnsureLineageResult {
  lineage: Lineage
  /** 这次新建了缺省家谱（文件本来不存在） */
  created: boolean
  /** 旧文件损坏，已备份并新建 */
  recovered: boolean
  backupPath?: string
}

/**
 * 取家谱（没有就建，坏就备份后重建）。
 * 损坏文件不静默丢：先复制成 `.corrupt-<时间>`，再写缺省家谱，返回 recovered=true。
 */
export async function ensureLineage(
  filePath: string,
  options: { now?: number } = {}
): Promise<EnsureLineageResult> {
  const now = options.now ?? Date.now()
  const read = await readLineage(filePath)
  if (read.status === 'ok') return { lineage: read.lineage, created: false, recovered: false }
  if (read.status === 'missing') {
    const lineage = emptyLineage(now)
    await writeLineage(filePath, lineage)
    return { lineage, created: true, recovered: false }
  }
  const backupPath = `${filePath}.corrupt-${now}`
  let backedUp = false
  try {
    await copyFile(filePath, backupPath)
    backedUp = true
  } catch {
    // 备份失败也继续：宁可先有一份可用家谱，也别让问记忆卡在读取上
  }
  const lineage = emptyLineage(now)
  await writeLineage(filePath, lineage)
  return {
    lineage,
    created: false,
    recovered: true,
    ...(backedUp ? { backupPath } : {})
  }
}

/** 仓里那份只读快照：格式稳定（缩进 2、末尾换行），diff 好读 */
export function lineageSnapshot(lineage: Lineage): string {
  return `${JSON.stringify(lineage, null, 2)}\n`
}

/** 当前节点（分支名）；家谱里 active 一定存在（parse 阶段已校验） */
export function activeBranch(lineage: Lineage): string {
  return lineage.active
}

/* ------------------------------------------------------------------ */
/* 节点（分支）操作：M2 —— 纯函数，返回 null 表示这次操作不合法          */
/* ------------------------------------------------------------------ */

export interface AddBranchInput {
  branch: string
  /** 属于哪一代（`/new` 从当前节点开分支时沿用原分支的代） */
  generation: string
  /** 从哪个节点分出来；第一代 / 代分支为 null */
  parent: string | null
  at: number
}

export function findBranch(lineage: Lineage, branch: string): LineageBranch | null {
  return lineage.branches.find((item) => item.branch === branch) ?? null
}

export function generationOf(lineage: Lineage, branch: string): LineageGeneration | null {
  const node = findBranch(lineage, branch)
  if (node === null) return null
  return lineage.generations.find((item) => item.id === node.generation) ?? null
}

/** 直接挂在某节点下的子节点（`/del` 的「有后代不许删」） */
export function childBranches(lineage: Lineage, branch: string): LineageBranch[] {
  return lineage.branches.filter((item) => item.parent === branch)
}

/** 追加一条节点；重名 / 代不存在 / 父节点不存在返回 null */
export function withBranchAdded(lineage: Lineage, input: AddBranchInput): Lineage | null {
  if (input.branch.trim() === '') return null
  if (findBranch(lineage, input.branch) !== null) return null
  if (input.parent !== null && findBranch(lineage, input.parent) === null) return null
  if (!lineage.generations.some((item) => item.id === input.generation)) return null
  return {
    ...lineage,
    branches: [
      ...lineage.branches,
      {
        branch: input.branch,
        generation: input.generation,
        parent: input.parent,
        created_at: input.at,
        status: 'alive',
        life_tokens_used: 0
      }
    ]
  }
}

/** 切活动节点；分支不存在返回 null，已经在就不变 */
export function withActive(lineage: Lineage, branch: string): Lineage | null {
  if (findBranch(lineage, branch) === null) return null
  if (lineage.active === branch) return lineage
  return { ...lineage, active: branch }
}

/**
 * 删除一条节点：当前节点 / 代的主分支 / 有子节点的都不许删，返回 null 由调用方报原因。
 * （git 层的 `branch -D` 不检查后代，这层是唯一防线。）
 */
export function withBranchRemoved(lineage: Lineage, branch: string): Lineage | null {
  if (findBranch(lineage, branch) === null) return null
  if (lineage.active === branch) return null
  if (lineage.generations.some((item) => item.branch === branch)) return null
  if (lineage.branches.some((item) => item.parent === branch)) return null
  return { ...lineage, branches: lineage.branches.filter((item) => item.branch !== branch) }
}

/* ------------------------------------------------------------------ */
/* 生命（M3）：按节点记账 / 读剩余                                      */
/* ------------------------------------------------------------------ */

export interface LineageLife {
  branch: string
  /** 最近一次请求的上下文占用（prompt+completion） */
  used: number
  /** 一条命的额度（`life_tokens`） */
  limit: number
  /** 还能用多少（下限 0） */
  remaining: number
  /** 剩余百分比（0–100，取整） */
  percent: number
}

/** 读某节点的生命；节点不存在返回 null（调用方按「还没记账」处理） */
export function lifeOf(lineage: Lineage, branch: string): LineageLife | null {
  const node = findBranch(lineage, branch)
  if (node === null) return null
  const used = Math.max(0, Math.round(node.life_tokens_used))
  const limit = lineage.life_tokens
  const remaining = Math.max(0, limit - used)
  return {
    branch,
    used,
    limit,
    remaining,
    percent: limit > 0 ? Math.round((remaining / limit) * 100) : 0
  }
}

/**
 * 每轮 ask 结束记一次：这个节点的 `life_tokens_used` = 最近一次请求的上下文占用。
 * 不是累计消耗（方案 §5.1）；记账失败只返回 false，不影响这一轮回答。
 */
export async function recordLineageUsage(
  filePath: string,
  branch: string,
  tokens: number
): Promise<boolean> {
  const read = await readLineage(filePath)
  if (read.status !== 'ok') return false
  if (findBranch(read.lineage, branch) === null) return false
  const used = Math.max(0, Math.round(Number.isFinite(tokens) ? tokens : 0))
  const next: Lineage = {
    ...read.lineage,
    branches: read.lineage.branches.map((item) =>
      item.branch === branch ? { ...item, life_tokens_used: used } : item
    )
  }
  return writeLineage(filePath, next)
}
