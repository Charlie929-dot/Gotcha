/**
 * 托盘（m1b-plan §3 Phase 1 / Q4）
 *
 * 最小托盘：打开时间线 / 暂停·恢复 / 退出；图标用内联 PNG（不新增依赖）。
 * 菜单文案与状态映射在 tray-menu.ts（纯函数，单测覆盖）。
 */

import { Menu, Tray, nativeImage } from 'electron'
import type { CaptureStatus } from './capture-controller'
import { buildTrayMenu, toMenuTemplate, TRAY_ICON_DATA_URL, type TrayMenuActions } from './tray-menu'

export interface TrayShell {
  tray: Tray
  update(status: CaptureStatus): void
  /** 启动自动恢复的 3s 提示（Windows 气球通知；不可用时静默） */
  balloon(title: string, content: string): void
  dispose(): void
}

export function installTray(actions: TrayMenuActions, status: CaptureStatus): TrayShell {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
  const tray = new Tray(icon)
  tray.setToolTip('记忆球 Gotcha')

  const update = (next: CaptureStatus): void => {
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(next, actions).map(toMenuTemplate)))
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
