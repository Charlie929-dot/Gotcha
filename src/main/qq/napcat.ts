/**
 * QQ 通道 · NapCat 托管（D66）
 *
 * 目标只有一个：**不再手动开 NapCat、不再手抄二维码**。
 * Gotcha 负责找（或装）NapCat、拉起进程、把二维码显示在设置抽屉、登录后把
 * OneBot「反向 WS」配置写进去，让 NapCat 自己拨回 `ws://127.0.0.1:<port>`。
 *
 * 关键事实（2026-10-30 在本机核过）：
 * - NapCat 不是库，不能跑在 Gotcha 进程里：它是注入 QQNT 的插件，由
 *   `NapCatWinBootMain.exe <QQ.exe> <NapCatWinBootHook.dll>` 拉起。这里做的是**进程托管**。
 * - 二维码：NapCat 登录前会写 `<shell>/cache/qrcode.png`；登录状态与 OneBot 配置走
 *   NapCat WebUI（`config/webui.json` 里的 token，登录后拿 Credential）。
 * - OneBot 配置（`config/onebot11_<uin>.json`）可以通过 WebUI 的
 *   `/api/OB11Config/SetConfig` **热更新**，不需要重启 NapCat。
 * - 退出 Gotcha 不结束 QQ/NapCat（拍板 2026-10-30）：只清自己的轮询；「停止」也
 *   只结束 Gotcha 自己拉起的进程，绝不 taskkill 用户手动开的 QQ。
 *
 * 纪律：
 * - token / WebUI 凭据只在本机内存里用，**绝不进日志**；
 * - 下载只走 GitHub Releases（https），解压用系统 `tar`（失败回退 PowerShell），
 *   路径做白名单校验，不执行压缩包里的任何脚本；
 * - 网络 / 进程状态都如实回界面，失败给可读原因，不静默降级。
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import type { QqLog } from './ob11'

const execFileAsync = promisify(execFile)

/** NapCat Shell 目录里必须存在的文件（缺一个就认为不是可用安装） */
export const NAPCAT_REQUIRED_FILES = [
  'NapCatWinBootMain.exe',
  'NapCatWinBootHook.dll',
  'napcat.mjs',
  'qqnt.json',
  'loadNapCat.js'
] as const

/** NapCat 登录二维码相对 Shell 目录的位置 */
export const NAPCAT_QRCODE_REL = join('cache', 'qrcode.png')
/**
 * 二维码票的有效期（约 2 分钟，留一点余量）：比这还旧的图不算数。
 * NapCat 停在登录页时自己也会隔约 2 分钟重写一次 `cache/qrcode.png`（2026-11-04 实测：Gotcha
 * 轮询停掉后文件 mtime 仍在走），所以这里只按新鲜度判；主动刷新是兜底，不是唯一来源。
 */
export const NAPCAT_QR_MAX_AGE_MS = 110_000
/**
 * 等 WebUI 的宽限期：NapCat 刚拉起时 WebUI 要几十秒才起。
 * 过了宽限只报可读原因、**不停止轮询**——NapCat / QQ 重启后要能自己接回来（2026-11-04 真机）。
 */
export const NAPCAT_WEBUI_GRACE_MS = 60_000
/** WebUI 默认端口（config/webui.json 里通常也是 6099） */
export const NAPCAT_DEFAULT_WEBUI_PORT = 6099
/** 下载包名（官方 Releases 里的 Windows Shell 包） */
export const NAPCAT_SHELL_ASSET = 'NapCat.Shell.zip'
const NAPCAT_RELEASE_API = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest'
const NAPCAT_LATEST_DOWNLOAD = `https://github.com/NapNeko/NapCatQQ/releases/latest/download/${NAPCAT_SHELL_ASSET}`

export type NapcatPhase =
  | 'idle'
  | 'downloading'
  | 'installing'
  | 'starting'
  | 'waiting-login'
  | 'connected'
  | 'error'

export interface NapcatEndpoint {
  port: number
  token: string
}

export interface NapcatView {
  phase: NapcatPhase
  /** Shell 目录是否可用（决定界面显示「启动」还是「下载并安装」） */
  installed: boolean
  /** 是否随 Gotcha 启动自动拉起 */
  autoStart: boolean
  shellDir?: string
  qqPath?: string
  /** 登录二维码（data URL；登录后不再给） */
  qrDataUrl?: string
  qrAt?: number
  /** 下载进度 0–1 */
  progress?: number
  loggedIn: boolean
  uin?: string
  /** 可读的失败原因 */
  error?: string
}

