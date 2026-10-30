/**
 * 个人记忆 CLI 的运行器：先把 `scripts/memory-cli.mts` 用 vite 打成 node 可跑的 ESM，
 * 再把参数原样传过去。
 *
 * 为什么要这一层：`src/` 是 bundler 解析的 TS，内部 import 不带扩展名，
 * `node scripts/memory-cli.mts` 会在第一个 `../src/db` 处失败。用一个临时产物换掉
 * 「为了跑个 CLI 去引入 tsx/ts-node」的依赖。
 *
 * 产物在 `.tmp/memory-cli/`（已在 .gitignore 之外也无所谓：它是构建缓存）。
 */
import { build } from 'vite'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const outDir = join(process.cwd(), '.tmp', 'memory-cli')

await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    ssr: join(process.cwd(), 'scripts', 'memory-cli.mts'),
    outDir,
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: { output: { entryFileNames: 'memory-cli.mjs' } }
  }
})

process.argv = [process.argv[0], join(outDir, 'memory-cli.mjs'), ...process.argv.slice(2)]
await import(pathToFileURL(join(outDir, 'memory-cli.mjs')).href)
