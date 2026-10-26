/**
 * 信息链 · 事件触发现抓一帧（真实证据截图，D42）
 *
 * 为什么现抓：截图是「AI 命中后回来核验」的最终证据。拿采集管线 2 秒一次的旧帧，
 * 拍到的可能是上一刻的画面（选项 B）；点下去那一瞬间才是证据，所以事件到了就抓（选项 C）。
 *
 * 四条纪律：
 * 1. **身份先对齐、抓完再确认**：前台窗口必须仍是这个段的那扇窗，拍下来才算这段的证据。
 *    已经切走了就返回 `null`（没拍到），不拿别的窗口的画面冒充——错证据比没证据更糟。
 *    抓帧要 100–300ms，这期间前台可能已经换了（实测见过抓完那一刻被别的窗口盖住），
 *    所以**抓完还要再确认一次**，不一致就丢掉这一帧（真机上正是靠这条才没存进别人的画面）。
 * 2. **黑名单不拍**：密码管理器等（security.md 第 2 层）直接放弃，与旧管线同口径。
 * 3. **抓完立刻搬走**：屏幕流只会往 temp 目录写 `frame-<ts>.png`，这里马上 rename 进
 *    `chain-shots/`；留在 tmp 会被启动清理当垃圾删掉（F06）。丢掉的那帧顺手删掉。
 * 4. **不编造**：抓不到 / 校验不过就 `null`，由记录器计入 `droppedShots`，不写半张截图行。
 *
 * 抓帧是异步的（几十到几百毫秒），并且**这里自己串行**：同一时刻只允许一次抓帧，
 * 免得两个事件同时向屏幕流要画面、也免得 temp 文件名撞车。调用方（记录器）负责
 * 按事件顺序把结果落库。
 */
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { WindowBounds } from '../capture/window-meta'
import type { ShotRequest, ShotResult, ShotTaker } from '../chain/recorder'
import { dayKeyOf, type ChainDb } from '../chain/store'

/** 前台窗口的最小形状（pid + hwnd 用来对齐段身份，bounds 用来裁剪） */
export interface ChainShotWindow {
  pid: number
  hwnd: number
  title: string
  /** 进程名，小写（黑名单匹配用） */
  executable: string
  bounds: WindowBounds
}

/** 屏幕流抓到的一帧（由 `ScreenCapture` 提供） */
export interface ChainShotFrame {
  imagePath: string
  width: number
  height: number
}

export interface ChainShotScreen {
  capture(bounds: WindowBounds, tempDir: string, ts: number): Promise<ChainShotFrame>
}

/** 文件操作的注入点（单测用假的，生产用 fs） */
export interface ChainShotFs {
  mkdirSync(path: string, options: { recursive: boolean }): void
  renameSync(from: string, to: string): void
  statSync(path: string): { size: number }
  /** 丢掉抓错的帧（抓帧后复核不过时删掉临时文件） */
  rmSync(path: string, options: { force: boolean }): void
}

export type ChainShotLog = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  data?: Record<string, unknown>
) => void

export interface ChainShotOptions {
  db: ChainDb
  /** 证据截图目录（`<userData>/chain-shots`） */
  shotsDir: string
  /** 屏幕流的临时输出目录（`<userData>/tmp-chain`），与旧管线分开免得被清理逻辑误删 */
  tempDir: string
  screen: ChainShotScreen
  getWindow: () => Promise<ChainShotWindow | null>
  isBlacklisted?: (executable: string) => boolean
  log?: ChainShotLog
  fs?: ChainShotFs
}

/** 段的窗口身份（从库里读，不用段机内存副本——落库的那行才是证据） */
interface SegmentWindow {
  pid: number | null
  hwnd: number | null
}

function readSegmentWindow(db: ChainDb, segmentId: number): SegmentWindow | null {
  const row = db.prepare('SELECT pid, hwnd FROM chain_segment WHERE id = ?').get(segmentId) as
    | { pid: number | null; hwnd: number | null }
    | undefined
  return row ?? null
}

/**
 * 前台窗口是不是这个段的那扇窗。
 * `hwnd` 是窗口句柄（契约 §2.1 的段身份），两边都有就必须相等；
 * 老行 / 极端情况下缺 hwnd 才退回比 pid。
 */
