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
          graph: resolve(__dirname, 'src/renderer/graph-preload.ts')
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
          graph: resolve(__dirname, 'src/renderer/graph/graph.html'),
          // P0 harness：合成数据的全局图验证页（P3 收口时移除或转正式页）
          harness: resolve(__dirname, 'src/renderer/graph/harness.html')
        }
      }
    }
  }
})
