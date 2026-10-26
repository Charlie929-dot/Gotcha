/**
 * chain_hook 冒烟脚本：真机验证原生事件源能装钩子、能吐事件、能停干净
 *
 * 用法：`npm run chain-hook-smoke -- [秒数]`（默认 15 秒）
 *
 * 只打印统计与几条样本，**不落盘、不写库**。检查点：
 * 1. 能不能加载 `.node`（加载失败就说明没编译 / ABI 不对）；
 * 2. 前台事件是否带上了 exe / 标题 / 应用名；
 * 3. 鼠标移动是否被抽稀（不是每 8ms 一条）；
 * 4. `lastInputTickMs` 是否前进（键盘判断靠它）；
 * 5. `stop()` 之后钩子是否真卸掉（还在刷就是没卸）。
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { normalizeRawEvent } from '../src/chain/hook/native.ts'
import type { RawDesktopEvent } from '../src/chain/hook/types.ts'

const requireFromHere = createRequire(import.meta.url)

const seconds = Number(process.argv[2] ?? 15)
if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error('用法：npm run chain-hook-smoke -- [秒数]')
  process.exit(1)
}

const candidates = [join(process.cwd(), 'native', 'chain-hook', 'build', 'Release', 'chain_hook.node')]
const modulePath = candidates.find((candidate) => existsSync(candidate))
if (!modulePath) {
  console.error('找不到编译产物：')
  for (const candidate of candidates) console.error(`  - ${candidate}`)
  console.error('先跑 npm run build:native')
  process.exit(1)
}

interface Binding {
  start(callback: (event: unknown) => void): void
  stop(): void
  lastInputTickMs(): number
  version?: string
  status?: () => Record<string, unknown>
}

const binding = requireFromHere(modulePath) as Binding
console.log(`已加载 ${modulePath}（版本 ${binding.version ?? '未知'}）`)

const counts = new Map<string, number>()
const samples: RawDesktopEvent[] = []
let total = 0
let invalid = 0

binding.start((raw) => {
  total += 1
  const event = normalizeRawEvent(raw)
  if (!event) {
    invalid += 1
    return
  }
  counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
  if (samples.length < 6) samples.push(event)
})

const tickStart = binding.lastInputTickMs()
console.log(`start() 之后的状态：${JSON.stringify(binding.status?.() ?? {})}`)
let elapsed = 0
const timer = setInterval(() => {
  elapsed += 1
  console.log(
    `… ${elapsed}s  事件 ${total} 条，tick 前进 ${binding.lastInputTickMs() - tickStart}ms，` +
      `计数 ${JSON.stringify(binding.status?.() ?? {})}`
  )
}, 1000)

setTimeout(() => {
  clearInterval(timer)
  const atStop = total
  const tickAtStop = binding.lastInputTickMs()
  binding.stop()

  setTimeout(() => {
    console.log('\n--- 统计 ---')
    for (const [type, count] of counts) console.log(`${type}: ${count}`)
    console.log(`不合格事件（已丢弃）: ${invalid}`)
    console.log(`lastInputTickMs 前进: ${tickAtStop - tickStart}ms`)
    console.log('\n--- 样本 ---')
    for (const sample of samples) console.log(JSON.stringify(sample))
    const afterStop = total - atStop
    console.log(`\nstop() 之后新增事件: ${afterStop}（应为 0，前面动一下鼠标再等片刻）`)
    process.exit(afterStop === 0 ? 0 : 1)
  }, 1500)
}, seconds * 1000)