export interface NapcatDeps {
  userDataDir: string
  /** 现在 QQ 通道监听在哪个端口、用哪个 token（与 WebUI 配置保持一致） */
  getEndpoint: () => NapcatEndpoint
  /** QQ 通道是否已有 NapCat 拨入（`qqChannel.status().connections > 0`） */
  isConnected: () => boolean
  getAutoStart: () => boolean
  /** 手动指定的 Shell 目录（设置里选的） */
  getShellDir: () => string
  setShellDir: (dir: string) => void
  log: QqLog
  /** 掉线提醒（托盘气泡等）：只在「本来在线 → 掉了」时调一次；没注入就静默 */
  notify?: (title: string, content: string) => void
  now?: () => number
  /** 测试替换：进程 / 网络 / 系统查询 */
  isBootmainRunning?: () => Promise<boolean>
  /** QQ 是否已在运行（NapCat 必须自己拉起 QQ，已在运行就没法注入） */
  isQqRunning?: () => Promise<boolean>
  /** 测试替换：找 QQ 安装路径 */
  resolveQqPath?: (manualPath?: string) => Promise<string | null>
  spawnImpl?: typeof spawn
  fetchImpl?: typeof fetch
}

/** WebUI 配置（只取托管要用的三个字段） */
export interface NapcatWebuiConfig {
  port: number
  token: string
}

/** 把 NapCat 的 token 变成 WebUI 登录用的 hash（NapCat 的约定：sha256(token + ".napcat")） */
export function napcatTokenHash(token: string): string {
  return createHash('sha256').update(`${token}.napcat`, 'utf8').digest('hex')
}

/** `config/webui.json` → 托管要用的端口 / token；不合法返回 null */
export function parseWebuiConfig(raw: string): NapcatWebuiConfig | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    const port = Number(record['port'])
    const token = typeof record['token'] === 'string' ? record['token'].trim() : ''
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
    if (token === '') return null
    return { port, token }
  } catch {
    return null
  }
}

/**
 * 二维码是不是已经旧到不能再显示（旧了就该让 NapCat 换一张）。
 * `qrAt === null`（还没拿到码）也算「该刷新」。
 */
export function qrExpired(qrAt: number | null, now: number): boolean {
  return qrAt === null || now - qrAt > NAPCAT_QR_MAX_AGE_MS
}

/** 图片字节 → `data:image/png;base64,…`（只认 PNG；NapCat 写的二维码就是 PNG） */
export function qrcodeDataUrl(bytes: Uint8Array): string | null {
  if (bytes.length < 8) return null
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  if (!png) return null
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
}

