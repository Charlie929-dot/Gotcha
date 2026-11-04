/**
 * 开机自启（M5 打包首发）
 *
 * 口径：
 * - **只在打包态注册**：dev 跑的是 `node_modules/electron/dist/electron.exe`，
 *   往启动项里写它没有意义，还会污染用户的启动项；
 * - **只注册一次**：首次打包启动写 HKCU Run（`app.setLoginItemSettings`），并在
 *   `<userData>/.startup-registered` 落标记。用户以后在系统设置 / 任务管理器里关掉，
 *   下次启动不会再被强写回来；
 * - **升级沿用**：one-click NSIS 装到固定目录（`%LOCALAPPDATA%\Programs\Gotcha`），
 *   覆盖安装后 exe 路径不变，启动项继续有效；
 * - 托盘「开机自启」勾选走 `setStartupEnabled()`，改的是同一个系统启动项。
 *
 * 纯 Node 模块（不 import Electron），单测在 `tests/unit/main-startup.test.ts`。
 */

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 「已经处理过注册」的标记文件（userData 下；卸载不删 userData，重装也认） */
export const STARTUP_MARKER_FILE = '.startup-registered'

export type StartupRegistration = 'skip-dev' | 'already' | 'registered'

export interface StartupDeps {
  /** `app.isPackaged`：dev 下直接跳过 */
  packaged: boolean
  /** `app.getPath('userData')`：标记文件放这里 */
  userDataDir: string
  /** `app.getLoginItemSettings()` */
  getLoginItem(): { openAtLogin: boolean }
  /** `app.setLoginItemSettings({ openAtLogin, path })` */
  setLoginItem(openAtLogin: boolean): void
  /** 单测注入 */
  exists?(path: string): boolean
  writeMarker?(path: string): void
  log?(message: string, data?: Record<string, unknown>): void
}

export function startupMarkerPath(userDataDir: string): string {
  return join(userDataDir, STARTUP_MARKER_FILE)
}

function markerWriter(deps: StartupDeps): (path: string) => void {
  return deps.writeMarker ?? ((path) => writeFileSync(path, `${new Date().toISOString()}\n`, 'utf8'))
}

/**
 * 首次打包启动时确保「开机自启」已注册。
 * 返回 `skip-dev`（开发态）/ `already`（标记已在，用户可能自己关掉了）/ `registered`（本次处理）。
 */
export function ensureStartupRegistration(deps: StartupDeps): StartupRegistration {
  if (!deps.packaged) return 'skip-dev'
  const marker = startupMarkerPath(deps.userDataDir)
  const exists = deps.exists ?? existsSync
  if (exists(marker)) return 'already'
  // 即使系统里已经开着也重写一次：把启动项路径校正到当前 exe
  // （先跑过免安装目录 / 移动过安装位置时，旧路径会留在 HKCU Run 里）
  deps.setLoginItem(true)
  deps.log?.('startup registration ensured', { marker })
  markerWriter(deps)(marker)
  return 'registered'
}

/** 托盘勾选：改系统启动项；标记同时落盘，避免下次启动又被 `ensureStartupRegistration` 改回去。 */
export function setStartupEnabled(deps: StartupDeps, enabled: boolean): void {
  if (!deps.packaged) return
  deps.setLoginItem(enabled)
  const marker = startupMarkerPath(deps.userDataDir)
  const exists = deps.exists ?? existsSync
  if (!exists(marker)) markerWriter(deps)(marker)
  deps.log?.('startup toggled', { enabled, marker })
}
