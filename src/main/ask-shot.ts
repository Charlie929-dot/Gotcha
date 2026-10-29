/**
 * 选区问答的截图（段二 A/B）
 *
 * 两张图分开管：
 * - 选区截图存 `<userData>/ask-shots/shot-<ts>.png`，**随对话记录留存**（拍板人 2026-10-28 定），
 *   默认保留 30 天，由启动时的 janitor 按年龄清；
 * - 问记忆窗口读不到文件（sandbox），所以展示一律转 data URL（同 `readShotDataUrl` 口径，
 *   只是这里放宽到 8 MB——整屏截图比段证据大一圈）。
 *
 * 裁剪在主进程做：渲染端只回整屏帧，主进程按选区裁（`nativeImage.crop`），
 * 渲染端不需要知道 DPI / 帧像素。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

export const ASK_SHOTS_DIR = 'ask-shots'
/** 截图随对话留存：默认 30 天，超过由 janitor 清（对话记录里的引用会读不到图，界面如实降级） */
export const ASK_SHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** 送渲染层的单张上限：超过就不显示（不让一张大图把窗口拖死） */
export const ASK_SHOT_MAX_BYTES = 8 * 1024 * 1024

const SHOT_FILE_RE = /^shot-\d{10,}(?:-\d+)?\.(?:png|jpg|jpeg|webp|gif)$/

export function askShotsDir(userDataDir: string): string {
  return join(userDataDir, ASK_SHOTS_DIR)
}

export function askShotPath(userDataDir: string, ts: number): string {
  return join(askShotsDir(userDataDir), `shot-${ts}.png`)
}

/**
 * 整屏帧 → 选区 PNG。见 `ask-crop.ts`（要 nativeImage，单独放）
 */

/** 落盘；目录不存在就建。写失败如实抛（调用方记日志，不影响已经截到的帧） */
export function saveAskShot(userDataDir: string, png: Buffer, ts: number): string {
  const dir = askShotsDir(userDataDir)
  mkdirSync(dir, { recursive: true })
  const path = askShotPath(userDataDir, ts)
  writeFileSync(path, png)
  return path
}

/**
 * 路径是不是本应用自己存的选区截图：必须在 `<userData>/ask-shots/` 下、文件名合 `shot-<ts>.png`。
 * IPC 里 renderer 能传路径过来，所以这条校验是必须的（不能让它读任意文件）。
 */
export function isAskShotPath(userDataDir: string, path: string): boolean {
  if (typeof path !== 'string' || path === '') return false
  const dir = resolve(askShotsDir(userDataDir))
  const target = resolve(path)
  if (!target.startsWith(dir + sep)) return false
  return SHOT_FILE_RE.test(basename(target))
}

/**
 * 用户上传的图片：data URL → 落盘成 `<userData>/ask-shots/shot-<ts>-<n>.<ext>`。
 * 与选区截图同一目录、同一保留期（30 天），历史里靠路径回看。
 * 只收图片 data URL；太大 / 解不出来返回 null（调用方如实报错，不静默丢）。
 */
export function saveAskUpload(
  userDataDir: string,
  dataUrl: string,
  ts: number,
  index: number
): string | null {
  const match = /^data:image\/(png|jpeg|webp|gif);base64,(.+)$/i.exec(dataUrl)
  if (!match) return null
  const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()
  let bytes: Buffer
  try {
    bytes = Buffer.from(match[2], 'base64')
  } catch {
    return null
  }
  if (bytes.length === 0 || bytes.length > ASK_SHOT_MAX_BYTES) return null
  const dir = askShotsDir(userDataDir)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `shot-${ts}-${Math.max(0, Math.trunc(index))}.${ext}`)
  try {
    writeFileSync(path, bytes)
    return path
  } catch {
    return null
  }
}

/** 截图 → data URL（窗口展示用）；读不到 / 太大 / 不是 PNG 都返回 null */
export function readAskShotDataUrl(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    const stat = statSync(path)
    if (!stat.isFile() || stat.size <= 0 || stat.size > ASK_SHOT_MAX_BYTES) return null
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
    const mime =
      ext === 'jpg' || ext === 'jpeg'
        ? 'image/jpeg'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'gif'
            ? 'image/gif'
            : 'image/png'
    return `data:${mime};base64,${readFileSync(path).toString('base64')}`
  } catch {
    return null
  }
}

/**
 * 按年龄清过期截图（随对话留存 30 天）。只认 `shot-<ts>.png`，不认识的文件一律不碰。
 * 返回删除数量；目录不存在返回 0（启动时经常还没截过图）。
 */
export function pruneAskShots(
  userDataDir: string,
  options: { now?: number; maxAgeMs?: number } = {}
): number {
  const dir = askShotsDir(userDataDir)
  if (!existsSync(dir)) return 0
  const now = options.now ?? Date.now()
  const maxAge = options.maxAgeMs ?? ASK_SHOT_RETENTION_MS
  let removed = 0
  for (const name of readdirSync(dir)) {
    if (!SHOT_FILE_RE.test(name)) continue
    const stamp = /^shot-(\d{10,})/.exec(name)?.[1]
    const ts = stamp === undefined ? Number.NaN : Number(stamp)
    if (!Number.isFinite(ts) || now - ts < maxAge) continue
    try {
      unlinkSync(join(dir, name))
      removed += 1
    } catch {
      // 被占用 / 权限问题：这一张下轮再清，不因为一张失败停掉整轮
    }
  }
  return removed
}
