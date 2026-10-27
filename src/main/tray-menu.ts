/**
 * 托盘 / 球右键菜单模板（m1b-plan §3 Phase 1 / Q4）
 *
 * 纯函数，不 import Electron：托盘与球右键共用同一份菜单（打开时间线 /
 * 暂停·恢复 / 退出），单测断言文案与状态映射（tests/unit/tray-menu.test.ts）。
 * 托盘图标用内联 PNG（nativeImage），不新增依赖。
 */

import type { CaptureStatus } from './capture-controller'
import type { MenuItemConstructorOptions } from 'electron'

export type TrayMenuActionId = 'open-graph' | 'open-ask' | 'open-timeline' | 'toggle-capture' | 'quit'

export interface TrayMenuAction {
  id: TrayMenuActionId
  label: string
  enabled: boolean
  click: () => void
}

export interface TrayMenuSeparator {
  type: 'separator'
}

export type TrayMenuEntry = TrayMenuAction | TrayMenuSeparator

export interface TrayMenuActions {
  /** D20：球点击默认打开图谱 */
  openGraph(): void
  /** 问记忆窗口（S3-lite） */
  openAsk(): void
  openTimeline(): void
  toggleCapture(): void
  quit(): void
}

/** 开关项文案：运行中显示「暂停记录」，暂停时显示「开始记录」（窄口径，D14） */
export function toggleLabel(status: CaptureStatus): string {
  if (status === 'running') return '暂停记录'
  if (status === 'starting') return '正在开始…'
  if (status === 'stopping') return '正在暂停…'
  return '开始记录'
}

/** 转换在途（starting / stopping）时禁用开关，避免连点排队 */
export function toggleEnabled(status: CaptureStatus): boolean {
  return status === 'running' || status === 'paused'
}

export function buildTrayMenu(status: CaptureStatus, actions: TrayMenuActions): TrayMenuEntry[] {
  return [
    { id: 'open-graph', label: '打开图谱', enabled: true, click: actions.openGraph },
    { id: 'open-ask', label: '问记忆', enabled: true, click: actions.openAsk },
    { id: 'open-timeline', label: '打开时间线', enabled: true, click: actions.openTimeline },
    { type: 'separator' },
    {
      id: 'toggle-capture',
      label: toggleLabel(status),
      enabled: toggleEnabled(status),
      click: actions.toggleCapture
    },
    { type: 'separator' },
    { id: 'quit', label: '退出', enabled: true, click: actions.quit }
  ]
}

function isSeparator(entry: TrayMenuEntry): entry is TrayMenuSeparator {
  return (entry as TrayMenuSeparator).type === 'separator'
}

/** 菜单项 → Electron 模板（托盘与球右键共用；类型导入不引入 Electron 运行时） */
export function toMenuTemplate(entry: TrayMenuEntry): MenuItemConstructorOptions {
  if (isSeparator(entry)) return { type: 'separator' }
  return { id: entry.id, label: entry.label, enabled: entry.enabled, click: entry.click }
}

/** 托盘图标：32×32 圆球（浅色球体 + 深色内核），内联 PNG，见 §5「不新增依赖」 */
export const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA40lEQVR4nM2XzQ3DIAyFM1JHYIIqI0RdiJEYISOwgCV89C29UCmizo+B6HF4lyjx+2JjMBOxTEhBzWsAHLF4YgnEkohly0r5mc/vdAdYiCXuDK8U8zfNAC9iWQ3GpdYcowpgLtJcq5RjmQDmDsalVIijtPf4cy0Tf+XQAFpqfmdNnAIsD5r/tJwBWFqtVvEIwN0N4t4fVQYIpwH4FnMjhNcAQqu5ASJoAJet1xEgaQDN6TeWYTwAeAngixDehvCNCL4VD3EYwY/jIQYS+Eg2xFC6LwdsLC+7A3IxKQW7mj0mOMAXdEoP/PZpigYAAAAASUVORK5CYII='
