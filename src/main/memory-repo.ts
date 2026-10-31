/**
 * 记忆仓 · git 封装（memory-life M1，2026-10-30）
 *
 * ta 的记忆是一个本地 git 仓库：`<userData>/memory-repo`。
 * 这一层只做「仓能开、能提交、能推」——
 *
 * - 所有 git 调用都是 **参数数组 + spawn**，不拼 shell 字符串（路径里有空格 / 引号也不会被解释）；
 * - 所有操作**串行**（同一时刻只跑一个 git，避免 index.lock 互踩）；
 * - 每一步都有超时；失败只返回结果对象，**绝不抛给 ask**（记忆坏了不耽误聊天）；
 * - 推送一律 `GIT_TERMINAL_PROMPT=0`：凭据只走系统 git（Credential Manager / gh），
 *   绝不在应用里等一个看不见的密码提示。
 *
 * 仓里放什么由调用方决定（M1：家谱快照 + 会话文件 + 图片二进制）；这里不做内容判断。
 */

import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

export type MemoryRepoLog = (
  level: 'info' | 'warn',
  message: string,
  data?: Record<string, unknown>
) => void

export interface GitRunResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  /** 进程没起来（ENOENT / 超时等），与「git 跑完但失败」区分 */
  error?: string
}

export interface GitRunOptions {
  timeoutMs?: number
  /** 输出上限（字符）；超出只保留前 N 个，防止 `git log -p` 把内存吃满（`/git` 用） */
  maxOutput?: number
}

/** 可注入的 git 执行器：测试用来模拟「没装 git」或固定回执 */
export type GitRunner = (args: readonly string[], options?: GitRunOptions) => Promise<GitRunResult>

export type MemoryRepoStatus =
  | {
      ok: true
      root: string
      branch: string
      head: string | null
      dirty: boolean
    }
  | {
      ok: false
      root: string
      reason: 'git-missing' | 'init-failed' | 'broken'
      detail?: string
    }

export interface MemoryCommitResult {
  committed: boolean
  reason?: 'clean' | 'already' | 'unavailable' | 'failed'
  hash?: string
  detail?: string
}

export interface MemoryPushResult {
  ok: boolean
  reason?: 'no-remote' | 'unavailable' | 'failed'
  detail?: string
}

/** 当前 HEAD（M2）：分支名 / 是否 detached / 短 sha；空仓时 sha 为 null */
export interface MemoryHead {
  branch: string | null
  detached: boolean
  sha: string | null
}

export type MemorySwitchReason =
  | 'unavailable'
  | 'dirty'
  | 'not-found'
  | 'exists'
  | 'invalid'
  | 'current'
  | 'failed'

export interface MemorySwitchResult {
  ok: boolean
  reason?: MemorySwitchReason
  detail?: string
  /** 切换成功后的 HEAD */
  head?: MemoryHead
}

/** 本地分支一览（`/log` 用）：最近一次提交的主题与时间 */
export interface MemoryBranchInfo {
  branch: string
  sha: string
  subject: string
  /** 最近提交时间（毫秒）；读不到为 0 */
  at: number
}

export interface MemoryBranchCommit {
  hash: string
  subject: string
  at: number
}

export interface MemoryRepo {
  readonly root: string
  /** 确认 / 建立仓（幂等；结果缓存在进程内） */
  ensure(): Promise<MemoryRepoStatus>
  /** 当前实况（分支 / HEAD / 是否脏） */
  status(): Promise<MemoryRepoStatus>
  /** `add -A` + 有变化才提交 */
  commit(message: string): Promise<MemoryCommitResult>
  /** 一天一个提交：最后一次提交已经是今天就不动（即使有未提交的小改动） */
  commitDay(day: string): Promise<MemoryCommitResult>
  /** 配了 origin 才推；没配 / 失败都只返回原因，不抛错 */
  push(): Promise<MemoryPushResult>
  lastCommit(): Promise<{ hash: string; subject: string } | null>
  /** 仓内写文件（自动建目录；拒绝跳出仓根的路径）；返回是否写成功 */
  writeFile(relativePath: string, content: string): Promise<boolean>
  /** 读仓内文本；不存在 / 读失败返回 null */
  readFile(relativePath: string): Promise<string | null>
  /** 删仓内文件（不存在也算成功） */
  deleteFile(relativePath: string): Promise<boolean>
  /**
   * 清掉 `conversations/` 里的会话与图片资产（保留 `.gitkeep`）：
   * D74 的「新会话从空白开始」= 先分叉再清空，调用方随后提交。
   */
  clearConversations(): Promise<boolean>