export function sameWindow(segment: SegmentWindow, window: ChainShotWindow): boolean {
  if (segment.hwnd !== null && segment.hwnd !== 0) return segment.hwnd === window.hwnd
  if (segment.pid !== null && segment.pid !== 0) return segment.pid === window.pid
  return false
}

/** 证据文件名：按段开始那天归档，段 / 事件 id 都在名字里，反查不用查库 */
export function chainShotFileName(request: ShotRequest): string {
  return join(dayKeyOf(request.at), `s${request.segmentId}-e${request.eventId}-${request.at}.png`)
}

export function createChainShotSource(options: ChainShotOptions): ShotTaker {
  const fs = options.fs ?? { mkdirSync, renameSync, statSync, rmSync }
  let dirsReady = false
  /** 抓帧串行队列：屏幕流同时只服务一次截图 */
  let queue: Promise<unknown> = Promise.resolve()

  const ensureDirs = (): void => {
    if (dirsReady) return
    fs.mkdirSync(options.tempDir, { recursive: true })
    fs.mkdirSync(options.shotsDir, { recursive: true })
    dirsReady = true
  }

  const captureOne = async (request: ShotRequest): Promise<ShotResult | null> => {
    const segment = readSegmentWindow(options.db, request.segmentId)
    if (!segment) {
      options.log?.('warn', 'chain shot skipped: segment row missing', { segmentId: request.segmentId })
      return null
    }

    let window: ChainShotWindow | null = null
    try {
      window = await options.getWindow()
    } catch (error) {
      options.log?.('warn', 'chain shot skipped: foreground window unavailable', {
        error: String(error)
      })
      return null
    }
    if (!window) return null

    // 已切走的窗口不拍：拍到的会是别人的画面
    if (!sameWindow(segment, window)) {
      options.log?.('info', 'chain shot skipped: foreground changed', {
        segmentId: request.segmentId,
        segmentHwnd: segment.hwnd,
        windowHwnd: window.hwnd
      })
      return null
    }
    if (options.isBlacklisted?.(window.executable)) {
      options.log?.('info', 'chain shot skipped: blacklisted window', { exe: window.executable })
      return null
    }

    ensureDirs()
    try {
      const frame = await options.screen.capture(window.bounds, options.tempDir, request.at)

      // 抓帧要 100–300ms：拍的是「这扇窗所在的屏幕区域」，这期间前台换了就等于拍到了别人的画面。
      // 真机实测踩到过一次（段是 DSH，存下来的却是 Firefox），所以抓完必须再确认一次。
      let after: ChainShotWindow | null = null
      try {
        after = await options.getWindow()
      } catch {
        after = null
      }
      if (!after || !sameWindow(segment, after)) {
        try {
          fs.rmSync(frame.imagePath, { force: true })
        } catch {
          // 删不掉就留着，启动清理会扫 tmp-chain
        }
        options.log?.('info', 'chain shot discarded: foreground changed during capture', {
          segmentId: request.segmentId,
          segmentHwnd: segment.hwnd,
          windowHwnd: after?.hwnd ?? null
        })
        return null
      }

      const target = join(options.shotsDir, chainShotFileName(request))
      fs.mkdirSync(join(options.shotsDir, dayKeyOf(request.at)), { recursive: true })
      fs.renameSync(frame.imagePath, target)
      return {
        shot: {
          path: target,
          width: frame.width,
          height: frame.height,
          bytes: fs.statSync(target).size
        },
        content: null
      }
    } catch (error) {
      // 抓帧 / 落盘失败都算「这张没拍到」：记录器计入 droppedShots，不写行
      options.log?.('warn', 'chain shot failed', {
        segmentId: request.segmentId,
        eventId: request.eventId,
        error: String(error)
      })
      return null
    }
  }

  return (request: ShotRequest): Promise<ShotResult | null> => {
    const run = queue.then(
      () => captureOne(request),
      () => captureOne(request)
    )
    // 队列本身永不 reject（失败已在 captureOne 里吃掉），否则后续抓帧全被跳过
    queue = run.catch(() => null)
    return run
  }
}
