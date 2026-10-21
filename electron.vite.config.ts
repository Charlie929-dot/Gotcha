import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

// M1a Phase 0：仅 main + preload 两端（renderer 时间线视图 Phase 3 落地时再补）
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
        input: { index: resolve(__dirname, 'src/renderer/preload.ts') }
      }
    }
  }
})