  /* ---- M2 节点（分支）操作 ---- */

  /** 当前 HEAD：分支 / 是否 detached / 短 sha */
  head(): Promise<MemoryHead>
  /** 切分支；工作区有未提交改动就拒绝（调用方先 commit） */
  switchBranch(name: string): Promise<MemorySwitchResult>
  /** 从当前 HEAD 开新分支并切过去；名字已存在就 exists */
  switchCreate(name: string): Promise<MemorySwitchResult>
  /**
   * 从**空树**开一条 orphan 分支并切过去（M4 传承：女儿从空白开始）。
   * 会清掉工作区里的旧文件，只留脚手架；调用方必须先把母亲节点提交干净。
   */
  switchCreateOrphan(name: string): Promise<MemorySwitchResult>
  /** 切到历史提交（detached）；不存在就 not-found */
  checkoutCommit(ref: string): Promise<MemorySwitchResult>
  /** 删分支；当前分支 / 不存在分开报（「有后代不许删」由家谱层拦） */
  deleteBranch(name: string): Promise<MemorySwitchResult>
  /** 本地分支列表（按名字排序） */
  listBranches(): Promise<MemoryBranchInfo[]>
  /** 某个分支最近几条提交（默认 5 条） */
  branchLog(name: string, limit?: number): Promise<MemoryBranchCommit[]>
  /**
   * 两个 ref 的最近公共祖先（完整 sha；`/log <节点>` 拿它当分叉点，D77）。
   * 没有共同祖先 / 读不出来返回 null。
   */
  mergeBase(a: string, b: string): Promise<string | null>
  /** 某个 ref 的提交数（`/log <节点>` 分页用）；读不出来返回 0 */
  commitCount(ref: string): Promise<number>
  /**
   * 在记忆仓里跑原生命令（`/git`，D78）：argv 直传、**不经过 shell**、不弹凭据；
   * 输出截到 200k 字符，避免 `git log -p` 之类把内存吃满。
   */
  git(args: readonly string[]): Promise<GitRunResult>
  /** 短 sha → 验证并解析；不存在返回 null */
  revParse(ref: string): Promise<string | null>
}

const DEFAULT_GIT_TIMEOUT_MS = 20_000
const PUSH_TIMEOUT_MS = 60_000
/** 仓初始化时写的最小脚手架（首提不能是空仓） */
const GITATTRIBUTES = [
  '# 记忆仓：统一 LF；对话 / 二进制不做行尾转换',
  '* text=auto eol=lf',
  'conversations/** -text',
  '*.png binary',
  '*.jpg binary',
  '*.jpeg binary',
  '*.webp binary',
  '*.gif binary',
  ''
].join('\n')
const SCAFFOLD_DIRS = ['conversations', 'letters', 'notes'] as const

function spawnGit(cwd: string): GitRunner {
  return (args, options = {}) =>
    new Promise<GitRunResult>((done) => {
      let settled = false
      let stdout = ''
      let stderr = ''
      const finish = (result: GitRunResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        done(result)
      }
      let child: ReturnType<typeof spawn>
      try {
        child = spawn('git', [...args], {
          cwd,
          windowsHide: true,
          env: {
            ...process.env,
            // 绝不弹凭据输入：没有可用凭据就让这次失败
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never',
            GIT_PAGER: 'cat'
          }
        })
      } catch (error) {
        done({ ok: false, code: null, stdout: '', stderr: '', error: String(error) })
        return
      }
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          // 已经退出
        }
        finish({ ok: false, code: null, stdout, stderr, error: 'timeout' })
      }, options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS)

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      const cap = options.maxOutput ?? 0
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
        if (cap > 0 && stdout.length > cap) stdout = stdout.slice(0, cap)
      })
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk
        if (cap > 0 && stderr.length > cap) stderr = stderr.slice(0, cap)
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        finish({
          ok: false,
          code: null,
          stdout,
          stderr,
          error: error.code ?? String(error)
        })
      })
      child.on('close', (code) => {
        finish({ ok: code === 0, code, stdout, stderr })
      })
    })
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