export interface OneBotConfigMerge {
  config: Record<string, unknown>
  /** 是否真的改动了（没改就别发 SetConfig，免得白重连一次） */
  changed: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function sameClient(entry: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return (
    entry['name'] === expected['name'] &&
    entry['enable'] === expected['enable'] &&
    entry['url'] === expected['url'] &&
    entry['token'] === expected['token'] &&
    entry['messagePostFormat'] === expected['messagePostFormat'] &&
    entry['reportSelfMessage'] === expected['reportSelfMessage'] &&
    entry['heartInterval'] === expected['heartInterval'] &&
    entry['reconnectInterval'] === expected['reconnectInterval']
  )
}

/**
 * 把 Gotcha 的 `ws://127.0.0.1:<port>` + token 合并进 NapCat 的 OneBot 配置：
 * - 只动 `network.websocketClients` 里名为 `gotcha` 的一项，其它客户端 / 服务端原样保留；
 * - 字段与启动器写的口径一致（数组消息、30s 心跳、3s 重连）。
 */
export function mergeOneBotConfig(raw: unknown, endpoint: NapcatEndpoint): OneBotConfigMerge {
  const config = JSON.parse(JSON.stringify(raw ?? {})) as Record<string, unknown>
  const network = asRecord(config['network']) ?? {}
  config['network'] = network

  const list = Array.isArray(network['websocketClients'])
    ? (network['websocketClients'] as unknown[])
    : []
  const expected: Record<string, unknown> = {
    name: 'gotcha',
    enable: true,
    url: `ws://127.0.0.1:${endpoint.port}`,
    reportSelfMessage: false,
    messagePostFormat: 'array',
    token: endpoint.token,
    debug: false,
    heartInterval: 30_000,
    reconnectInterval: 3_000
  }

  let changed = false
  const next: unknown[] = []
  let seen = false
  for (const item of list) {
    const entry = asRecord(item)
    if (entry && entry['name'] === 'gotcha') {
      if (seen) {
        // 重名只留一条（第一处原位替换，后面的丢弃）
        changed = true
        continue
      }
      seen = true
      if (sameClient(entry, expected)) {
        next.push(entry)
      } else {
        next.push({ ...entry, ...expected })
        changed = true
      }
      continue
    }
    next.push(item)
  }
  if (!seen) {
    next.push(expected)
    changed = true
  }
  if (next.length !== list.length) changed = true

  network['websocketClients'] = next
  return { config, changed }
}

/** 判断一个目录是不是可用的 NapCat Shell */
export async function isNapcatDir(dir: string): Promise<boolean> {
  if (dir.trim() === '') return false
  try {
    for (const name of NAPCAT_REQUIRED_FILES) {
      const info = await stat(join(dir, name))
      if (!info.isFile()) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * 候选根目录（按优先级）：设置里手选的由调用方先试；
 * 这里覆盖「Gotcha 自己装的」「NapCat OneKey 默认位置」「常见盘符」。
 */
export function napcatCandidateRoots(userDataDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const out = [join(userDataDir, 'napcat')]
  const localAppData = (env['LOCALAPPDATA'] ?? '').trim()
  const userProfile = (env['USERPROFILE'] ?? '').trim()
  if (localAppData !== '') out.push(join(localAppData, 'NapCat'))
  if (userProfile !== '') out.push(join(userProfile, 'NapCat'))
  out.push('C:\\NapCat', 'D:\\NapCat')
  return out
}

async function childDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

/**
 * 在一个根目录下找 Shell：根本身 → 根/OneKey/* → 根/* → 根/*（再下一层，覆盖
 * `D:\NapCat\OneKey\NapCat.52230.Shell` 与 `%userData%\napcat\v4.x\...` 两种形态）。
 */
async function findUnderRoot(root: string, depth: number): Promise<string | null> {
  if (await isNapcatDir(root)) return root
  if (depth <= 0) return null
  for (const child of await childDirs(root)) {
    const hit = await findUnderRoot(child, depth - 1)
    if (hit !== null) return hit
  }
  return null
}

/** 自动探测 NapCat Shell 目录（手选目录优先） */
export async function findNapcatDir(
  manualDir: string,
  userDataDir: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (manualDir.trim() !== '' && (await isNapcatDir(manualDir))) return manualDir
  for (const root of napcatCandidateRoots(userDataDir, env)) {
    const hit = await findUnderRoot(root, 2)
    if (hit !== null) return hit
  }
  return null
}

/** 从注册表 UninstallString 推 QQ.exe；失败回常见路径 */
export async function resolveQqPath(manualPath = ''): Promise<string | null> {
  if (manualPath.trim() !== '') {
    return (await isFile(manualPath)) ? manualPath : null
  }
  const candidates: string[] = []
  try {
    const { stdout } = await execFileAsync(
      'reg',
      [
        'query',
        'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
        '/v',
        'UninstallString'
      ],
      { timeout: 4_000, windowsHide: true }
    )
    const match = /UninstallString\s+REG_SZ\s+(.+)/iu.exec(stdout)
    if (match?.[1] !== undefined) {
      const uninstall = match[1].trim().replace(/^"|"$/gu, '')
      candidates.push(join(dirname(uninstall), 'QQ.exe'))
    }
  } catch {
    // 注册表没有就回落到常见路径
  }
  candidates.push('C:\\Program Files\\QQ.exe', 'C:\\Program Files (x86)\\QQ.exe')
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate
  }
  return null
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function bootmainRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq NapCatWinBootMain.exe', '/NH'],
      { timeout: 4_000, windowsHide: true }
    )
    return /NapCatWinBootMain\.exe/iu.test(stdout)
  } catch {
    return false
  }
}

async function qqRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq QQ.exe', '/NH'],
      { timeout: 4_000, windowsHide: true }
    )
    return /QQ\.exe/iu.test(stdout)
  } catch {
    return false
  }
}

async function killTree(pid: number): Promise<void> {
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      timeout: 10_000,
      windowsHide: true
    })
  } catch {
    // 进程可能已经自己退了
  }
}

interface WebuiResponse {
  code?: number
  data?: unknown
  message?: string
}

/**
 * NapCat 托管器。一个 Gotcha 进程一个实例；只轮询自己需要的几样状态。
 */
export class NapcatManager {
  private readonly now: () => number
  private phase: NapcatPhase = 'idle'
  private shellDir: string | null = null
  private qqPath: string | null = null
  private error: string | null = null
  private qrDataUrl: string | null = null
  private qrAt: number | null = null
  private qrMtime = 0
  /** 只接受这个时刻之后写的二维码（新拉起的进程）；接管已有进程时为 0（按「新鲜度」判断） */
  private qrMinMtime = 0
  private progress: number | null = null
  private loggedIn = false
  private loggedInSince: number | null = null
  private uin: string | null = null
  private childPid: number | null = null
  private ownedProcess = false
  private attachedToExisting = false
  private stopping = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private polling = false
  private webuiPort: number | null = null
  private webuiToken: string | null = null
  private webuiCredential: string | null = null
  private configApplied = false
  private lastConfigAttempt = 0
  private installing = false
  /** 本次 start 的时刻：WebUI 一直不通就按超时收口，别让界面永远停在「启动中」 */
  private startedAt = 0
  private lastPollErrorAt = 0
  /** 这次会话里连上过（用来区分「掉线」和「从没连上」：只有前者值得弹提醒） */
  private wasOnline = false
  /** 本轮掉线已经提醒过；恢复在线后重置，别每 1.5 秒弹一次 */
  private offlineNotified = false
  /** 上一次 WebUI 真的响应成功的时刻（判断「WebUI 掉线」用；start 时置为当前） */
  private lastWebuiOkAt = 0
  /** 当前这条 error 是哪种原因设的：只有 webui 那条会在 WebUI 恢复后自动收掉 */
  private errorKind: 'webui' | 'link' | null = null
  /** 上一次找 NapCat 换二维码的时刻（别每个轮询都调） */
  private lastQrRefreshAt = 0

