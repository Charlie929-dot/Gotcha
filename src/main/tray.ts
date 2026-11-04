/**
 * 托盘（m1b-plan §3 Phase 1 / Q4）
 *
 * 最小托盘：打开时间线 / 暂停·恢复 / 退出；图标用内联 PNG（不新增依赖）。
 * 菜单文案与状态映射在 tray-menu.ts（纯函数，单测覆盖）。
 */

import { Menu, Tray, nativeImage } from 'electron'
import type { CaptureStatus } from './capture-controller'
import {
  autostartMenuEntry,
  buildTrayMenu,
  toMenuTemplate,
  TRAY_ICON_DATA_URL,
  type TrayMenuActions,
  type TrayMenuEntry
} from './tray-menu'

export interface TrayShell {
  tray: Tray
  update(status: CaptureStatus): void
  /** 启动自动恢复的 3s 提示（Windows 气球通知；不可用时静默） */
  balloon(title: string, content: string): void
  dispose(): void
}

/** 托盘「开机自启」勾选：只有打包态可用；状态以系统启动项为准 */
export interface TrayAutostart {
  available(): boolean
  enabled(): boolean
  toggle(): void
}

export function installTray(
  actions: TrayMenuActions,
  status: CaptureStatus,
  autostart?: TrayAutostart
): TrayShell {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  const tray = new Tray(icon)
  tray.setToolTip('记忆球 Gotcha')

  let currentStatus = status

  const entries = (): TrayMenuEntry[] => {
    const base = buildTrayMenu(currentStatus, actions)
    if (!autostart || !autostart.available()) return base
    // 托盘专用项：插在「记录开关」之后、「退出」之前（尾部固定是 separator + quit）
    const entry = autostartMenuEntry(
      { available: true, enabled: autostart.enabled() },
      () => {
        autostart.toggle()
        render()
      }
    )
    const insertAt = Math.max(0, base.length - 2)
    return [...base.slice(0, insertAt), entry, ...base.slice(insertAt)]
  }

  const render = (): void => {
    tray.setContextMenu(Menu.buildFromTemplate(entries().map(toMenuTemplate)))
  }

  const update = (next: CaptureStatus): void => {
    currentStatus = next
    render()
  }
  update(status)

  // Windows 下单击托盘图标打开「问记忆」（右键由 context menu 接管）；D51 之后时间线没有入口
  tray.on('click', () => actions.openAsk())

  const balloon = (title: string, content: string): void => {
    try {
      tray.displayBalloon({ icon, title, content })
    } catch {
      // 部分环境（无通知权限 / 非 Windows）不支持气球通知；静默，球上仍有倒计时角标
    }
  }

  return {
    tray,
    update,
    balloon,
    dispose: () => tray.destroy()
  }
}
