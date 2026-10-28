import { defineConfig } from 'vitest/config'

/**
 * 性能基线用例（读真实库、真实模块，不进 CI 的默认套件）。
 *
 * 用法：npx vitest run --config tests/perf/vitest.perf.config.ts
 * 库路径：%APPDATA%\Gotcha\memory.db（库不存在时整组 skip）。
 */
export default defineConfig({
  test: {
    include: ['tests/perf/**/*.perf.test.ts'],
    environment: 'node',
    testTimeout: 120_000
  }
})
