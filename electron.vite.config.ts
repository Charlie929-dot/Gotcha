import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

// M2 Phase 2：main + 三 preload（时间线 / 球 / 图谱）+ renderer（时间线 / 隐藏采集窗口 / 球 / 图谱）
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/preload.ts'),
          ball: resolve(__dirname, 'src/renderer/ball-preload.ts'),
          graph: resolve(__dirname, 'src/renderer/graph-preload.ts'),
          ask: resolve(__dirname, 'src/renderer/ask-preload.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          capture: resolve(__dirname, 'src/renderer/capture.html'),
          ball: resolve(__dirname, 'src/renderer/ball/ball.html'),
          // 默认全局图谱（v0.3：主题 + 时刻 + 日历调暗）
          graph: resolve(__dirname, 'src/renderer/graph/global.html'),
          // 旧 sigma 按日视图保留开关（工具栏「全局视图 / 经典视图」互切）
          graphClassic: resolve(__dirname, 'src/renderer/graph/graph.html'),
          // 问记忆（S3-lite）：输入框 + 回答栏 + 引用段证据
          ask: resolve(__dirname, 'src/renderer/ask/ask.html')
        }
      }
    }
  }
})
