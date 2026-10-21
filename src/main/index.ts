import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { resolveCapture } from './args'

let mainWindow: BrowserWindow | null = null

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    show: false, // M1a 无常驻 UI；时间线是 Phase 3 的 dev 工具窗口
    width: 1024,
    height: 768,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  const capture = resolveCapture(process.argv, process.env)
  if (capture) {
    console.log('[gotcha] 采集开启（--capture / GOTCHA_CAPTURE=1）')
  } else {
    console.log('[gotcha] 采集默认暂停（A3 红线）：无 --capture 且 GOTCHA_CAPTURE≠1，无任何采集行为')
  }
  createMainWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})
