/**
 * 问记忆 · 本地命令（memory-life M1，2026-10-30）
 *
 * 命令是**一条普通消息**：文本以 `/` 开头就先过这里；命中就在本地执行、回一条文本，
 * 不经过模型、不进问答历史、不计生命、不占 QQ 限流（方案 §6 / §6.2）。
 *
 * M1 只实现「看状态」与「立即备份」两条；`/log /new /use /del /compact` 在 M2/M3，
 * 这里回一句「还没接上」，而不是装成未知命令（用户分得清「没做」和「拼错」）。
 */

import type { ChainAskResult, ChainAskStats } from '../chain/agent/types'
import { readLineage, type LineageRead } from './lineage'
import type { MemoryRepo } from './memory-repo'

export interface ParsedCommand {
  /** 命令名，已转小写（`/HELP` 与 `/help` 一样） */
  name: string
  args: string[]
}

export interface CommandDeps {
  repo: MemoryRepo
  /** 家谱权威文件（仓外） */
  lineageFile: string
  now?: () => number
}

/** 方案里定义过的命令（含未实现的）：用于区分「拼错」与「还没做」 */
export const KNOWN_COMMANDS = ['help', 'log', 'new', 'use', 'del', 'backup', 'compact'] as const

/** M1 真正接上的命令 */
export const READY_COMMANDS = ['help', 'backup'] as const

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const [head, ...args] = trimmed.slice(1).split(/\s+/u)
  const name = (head ?? '').toLowerCase()
  if (name === '') return null
  return { name, args }
}

/** 命令回执：形状与问答复保持一致，界面当一条普通答复显示 */
export function commandResult(text: string): ChainAskResult {
  const stats: ChainAskStats = { hits: 0, evidence: 0, cited: 0, questionChars: 0 }
  return { kind: 'command', text, stats }
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
    '问记忆 · 记忆仓（M1）',
    '',
    '可用命令：',
    '  /help    看这一页',
    '  /backup  立即提交记忆；配了远端就推送',
    '',
    `当前节点：${active}`,
    `记忆仓：${repoLine}`
  ].join('\n')
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

/**
 * 返回处理函数：不是命令 → null（调用方继续走模型）；
 * 是命令 → 一条 `command` 回执（永不出网，除了 /backup 的 git push）。
 */
export function createCommandHandler(deps: CommandDeps): (text: string) => Promise<ChainAskResult | null> {
  const now = deps.now ?? Date.now
  return async (text) => {
    const parsed = parseCommand(text)
    if (parsed === null) return null
    if (!(KNOWN_COMMANDS as readonly string[]).includes(parsed.name)) {
      return commandResult(`未知命令：/${parsed.name}\n发 /help 看看能做什么。`)
    }
    switch (parsed.name) {
      case 'help':
        return commandResult(await helpText(deps))
      case 'backup':
        return commandResult(await backupText(deps, now()))
      default:
        return commandResult(`/${parsed.name} 还没接上（记忆仓 M1 只有 /help 和 /backup）。`)
    }
  }
}
