/**
 * 前台窗口元数据（m1a-plan §3 Phase 2b）
 *
 * active-win 取 title / 进程名 / 窗口区域；黑名单进程只记元数据（security.md 第 2 层）。
 */

import { activeWindow } from 'active-win'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowInfo {
  title: string
  /** 应用显示名，如 Firefox */
  app: string
  /** 进程可执行文件名（小写），如 firefox.exe */
  executable: string
  bounds: WindowBounds
}

/** 默认黑名单：密码管理器等（运维时可通过调用方传入覆盖） */
export const DEFAULT_BLACKLIST: readonly string[] = [
  '1password.exe',
  'bitwarden.exe',
  'keepass.exe',
  'keepassxc.exe',
  'lastpass.exe'
]

/** 取路径末段并小写（active-win 的 owner.path 在 Windows 上是 exe 路径） */
export function executableName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.toLowerCase()
}

/** 黑名单匹配：接受 `1password.exe` 或 `1password` 两种写法 */
export function isBlacklisted(
  executable: string,
  blacklist: readonly string[] = DEFAULT_BLACKLIST
): boolean {
  const name = executable.toLowerCase()
  const bare = name.replace(/\.exe$/, '')
  return blacklist.some((entry) => entry.toLowerCase().replace(/\.exe$/, '') === bare)
}

/** 当前前台窗口；无窗口（如锁屏过渡）返回 null */
export async function getActiveWindow(): Promise<WindowInfo | null> {
  const win = await activeWindow()
  if (!win) return null
  return {
    title: win.title,
    app: win.owner.name,
    executable: executableName(win.owner.path),
    bounds: {
      x: win.bounds.x,
      y: win.bounds.y,
      width: win.bounds.width,
      height: win.bounds.height
    }
  }
}
