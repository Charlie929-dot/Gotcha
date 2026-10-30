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
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
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
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk
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

  const ensureIdentity = async (): Promise<void> => {
    const email = await run(['config', '--get', 'user.email'])
    if (email.ok && email.stdout.trim() !== '') return
    // 没有全局身份时只给这个仓兜底，不改用户的 git 配置
    await run(['config', 'user.name', 'Gotcha'])
    await run(['config', 'user.email', 'gotcha@local'])
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
      for (const dir of SCAFFOLD_DIRS) {
        await mkdir(resolve(root, dir), { recursive: true })
        const keep = resolve(root, dir, '.gitkeep')
        if (!existsSync(keep)) await writeFile(keep, '', 'utf8')
      }
      await writeFile(resolve(root, '.gitattributes'), GITATTRIBUTES, 'utf8')
      // 半截写入留下的 .tmp 不入库（正常路径 rename 后就没了）
      await writeFile(resolve(root, '.gitignore'), '*.tmp\n', 'utf8')
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
      })
  }
}