  constructor(private readonly deps: NapcatDeps) {
    this.now = deps.now ?? Date.now
  }

  /** 启动时探一次（界面开抽屉前就知道有没有装） */
  async locate(): Promise<void> {
    this.shellDir = await findNapcatDir(this.deps.getShellDir(), this.deps.userDataDir)
    this.qqPath = await resolveQqPath()
  }

  status(): NapcatView {
    const shellDir = this.shellDir ?? (this.deps.getShellDir().trim() !== '' ? this.deps.getShellDir() : undefined)
    const view: NapcatView = {
      phase: this.phase,
      installed: this.shellDir !== null,
      autoStart: this.deps.getAutoStart(),
      loggedIn: this.loggedIn
    }
    if (shellDir !== undefined) view.shellDir = shellDir
    if (this.qqPath !== null) view.qqPath = this.qqPath
    if (this.qrDataUrl !== null && !this.loggedIn) {
      view.qrDataUrl = this.qrDataUrl
      if (this.qrAt !== null) view.qrAt = this.qrAt
    }
    if (this.progress !== null) view.progress = this.progress
    if (this.uin !== null) view.uin = this.uin
    if (this.error !== null) view.error = this.error
    return view
  }

  /** 拉起 NapCat（已登录且已连上时直接标 connected，不重复拉进程） */
  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.phase === 'downloading' || this.phase === 'installing') {
      return { ok: false, error: '正在安装 NapCat，等它装完' }
    }
    if (this.deps.isConnected()) {
      this.phase = 'connected'
      this.error = null
      this.loggedIn = true
      return { ok: true }
    }

    const endpoint = this.deps.getEndpoint()
    if (endpoint.token.trim().length < 8) {
      return this.fail('先在下面把 access_token 填好并保存（至少 8 位），NapCat 要拿它拨回来')
    }
    if (this.shellDir === null) await this.locate()
    if (this.shellDir === null) {
      this.phase = 'idle'
      this.error = null
      return { ok: false, error: '没找到 NapCat：点「下载并安装」，或选择已有目录' }
    }

    this.qqPath = this.qqPath ?? (await this.resolveQq())
    if (this.qqPath === null) {
      return this.fail('没找到 QQ：请先安装腾讯 QQ（NapCat 要注入它）')
    }

    // 已经有一个 NapCat 在跑（手动开的 / 上一次 Gotcha 留下的）：接管轮询，不重复拉。
    // 但 bootmain 在跑、QQ 没起来时它是上次启动失败的僵尸：接管只会一直等不到码，
    // 如实报错并把出路说清楚（不 taskkill 用户手动开的进程，D66）。
    if (this.childPid !== null || (await this.bootmainIsRunning())) {
      if (!(await this.isQqRunning())) {
        return this.fail(
          'NapCat 在跑但 QQ 没起来（上次启动失败留下的）：先在任务管理器结束 NapCatWinBootMain.exe，再点「启动」'
        )
      }
      this.ownedProcess = false
      this.attachedToExisting = true
      this.qrMinMtime = 0
      this.startedAt = this.now()
      this.lastWebuiOkAt = this.now()
      this.errorKind = null
      this.phase = 'waiting-login'
      this.error = null
      this.beginPoll()
      return { ok: true }
    }

    // NapCat 必须由它自己拉起 QQ 才能注入；QQ 已经在运行就拉不起来，
    // 以前这里直接 spawn 会留下 bootmain 僵尸、之后每次「启动」都只接管它（2026-11-04 真机）。
    if (await this.isQqRunning()) {
      return this.fail(
        'QQ 已经在运行：NapCat 要自己拉起 QQ 才能注入。先退出 QQ 再点「启动」；QQ 设了开机自启的话建议关掉，免得每次都要手动退'
      )
    }

    this.phase = 'starting'
    this.error = null
    this.progress = null
    this.stopping = false
    this.configApplied = false
    this.startedAt = this.now()
    this.lastWebuiOkAt = this.now()
    this.errorKind = null
    this.lastPollErrorAt = 0
    // 复用旧安装时 cache/qrcode.png 里可能还躺着上一次的码：只认本次启动之后写的
    this.qrMinMtime = this.now() - 5_000
    this.qrMtime = 0
    this.qrDataUrl = null
    try {
      this.spawnNapcat()
    } catch (error) {
      return this.fail(`NapCat 启动失败：${String(error)}`)
    }
    this.beginPoll()
    return { ok: true }
  }

  /** 用户点在设置里「停止」：只结束 Gotcha 自己拉起的进程 */
  async stop(): Promise<void> {
    this.stopping = true
    this.stopPoll()
    const pid = this.childPid
    const owned = this.ownedProcess
    const attached = this.attachedToExisting
    this.childPid = null
    this.ownedProcess = false
    this.attachedToExisting = false
    if (pid !== null && owned) await killTree(pid)
    this.phase = 'idle'
    this.qrDataUrl = null
    this.qrAt = null
    this.qrMtime = 0
    this.loggedIn = false
    this.loggedInSince = null
    this.uin = null
    this.error = attached ? 'NapCat 不是 Gotcha 启动的：已只断开托管，QQ 仍在运行' : null
    this.progress = null
    this.stopping = false
    this.wasOnline = false
    this.offlineNotified = false
    this.errorKind = null
    this.lastWebuiOkAt = 0
  }

  /** Gotcha 退出：只停轮询，不动 NapCat/QQ（拍板：退出不关） */
  dispose(): void {
    this.stopPoll()
  }

  /** 下载并安装到 `<userData>/napcat/NapCat.Shell` */
  async install(): Promise<{ ok: boolean; error?: string }> {
    if (this.installing || this.phase === 'downloading' || this.phase === 'installing') {
      return { ok: false, error: '正在下载 / 安装，等它跑完' }
    }
    this.installing = true
    this.error = null
    this.progress = 0
    try {
      const target = join(this.deps.userDataDir, 'napcat', 'NapCat.Shell')
      if (await isNapcatDir(target)) {
        this.shellDir = target
        this.deps.setShellDir(target)
        this.phase = 'idle'
        this.progress = null
        return { ok: true }
      }

      const downloadDir = join(this.deps.userDataDir, 'napcat', 'download')
      await mkdir(downloadDir, { recursive: true })
      const zipPath = join(downloadDir, NAPCAT_SHELL_ASSET)
      const url = await this.latestDownloadUrl()

      this.phase = 'downloading'
      await this.download(url, zipPath)
      this.phase = 'installing'
      await mkdir(target, { recursive: true })
      await this.extract(zipPath, target)
      if (!(await isNapcatDir(target))) {
        return this.fail('下载包解压后不像 NapCat（缺 bootmain / napcat.mjs），已放弃')
      }

      this.shellDir = target
      this.deps.setShellDir(target)
      this.phase = 'idle'
      this.progress = null
      this.error = null
      this.deps.log('info', 'napcat installed', { shellDir: target })
      return { ok: true }
    } catch (error) {
      return this.fail(`安装 NapCat 失败：${String(error)}`)
    } finally {
      this.installing = false
    }
  }

  /** 选择已有目录后校验并保存 */
  async setShellDir(dir: string): Promise<{ ok: boolean; error?: string }> {
    const trimmed = dir.trim()
    if (!(await isNapcatDir(trimmed))) {
      return { ok: false, error: '这个目录不是可用的 NapCat Shell（缺 NapCatWinBootMain.exe 等文件）' }
    }
    this.shellDir = trimmed
    this.deps.setShellDir(trimmed)
    this.phase = 'idle'
    this.error = null
    this.log('info', 'napcat dir saved', { shellDir: trimmed })
    return { ok: true }
  }

  /** 端口 / token 改了：If NapCat 已经在跑，把新配置热写进去 */
  async syncConfig(): Promise<void> {
    if (this.shellDir === null) return
    if (!this.deps.isConnected() && this.phase !== 'waiting-login') return
    try {
      await this.applyConfig()
    } catch (error) {
      this.log('warn', 'napcat config sync failed', { error: String(error) })
    }
  }

  private fail(message: string): { ok: false; error: string } {
    this.phase = 'error'
    this.error = message
    this.log('warn', 'napcat failed', { error: message })
    return { ok: false, error: message }
  }

  /** 连上了：记一笔「曾经在线」，并允许下一次掉线再提醒 */
  private markOnline(): void {
    this.wasOnline = true
    this.offlineNotified = false
  }

  /** 掉线提醒：只在本会话「在线过又掉了」时弹一次，别每轮轮询都弹 */
  private notifyOffline(reason: 'login-required' | 'webui-down' | 'link'): void {
    if (!this.wasOnline || this.offlineNotified) return
    this.offlineNotified = true
    this.log('warn', 'qq offline detected', { reason })
    this.deps.notify?.(
      'QQ 掉线了',
      reason === 'login-required'
        ? '去「设置 → QQ 通道」扫一下码就能接上'
        : reason === 'link'
          ? 'NapCat 登录正常但没连上 Gotcha（检查 access_token / 端口），正在后台重试'
          : 'NapCat 暂时没响应，正在后台重试；恢复了会自动接上'
    )
  }

  private log(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
    this.deps.log(level, message, data)
  }

  private spawnNapcat(): void {
    const shellDir = this.shellDir
    const qqPath = this.qqPath
    if (shellDir === null || qqPath === null) throw new Error('missing-shell-or-qq')
    const spawnImpl = this.deps.spawnImpl ?? spawn
    const child: ChildProcess = spawnImpl(
      join(shellDir, 'NapCatWinBootMain.exe'),
      [qqPath, join(shellDir, 'NapCatWinBootHook.dll')],
      {
        cwd: shellDir,
        env: {
          ...process.env,
          NAPCAT_PATCH_PACKAGE: join(shellDir, 'qqnt.json'),
          NAPCAT_LOAD_PATH: join(shellDir, 'loadNapCat.js'),
          NAPCAT_INJECT_PATH: join(shellDir, 'NapCatWinBootHook.dll'),
          NAPCAT_LAUNCHER_PATH: join(shellDir, 'NapCatWinBootMain.exe'),
          NAPCAT_MAIN_PATH: join(shellDir, 'napcat.mjs')
        },
        stdio: 'ignore',
        windowsHide: false,
        detached: true
      }
    )
    // 脱离父进程：Gotcha 关了 NapCat 还活着（拍板：退出不关）
    child.unref()
    this.childPid = child.pid ?? null
    this.ownedProcess = true
    this.attachedToExisting = false
    this.log('info', 'napcat spawn', { pid: this.childPid ?? 0 })
    child.on('exit', (code) => {
      if (this.stopping) return
      this.childPid = null
      this.ownedProcess = false
      if (this.phase === 'connected' || this.phase === 'idle') return
      this.fail(`NapCat 进程退出了（code ${code ?? '?'}）；如果是 QQ 已退出 / 版本不兼容，重开一次`)
    })
    child.on('error', (error) => {
      this.fail(`NapCat 进程启动失败：${String(error)}`)
    })
  }

  private async bootmainIsRunning(): Promise<boolean> {
    if (this.deps.isBootmainRunning !== undefined) return this.deps.isBootmainRunning()
    return bootmainRunning()
  }

  private async isQqRunning(): Promise<boolean> {
    if (this.deps.isQqRunning !== undefined) return this.deps.isQqRunning()
    return qqRunning()
  }

  private async resolveQq(): Promise<string | null> {
    if (this.deps.resolveQqPath !== undefined) return this.deps.resolveQqPath()
    return resolveQqPath()
  }

  private beginPoll(): void {
    if (this.pollTimer !== null) return
    this.pollTimer = setInterval(() => void this.poll(), 1_500)
    void this.poll()
  }

  private stopPoll(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      if (this.deps.isConnected()) {
        this.phase = 'connected'
        this.loggedIn = true
        this.qrDataUrl = null
        this.error = null
        this.markOnline()
        return
      }
      if (this.shellDir === null) return
      if (this.phase === 'starting') this.phase = 'waiting-login'

      // 二维码先读：WebUI 挂了也不耽误扫码
      await this.readQr()

      // 宽限期过了还没摸到 WebUI：先作废旧凭据探一次（NapCat 重启会换凭据），还连不上才报错。
      // 重点是**继续轮询**——NapCat / QQ 重启后要能自己接回来（2026-11-04 真机：WebUI 掉了几秒
      // 就回来了，旧逻辑已经永久停表，只能手动点「启动」）。
      const stale = this.now() - this.lastWebuiOkAt > NAPCAT_WEBUI_GRACE_MS
      if (stale) {
        this.webuiCredential = null
        if (!(await this.probeWebui())) {
          this.loggedIn = false
          // 掉线期间连接时长不再可信：恢复了重新起算，否则「已登录但没连上」的 45s 判会立刻误报
          this.loggedInSince = null
          if (this.phase !== 'error') {
            this.errorKind = 'webui'
            this.fail('NapCat 暂时没响应（WebUI 连不上），正在后台重试；恢复了会自动接上')
            this.notifyOffline('webui-down')
          }
          return
        }
      }

      await this.ensureWebui()
      // 自愈：WebUI 回来了（或换了新凭据），把「连不上」那条错误收掉，别让界面一直停在报错上
      if (this.errorKind === 'webui' && this.webuiCredential !== null) {
        this.error = null
        this.errorKind = null
        this.phase = 'waiting-login'
        this.log('info', 'napcat webui recovered')
      }

      if (this.webuiCredential !== null) {
        const status = await this.webuiPost('/api/QQLogin/CheckLoginStatus')
        const data = asRecord(status)
        if (data !== null && data['isLogin'] === true) {
          this.loggedIn = true
          this.qrDataUrl = null
          this.error = null
          this.errorKind = null
          if (this.loggedInSince === null) this.loggedInSince = this.now()
          if (this.uin === null) await this.refreshLoginInfo()
          if (!this.configApplied && this.now() - this.lastConfigAttempt > 10_000) {
            this.lastConfigAttempt = this.now()
            await this.applyConfig()
          }
          if (this.deps.isConnected()) {
            this.phase = 'connected'
          } else if (this.now() - this.loggedInSince > 45_000) {
            // 登录成功但一直没拨回来：八成是 token / 端口 / 代理问题。只报原因、不停轮询：
            // 改完设置后 NapCat 会重连回来，这里能自己恢复（别让人只能手动点「启动」）
            if (this.phase !== 'error') {
              this.errorKind = 'link'
              this.fail('QQ 已登录，但 NapCat 没连上 Gotcha（检查 access_token / 端口 / 代理，改完会自动重试）')
              this.notifyOffline('link')
            }
          } else {
            // 已登录但还没拨回来（配置刚写入 / 正在重连）：保持等待，不要退回二维码
            this.phase = 'waiting-login'
          }
          return
        }
        this.loggedInSince = null
        this.loggedIn = false
        this.notifyOffline('login-required')
      }

      // 没登录：码过期（或还没有码）就让 NapCat 换一张——它自己不会换，旧码扫出来是「已过期」
      if (qrExpired(this.qrAt, this.now())) {
        this.qrDataUrl = null
        this.qrAt = null
        await this.refreshQr()
        await this.readQr()
      }
      if (this.phase !== 'error') this.phase = 'waiting-login'
    } catch (error) {
      // WebUI 没起来时每个轮询都会抛：30s 记一次就够，别刷日志
      if (this.now() - this.lastPollErrorAt > 30_000) {
        this.lastPollErrorAt = this.now()
        this.log('warn', 'napcat poll failed', { error: String(error) })
      }
    } finally {
      this.polling = false
    }
  }

  /** WebUI 能不能连上（作废旧凭据后重登一次）；连不上返回 false，不抛 */
  private async probeWebui(): Promise<boolean> {
    try {
      await this.ensureWebui()
    } catch {
      // 连不上就是连不上：由调用方按轮询节奏重试，这里不刷日志
    }
    return this.webuiCredential !== null
  }

  private async ensureWebui(): Promise<void> {
    if (this.webuiCredential !== null || this.shellDir === null) return
    if (this.webuiPort === null || this.webuiToken === null) {
      const configPath = join(this.shellDir, 'config', 'webui.json')
      const raw = await readFile(configPath, 'utf8').catch(() => null)
      if (raw === null) return
      const config = parseWebuiConfig(raw)
      if (config === null) return
      this.webuiPort = config.port
      this.webuiToken = config.token
    }
    if (this.webuiToken === null) return
    const login = await this.webuiPost('/api/auth/login', {
      hash: napcatTokenHash(this.webuiToken)
    })
    const record = asRecord(login)
    const credential = record?.['Credential'] ?? record?.['credential']
    if (typeof credential === 'string' && credential !== '') this.webuiCredential = credential
  }

  private webuiBase(): string | null {
    return this.webuiPort === null ? null : `http://127.0.0.1:${this.webuiPort}`
  }

  private async webuiPost(path: string, body: Record<string, unknown> = {}): Promise<unknown> {
    const base = this.webuiBase()
    if (base === null) return null
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.webuiCredential !== null) headers['authorization'] = `Bearer ${this.webuiCredential}`
    const response = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4_000)
    })
    if (!response.ok) throw new Error(`WebUI ${path} HTTP ${response.status}`)
    const json = (await response.json()) as WebuiResponse
    if (typeof json.code === 'number' && json.code !== 0) {
      if (json.message === 'Unauthorized') this.webuiCredential = null
      throw new Error(`WebUI ${path} code ${json.code}${json.message ? `：${json.message}` : ''}`)
    }
    this.lastWebuiOkAt = this.now()
    return json.data ?? null
  }

  private async refreshLoginInfo(): Promise<void> {
    const info = asRecord(await this.webuiPost('/api/QQLogin/GetQQLoginInfo'))
    if (info === null) return
    const uin = info['uin']
    if (typeof uin === 'string' || typeof uin === 'number') this.uin = String(uin)
  }

  private async applyConfig(): Promise<void> {
    const raw = await this.webuiPost('/api/OB11Config/GetConfig')
    const config = asRecord(raw)
    if (config === null) {
      this.log('warn', 'napcat onebot config unavailable')
      return
    }
    const merged = mergeOneBotConfig(config, this.deps.getEndpoint())
    if (merged.changed) {
      await this.webuiPost('/api/OB11Config/SetConfig', { config: JSON.stringify(merged.config) })
      this.log('info', 'napcat onebot config applied', { port: this.deps.getEndpoint().port })
    }
    this.configApplied = true
  }

  private async readQr(): Promise<void> {
    if (this.shellDir === null) return
    const file = join(this.shellDir, NAPCAT_QRCODE_REL)
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(file)
    } catch {
      return
    }
    if (info.mtimeMs === this.qrMtime) return
    if (info.mtimeMs < this.qrMinMtime) return
    // 旧图（票早过期了）不算数：等 refreshQr() 换一张，别把过期码一直挂在界面上
    if (info.mtimeMs < this.now() - NAPCAT_QR_MAX_AGE_MS) return
    const bytes = await readFile(file).catch(() => null)
    if (bytes === null) return
    const dataUrl = qrcodeDataUrl(bytes)
    if (dataUrl === null) return
    this.qrDataUrl = dataUrl
    this.qrAt = this.now()
    this.qrMtime = info.mtimeMs
    this.log('info', 'napcat qrcode updated')
  }

  /**
   * 二维码过期就让 NapCat 换一张（旧码扫出来是「已过期」）。NapCat 停在登录页时自己也会隔
   * 约 2 分钟重写一次 PNG（2026-11-04 实测），但刷新是兜底：轮询停掉时也得有人主动换。
   * 刷新后 NapCat 会把那张 PNG 重写，再按普通路径读回来——不引入二维码编码器，也不新增依赖。
   */
  private async refreshQr(): Promise<void> {
    if (this.webuiCredential === null) return
    if (this.now() - this.lastQrRefreshAt < 15_000) return
    this.lastQrRefreshAt = this.now()
    try {
      const data = asRecord(await this.webuiPost('/api/QQLogin/RefreshQRcode'))
      const url = data?.['qrcodeurl']
      if (typeof url !== 'string' || url === '') return
      // 文件刚被重写：旧的 mtime 不能再拦住它
      this.qrMtime = 0
      await this.readQr()
      if (this.qrDataUrl !== null) this.log('info', 'napcat qrcode refreshed')
    } catch (error) {
      this.log('warn', 'napcat qrcode refresh failed', { error: String(error) })
    }
  }

  private async latestDownloadUrl(): Promise<string> {
    const fetchImpl = this.deps.fetchImpl ?? fetch
    try {
      const response = await fetchImpl(NAPCAT_RELEASE_API, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'Gotcha'
        },
        signal: AbortSignal.timeout(8_000)
      })
      if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`)
      const json = (await response.json()) as unknown
      const assets = asRecord(json)?.['assets']
      if (Array.isArray(assets)) {
        const asset = assets.find((item) => {
          const record = asRecord(item)
          return record?.['name'] === NAPCAT_SHELL_ASSET && typeof record['browser_download_url'] === 'string'
        })
        const url = asRecord(asset)?.['browser_download_url']
        if (typeof url === 'string' && url.startsWith('https://github.com/')) return url
      }
    } catch (error) {
      this.log('warn', 'napcat release api failed, fallback to latest download', {
        error: String(error)
      })
    }
    return NAPCAT_LATEST_DOWNLOAD
  }

  private async download(url: string, target: string): Promise<void> {
    const fetchImpl = this.deps.fetchImpl ?? fetch
    const response = await fetchImpl(url, {
      headers: { 'user-agent': 'Gotcha' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10 * 60_000)
    })
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length') ?? 0)
    const body = response.body
    if (body === null) throw new Error('下载失败：响应没有内容')

    const chunks: Uint8Array[] = []
    let received = 0
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) {
        chunks.push(value)
        received += value.byteLength
        if (total > 0) this.progress = Math.min(0.99, received / total)
      }
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
    if (bytes.byteLength < 10 * 1024 * 1024) {
      throw new Error(`下载包太小（${bytes.byteLength} 字节），可能被代理拦了`)
    }
    await writeFile(target, bytes)
    this.progress = 1
  }

  private async extract(zipPath: string, target: string): Promise<void> {
    try {
      await execFileAsync('tar.exe', ['-xf', zipPath, '-C', target], {
        timeout: 120_000,
        windowsHide: true
      })
      return
    } catch (error) {
      this.log('warn', 'napcat tar extract failed, fallback to Expand-Archive', {
        error: String(error)
      })
    }
    const quotedZip = zipPath.replace(/'/gu, "''")
    const quotedTarget = target.replace(/'/gu, "''")
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -LiteralPath '${quotedZip}' -DestinationPath '${quotedTarget}' -Force`
      ],
      { timeout: 180_000, windowsHide: true }
    )
  }
}