export function createMemoryRepo(options: {
  root: string
  runGit?: GitRunner
  log?: MemoryRepoLog
}): MemoryRepo {
  const root = resolve(options.root)
  const run = options.runGit ?? spawnGit(root)
  const log = options.log

  /** 同一时刻只跑一个 git：前一个失败也继续排队 */
  let tail: Promise<unknown> = Promise.resolve()
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = tail.then(task, task)
    tail = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  const insideRoot = (relativePath: string): string | null => {
    if (relativePath.trim() === '') return null
    const target = resolve(root, relativePath)
    if (target !== root && !target.startsWith(root + sep)) return null
    return target
  }

  const writeInner = async (relativePath: string, content: string): Promise<boolean> => {
    const target = insideRoot(relativePath)
    if (target === null) return false
    try {
      await mkdir(dirname(target), { recursive: true })
      // 先写临时文件再换名：半截文件不会被当成合法快照 / 会话
      const tmp = `${target}.tmp`
      await writeFile(tmp, content, 'utf8')
      await rename(tmp, target)
      return true
    } catch (error) {
      log?.('warn', 'memory repo write failed', { error: String(error) })
      return false
    }
  }

  const lastCommitInner = async (): Promise<{ hash: string; subject: string } | null> => {
    const result = await run(['--no-pager', 'log', '-1', '--format=%H%n%s'])
    if (!result.ok) return null
    const [hash = '', subject = ''] = result.stdout.split('\n')
    if (hash.trim() === '') return null
    return { hash: hash.trim(), subject: subject.trim() }
  }

  /* ---- M2：节点（分支）操作 ---- */

  const headInner = async (): Promise<MemoryHead> => {
    // 空仓时 symbolic-ref 仍返回分支名（HEAD 指向还没出生的分支），rev-parse 才失败
    const symbolic = await run(['symbolic-ref', '--short', '-q', 'HEAD'])
    const shaResult = await run(['rev-parse', '--short', 'HEAD'])
    const sha = shaResult.ok && shaResult.stdout.trim() !== '' ? shaResult.stdout.trim() : null
    return symbolic.ok && symbolic.stdout.trim() !== ''
      ? { branch: symbolic.stdout.trim(), detached: false, sha }
      : { branch: null, detached: true, sha }
  }

  /** 读不出状态也按「脏」处理：宁可不切，也不在状态不明时动工作区 */
  const isDirty = async (): Promise<boolean> => {
    const porcelain = await run(['status', '--porcelain'])
    return !porcelain.ok || porcelain.stdout.trim() !== ''
  }

  const classifySwitchError = (detail: string): MemorySwitchReason => {
    const text = detail.toLowerCase()
    if (text.includes('already exists')) return 'exists'
    if (text.includes('is not a valid branch name')) return 'invalid'
    if (text.includes('not a valid object name') || text.includes('unknown revision')) return 'not-found'
    if (
      text.includes('did not match any file') ||
      text.includes('pathspec') ||
      text.includes('not found')
    ) {
      return 'not-found'
    }
    if (text.includes('would be overwritten') || text.includes('your local changes')) return 'dirty'
    return 'failed'
  }

  /** checkout 类操作的共同前置：仓可用 + 工作区干净 */
  const switchInner = async (args: readonly string[]): Promise<MemorySwitchResult> => {
    const status = await ensure()
    if (!status.ok) return { ok: false, reason: 'unavailable' }
    if (await isDirty()) return { ok: false, reason: 'dirty', detail: '工作区有未提交改动' }
    const result = await run([...args])
    if (!result.ok) {
      const detail = firstLine(result.stderr) || firstLine(result.stdout)
      return { ok: false, reason: classifySwitchError(detail), detail }
    }
    return { ok: true, head: await headInner() }
  }

  /**
   * orphan 分支（M4 传承）：从空树开一条没有任何父提交的分支。
   * `checkout --orphan` 只换 HEAD，旧文件还留在索引里；必须再 `git rm -rf .` 清空，
   * 然后写回脚手架（`.gitattributes` 等）——否则女儿的仓会带母亲的会话文件。
   */
  const orphanInner = async (name: string): Promise<MemorySwitchResult> => {
    const status = await ensure()
    if (!status.ok) return { ok: false, reason: 'unavailable' }
    if (await isDirty()) return { ok: false, reason: 'dirty', detail: '工作区有未提交改动' }
    const created = await run(['checkout', '--orphan', name])
    if (!created.ok) {
      const detail = firstLine(created.stderr) || firstLine(created.stdout)
      return { ok: false, reason: classifySwitchError(detail), detail }
    }
    const cleared = await run(['rm', '-rf', '--ignore-unmatch', '.'])
    if (!cleared.ok) {
      return { ok: false, reason: 'failed', detail: firstLine(cleared.stderr) }
    }
    if (!(await scaffoldInner())) return { ok: false, reason: 'failed', detail: 'scaffold failed' }
    return { ok: true, head: await headInner() }
  }

  const checkoutCommitInner = async (ref: string): Promise<MemorySwitchResult> => {
    const status = await ensure()
    if (!status.ok) return { ok: false, reason: 'unavailable' }
    const resolved = await run(['rev-parse', '--short', '--verify', `${ref}^{commit}`])
    if (!resolved.ok || resolved.stdout.trim() === '') {
      return { ok: false, reason: 'not-found', detail: `没找到提交 ${ref}` }
    }
    const sha = resolved.stdout.trim()
    if (await isDirty()) return { ok: false, reason: 'dirty', detail: '工作区有未提交改动' }
    const result = await run(['checkout', '--detach', sha])
    if (!result.ok) {
      const detail = firstLine(result.stderr) || firstLine(result.stdout)
      return { ok: false, reason: classifySwitchError(detail), detail }
    }
    return { ok: true, head: await headInner() }
  }

  const deleteBranchInner = async (name: string): Promise<MemorySwitchResult> => {
    const status = await ensure()
    if (!status.ok) return { ok: false, reason: 'unavailable' }
    const head = await headInner()
    if (head.branch !== null && head.branch === name) {
      return { ok: false, reason: 'current', detail: '不能删除当前所在的分支' }
    }
    const result = await run(['branch', '-D', name])
    if (!result.ok) {
      const detail = firstLine(result.stderr) || firstLine(result.stdout)
      if (detail.toLowerCase().includes('not found')) return { ok: false, reason: 'not-found', detail }
      return { ok: false, reason: 'failed', detail }
    }
    return { ok: true }
  }

  const listBranchesInner = async (): Promise<MemoryBranchInfo[]> => {
    const status = await ensure()
    if (!status.ok) return []
    const result = await run([
      'for-each-ref',
      '--format=%(refname:short)%00%(objectname:short)%00%(subject)%00%(committerdate:unix)',
      'refs/heads'
    ])
    if (!result.ok) return []
    const out: MemoryBranchInfo[] = []
    for (const line of result.stdout.split('\n')) {
      if (line === '') continue
      const [branch = '', sha = '', subject = '', at = '0'] = line.split('\0')
      if (branch === '' || sha === '') continue
      out.push({
        branch,
        sha,
        subject,
        at: Number(at) > 0 ? Number(at) * 1000 : 0
      })
    }
    return out.sort((a, b) => a.branch.localeCompare(b.branch))
  }

  const branchLogInner = async (name: string, limit: number): Promise<MemoryBranchCommit[]> => {
    const status = await ensure()
    if (!status.ok) return []
    const result = await run(['log', name, `-n${Math.max(1, limit)}`, '--format=%h%x00%s%x00%ct'])
    if (!result.ok) return []
    const out: MemoryBranchCommit[] = []
    for (const line of result.stdout.split('\n')) {
      if (line === '') continue
      const [hash = '', subject = '', at = '0'] = line.split('\0')
      if (hash === '') continue
      out.push({ hash, subject, at: Number(at) > 0 ? Number(at) * 1000 : 0 })
    }
    return out
  }

  const mergeBaseInner = async (a: string, b: string): Promise<string | null> => {
    const status = await ensure()
    if (!status.ok) return null
    const result = await run(['merge-base', a, b])
    if (!result.ok) return null
    const sha = result.stdout.trim()
    return sha === '' ? null : sha
  }

  const commitCountInner = async (ref: string): Promise<number> => {
    const status = await ensure()
    if (!status.ok) return 0
    const result = await run(['rev-list', '--count', ref])
    if (!result.ok) return 0
    const count = Number(result.stdout.trim())
    return Number.isFinite(count) && count > 0 ? count : 0
  }

  const gitInner = async (args: readonly string[]): Promise<GitRunResult> => {
    const status = await ensure()
    if (!status.ok) {
      return { ok: false, code: null, stdout: '', stderr: '', error: status.reason }
    }
    return run([...args], { maxOutput: 200_000 })
  }

  const revParseInner = async (ref: string): Promise<string | null> => {
    const status = await ensure()
    if (!status.ok) return null
    const result = await run(['rev-parse', '--short', '--verify', `${ref}^{commit}`])
    if (!result.ok || result.stdout.trim() === '') return null
    return result.stdout.trim()
  }

  /**
   * 清 `conversations/`（只留 `.gitkeep`）：新会话分支先分叉再清空，
   * 图上是真分支、上下文是空的。删除只发生在工作区，提交由调用方做。
   */
  const clearConversationsInner = async (): Promise<boolean> => {
    const dir = resolve(root, 'conversations')
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === '.gitkeep') continue
        await rm(resolve(dir, entry.name), { recursive: true, force: true })
      }
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      log?.('warn', 'memory conversations clear failed', { error: String(error) })
      return false
    }
  }

  const ensureIdentity = async (): Promise<void> => {
    const email = await run(['config', '--get', 'user.email'])
    if (email.ok && email.stdout.trim() !== '') return
    // 没有全局身份时只给这个仓兜底，不改用户的 git 配置
    await run(['config', 'user.name', 'Gotcha'])
    await run(['config', 'user.email', 'gotcha@local'])
  }

  /** 仓脚手架（`.gitattributes` / `.gitignore` / 三个目录占位）；init 与 orphan 分支共用 */
  const scaffoldInner = async (): Promise<boolean> => {
    try {
      for (const dir of SCAFFOLD_DIRS) {
        await mkdir(resolve(root, dir), { recursive: true })
        const keep = resolve(root, dir, '.gitkeep')
        if (!existsSync(keep)) await writeFile(keep, '', 'utf8')
      }
      await writeFile(resolve(root, '.gitattributes'), GITATTRIBUTES, 'utf8')
      // 半截写入留下的 .tmp 不入库（正常路径 rename 后就没了）
      await writeFile(resolve(root, '.gitignore'), '*.tmp\n', 'utf8')
      return true
    } catch (error) {
      log?.('warn', 'memory repo scaffold failed', { error: String(error) })
      return false
    }
  }

  const ensureInner = async (): Promise<MemoryRepoStatus> => {
    try {
      await mkdir(root, { recursive: true })
    } catch (error) {
      return { ok: false, root, reason: 'init-failed', detail: String(error) }
    }

    const version = await run(['--version'])
    if (!version.ok) {
      const reason = version.error === 'ENOENT' ? 'git-missing' : 'init-failed'
      return { ok: false, root, reason, detail: version.error ?? firstLine(version.stderr) }
    }

    const gitDir = resolve(root, '.git')
    if (!existsSync(gitDir)) {
      const init = await run(['init', '-b', 'default'])
      if (!init.ok) {
        // 老 git 不认 -b：退回 init + 改 HEAD
        const fallback = await run(['init'])
        if (!fallback.ok) {
          return { ok: false, root, reason: 'init-failed', detail: firstLine(init.stderr) }
        }
        await run(['symbolic-ref', 'HEAD', 'refs/heads/default'])
      }
      await scaffoldInner()
      await ensureIdentity()
      // 首提：有脚手架才能提交；失败也不判定整个仓不可用（后面的 /backup 会再试）
      const add = await run(['add', '-A'])
      if (add.ok) {
        const commit = await run(['commit', '-m', 'memory: init', '--no-verify'])
        if (!commit.ok) {
          log?.('warn', 'memory repo init commit failed', { detail: firstLine(commit.stderr) })
        }
      }
    }

    const inside = await run(['rev-parse', '--is-inside-work-tree'])
    if (!inside.ok || inside.stdout.trim() !== 'true') {
      return { ok: false, root, reason: 'broken', detail: firstLine(inside.stderr) }
    }
    return readStatus()
  }

  const readStatus = async (): Promise<MemoryRepoStatus> => {
    // 首次提交之前 `rev-parse HEAD` 会失败，但分支名仍然有：先用 symbolic-ref
    const symbolic = await run(['symbolic-ref', '--short', 'HEAD'])
    const branch =
      symbolic.ok && symbolic.stdout.trim() !== ''
        ? symbolic.stdout.trim()
        : (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
    if (branch === '') {
      return { ok: false, root, reason: 'broken', detail: firstLine(symbolic.stderr) }
    }
    const head = await run(['rev-parse', '--short', 'HEAD'])
    const porcelain = await run(['status', '--porcelain'])
    if (!porcelain.ok) {
      return { ok: false, root, reason: 'broken', detail: firstLine(porcelain.stderr) }
    }
    return {
      ok: true,
      root,
      branch: branch === 'HEAD' ? 'HEAD' : branch,
      head: head.ok && head.stdout.trim() !== '' ? head.stdout.trim() : null,
      dirty: porcelain.stdout.trim() !== ''
    }
  }

  let ensured: Promise<MemoryRepoStatus> | null = null
  const ensure = (): Promise<MemoryRepoStatus> => {
    ensured ??= ensureInner()
    return ensured
  }

  const commitInner = async (message: string): Promise<MemoryCommitResult> => {
    const add = await run(['add', '-A'])
    if (!add.ok) {
      return { committed: false, reason: 'failed', detail: firstLine(add.stderr) }
    }
    const changed = await run(['status', '--porcelain'])
    if (!changed.ok) {
      return { committed: false, reason: 'failed', detail: firstLine(changed.stderr) }
    }
    if (changed.stdout.trim() === '') return { committed: false, reason: 'clean' }

    let commit = await run(['commit', '-m', message, '--no-verify'])
    // index.lock 是外部 git（用户自己开着仓）常见的瞬时冲突：稍等再试一次
    if (!commit.ok && commit.stderr.includes('index.lock')) {
      await new Promise((done) => setTimeout(done, 300))
      commit = await run(['commit', '-m', message, '--no-verify'])
    }
    if (!commit.ok) {
      const detail = firstLine(commit.stderr)
      if (detail.includes('nothing to commit')) return { committed: false, reason: 'clean' }
      return { committed: false, reason: 'failed', detail }
    }
    const hash = await run(['rev-parse', '--short', 'HEAD'])
    return {
      committed: true,
      ...(hash.ok && hash.stdout.trim() !== '' ? { hash: hash.stdout.trim() } : {})
    }
  }

  return {
    root,
    ensure,
    status: () =>
      exclusive(async () => {
        const status = await ensure()
        if (!status.ok) return status
        return readStatus()
      }),
    commit: (message) =>
      exclusive(async () => {
        const status = await ensure()
        if (!status.ok) return { committed: false, reason: 'unavailable' }
        return commitInner(message)
      }),
    commitDay: (day) =>
      exclusive(async () => {
        const status = await ensure()
        if (!status.ok) return { committed: false, reason: 'unavailable' }
        const last = await lastCommitInner()
        // 今天已经提交过就不动：一天一个提交，中途的小改动留给 /backup 或明天
        if (last !== null && last.subject === `memory: ${day}`) {
          return { committed: false, reason: 'already' }
        }
        return commitInner(`memory: ${day}`)
      }),
    push: () =>
      exclusive(async () => {
        const status = await ensure()
        if (!status.ok) return { ok: false, reason: 'unavailable' }
        const remote = await run(['remote', 'get-url', 'origin'])
        if (!remote.ok || remote.stdout.trim() === '') return { ok: false, reason: 'no-remote' }
        const pushed = await run(['push', 'origin', 'HEAD'], { timeoutMs: PUSH_TIMEOUT_MS })
        if (!pushed.ok) {
          return { ok: false, reason: 'failed', detail: firstLine(pushed.stderr) }
        }
        return { ok: true }
      }),
    lastCommit: () => exclusive(lastCommitInner),
    writeFile: (relativePath, content) => exclusive(() => writeInner(relativePath, content)),
    readFile: async (relativePath) => {
      const target = insideRoot(relativePath)
      if (target === null) return null
      try {
        return await readFile(target, 'utf8')
      } catch {
        return null
      }
    },
    deleteFile: (relativePath) =>
      exclusive(async () => {
        const target = insideRoot(relativePath)
        if (target === null) return false
        try {
          await unlink(target)
          return true
        } catch (error) {
          // 不存在也算成功（重复清理不该报错）
          return (error as NodeJS.ErrnoException).code === 'ENOENT'
        }
      }),
    head: () => exclusive(headInner),
    switchBranch: (name) => exclusive(() => switchInner(['checkout', name])),
    switchCreate: (name) => exclusive(() => switchInner(['checkout', '-b', name])),
    switchCreateOrphan: (name) => exclusive(() => orphanInner(name)),
    checkoutCommit: (ref) => exclusive(() => checkoutCommitInner(ref)),
    deleteBranch: (name) => exclusive(() => deleteBranchInner(name)),
    listBranches: () => exclusive(listBranchesInner),
    branchLog: (name, limit = 5) => exclusive(() => branchLogInner(name, limit)),
    mergeBase: (a, b) => exclusive(() => mergeBaseInner(a, b)),
    commitCount: (ref) => exclusive(() => commitCountInner(ref)),
    git: (args) => exclusive(() => gitInner(args)),
    clearConversations: () => exclusive(clearConversationsInner),
    revParse: (ref) => exclusive(() => revParseInner(ref))
  }
}
