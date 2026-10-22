import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

// M1b Phase 1：main + 双 preload（时间线 / 球）+ renderer（时间线 / 隐藏采集窗口 / 球）
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
          ball: resolve(__dirname, 'src/renderer/ball-preload.ts')
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
          ball: resolve(__dirname, 'src/renderer/ball/ball.html')
        }
      }
    }
  }
})
