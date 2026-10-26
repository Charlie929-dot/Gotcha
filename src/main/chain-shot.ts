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
 * 抓帧尺寸走 `EVIDENCE_CAPTURE_TARGET`（不放大、封顶 1920）：证据图不喂 OCR，
 * 复制 OCR 那条 2× 放大路径会让「抓帧 → 落盘」成本翻 4 倍以上（2026-10-27 真机卡顿主因之一）。
 *
 * 抓帧是异步的（几十到几百毫秒），并且**这里自己串行**：同一时刻只允许一次抓帧，
 * 免得两个事件同时向屏幕流要画面、也免得 temp 文件名撞车。调用方（记录器）负责
 * 按事件顺序把结果落库。
 */
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { WindowBounds } from '../capture/window-meta'
import { EVIDENCE_MAX_WIDTH } from '../capture/ocr-scaling'
import type { CaptureTargetOptions } from '../capture/ocr-scaling'
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
  /** 另出的 OCR 用 2× PNG（临时目录；内容车道读它，读完删） */
  ocrPath?: string
}

export interface ChainShotScreen {
  /**
   * 抓一帧。第四个参数是**抓帧口径**：证据图传
   * `{ target: { upscale: 1, maxWidth: 1920 }, format: 'jpeg', withOcrImage: true }`
   * ——不复制 OCR 那条 2× 主图路径，同时另出一张 2× PNG 给 OCR 兜底。
   */
  capture(
    bounds: WindowBounds,
    tempDir: string,
    ts: number,
    options?: ChainShotCaptureOptions
  ): Promise<ChainShotFrame>
}

export interface ChainShotCaptureOptions {
  /** 主图尺寸口径（默认 = OCR 的 2× / 封顶 3840） */
  target?: CaptureTargetOptions
  /** 主图编码格式（默认 png；证据图 jpeg） */
  format?: 'png' | 'jpeg'
  /** 是否另出一张 2× PNG 给 OCR（证据图这条要） */
  withOcrImage?: boolean
}

/**
 * 证据截图的抓帧口径：主图**不放大**、超宽缩到 1920（D44 的 warm 档宽度），**渲染端直接出 JPEG**；
 * 另外带一张 2× PNG 专给内容车道的 OCR 兜底（UIA 文本不足时用）。
 *
 * 为什么要拆成两份：证据图给人和 AI 看，1920 足够；OCR 靠字号，2× 才认得出字（D43 / D44 实测）。
 * 以前是「2× PNG 落盘 → 主进程解码 → 缩到 1920 → 重编码 JPEG」，一张 500ms 全压在主线程上
 * （真机 2026-10-27：鼠标按住拖动时一顿一顿）；现在渲染进程一次画两张，主进程只写字节。
 */
export const EVIDENCE_CAPTURE_TARGET: CaptureTargetOptions = {
  upscale: 1,
  maxWidth: EVIDENCE_MAX_WIDTH
}

/** 证据图的抓帧口径（尺寸 + 格式 + OCR 副图），一次说全 */
export const EVIDENCE_CAPTURE_OPTIONS: ChainShotCaptureOptions = {
  target: EVIDENCE_CAPTURE_TARGET,
  format: 'jpeg',
  withOcrImage: true
}

/** 单张证据从抓帧到落盘超过这个时长就记一条 warn（体感边界，不是硬指标） */
export const SLOW_SHOT_MS = 300

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

/** 一张证据落定后交给内容来源的形状（D43：抓帧时顺带读文本） */
export interface ChainShotCommitted {
  segmentId: number
  eventId: number
  /** 触发事件时刻（内容行也用它当 `captured_at`） */
  at: number
  /** 段身份对应窗口的句柄（UIA 按句柄读这扇窗） */
  hwnd: number
  executable: string
  /** 证据图落定的路径（长期保存的那份） */
  framePath: string
  /** 给 OCR 的 2× PNG（临时目录；内容车道读完就删，缺它就是没有） */
  ocrPath?: string
}

export interface ChainShotOptions {
  db: ChainDb
  /** 证据截图目录（`<userData>/chain-shots`） */
  shotsDir: string
  /** 屏幕流的临时输出目录（`<userData>/tmp-chain`），与旧管线分开免得被清理逻辑误删 */
  tempDir: string
  screen: ChainShotScreen
  getWindow: () => Promise<ChainShotWindow | null>
  isBlacklisted?: (executable: string) => boolean
  /**
   * 证据落定后的旁路回调（内容来源用）。**不 await**：读取慢（UIA 0.8–4s）不能拖慢抓帧队列；
   * 抛错也只记日志，不影响这张截图是否算数。
   */
  onShot?: (committed: ChainShotCommitted) => void
  log?: ChainShotLog
  fs?: ChainShotFs
  /** 时钟（单测注入；默认 `Date.now`），只用于慢抓帧告警 */
  now?: () => number
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
export function chainShotFileName(request: ShotRequest, ext: 'png' | 'jpg' = 'png'): string {
  return join(dayKeyOf(request.at), `s${request.segmentId}-e${request.eventId}-${request.at}.${ext}`)
}

export function createChainShotSource(options: ChainShotOptions): ShotTaker {
  const fs = options.fs ?? { mkdirSync, renameSync, statSync, rmSync }
  const now = options.now ?? (() => Date.now())
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
      const startedAt = now()
      const frame = await options.screen.capture(
        window.bounds,
        options.tempDir,
        request.at,
        EVIDENCE_CAPTURE_OPTIONS
      )

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
          if (frame.ocrPath) fs.rmSync(frame.ocrPath, { force: true })
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

      // 证据图已经在渲染端编码好（JPEG q85 + 可选 2× PNG 给 OCR），主进程只做 I/O：
      // 以前这里还要 nativeImage 解码 + 缩图 + 重编码，一张 300–500ms 全压在主线程上。
      const ext: 'png' | 'jpg' = frame.imagePath.toLowerCase().endsWith('.jpg') ? 'jpg' : 'png'
      const target = join(options.shotsDir, chainShotFileName(request, ext))
      fs.mkdirSync(join(options.shotsDir, dayKeyOf(request.at)), { recursive: true })
      fs.renameSync(frame.imagePath, target)
      const shot = {
        path: target,
        width: frame.width,
        height: frame.height,
        bytes: fs.statSync(target).size
      }
      // 旁路：内容来源（D43）。放在证据落定之后、不 await——读取慢不能拖慢抓帧队列；
      // 钩子自己抛错也只影响内容，不该让这张已经拍对的证据作废。
      if (options.onShot) {
        try {
          options.onShot({
            segmentId: request.segmentId,
            eventId: request.eventId,
            at: request.at,
            hwnd: window.hwnd,
            executable: window.executable,
            framePath: target,
            ocrPath: frame.ocrPath
          })
        } catch (error) {
          options.log?.('warn', 'chain shot: content hook failed', { error: String(error) })
        }
      }
      // 慢抓帧留痕：这条日志是「采集是否拖慢机器」的唯一观测点（不是硬指标，只用来回看）
      const elapsed = now() - startedAt
      if (elapsed >= SLOW_SHOT_MS) {
        options.log?.('warn', 'chain shot slow', {
          segmentId: request.segmentId,
          eventId: request.eventId,
          ms: elapsed,
          width: shot.width,
          height: shot.height,
          bytes: shot.bytes
        })
      }
      return {
        shot,
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
