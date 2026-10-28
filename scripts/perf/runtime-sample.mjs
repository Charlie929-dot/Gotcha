/**
 * 运行态采样：N 秒内 electron 进程组的 CPU 与磁盘写增量。
 * 用来量化「采集开着时」的常态开销（含重复帧的 PNG 落盘）。
 *
 * 用法：node scripts/perf/runtime-sample.mjs [--seconds 30]
 */
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const secondsArg = args.includes('--seconds') ? Number(args[args.indexOf('--seconds') + 1]) : 30
const windowSeconds = Number.isFinite(secondsArg) && secondsArg > 0 ? secondsArg : 30

function sample() {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Select-Object ProcessId,CommandLine,ReadTransferCount,WriteTransferCount,OtherTransferCount,KernelModeTime,UserModeTime | ConvertTo-Json -Compress"
    ],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
  )
  const parsed = JSON.parse(out)
  return Array.isArray(parsed) ? parsed : [parsed]
}

const beforeRows = new Map(sample().map((row) => [row.ProcessId, row]))
if (beforeRows.size === 0) {
  console.log('没有找到 electron 进程：应用没在跑（npm run dev / 打包版都算 electron.exe）')
  process.exit(0)
}
const t0 = Date.now()
await new Promise((resolve) => setTimeout(resolve, windowSeconds * 1000))
const afterRows = sample()
const seconds = (Date.now() - t0) / 1000

let writeDelta = 0
let readDelta = 0
let cpuDelta = 0
const perProcess = []
for (const row of afterRows) {
  const prev = beforeRows.get(row.ProcessId)
  if (!prev) continue
  const w = Number(row.WriteTransferCount) - Number(prev.WriteTransferCount)
  const r = Number(row.ReadTransferCount) - Number(prev.ReadTransferCount)
  const c =
    (Number(row.KernelModeTime) +
      Number(row.UserModeTime) -
      Number(prev.KernelModeTime) -
      Number(prev.UserModeTime)) /
    1e7
  writeDelta += w
  readDelta += r
  cpuDelta += c
  const cmd = String(row.CommandLine ?? '').slice(0, 70)
  perProcess.push({
    pid: row.ProcessId,
    writeMBps: +(w / 1e6 / seconds).toFixed(2),
    cpuPct: +((c / seconds) * 100).toFixed(1),
    cmd
  })
}

console.log(`采样 ${seconds.toFixed(1)} s，${afterRows.length} 个 electron 进程`)
console.log(
  `合计：写 ${(writeDelta / 1e6 / seconds).toFixed(2)} MB/s（折算 ${((writeDelta / 1e9) * 86400 / seconds).toFixed(0)} GB/天），` +
    `读 ${(readDelta / 1e6 / seconds).toFixed(2)} MB/s，CPU ${((cpuDelta / seconds) * 100).toFixed(1)}%（单核百分比）`
)
for (const item of perProcess.sort((a, b) => b.writeMBps - a.writeMBps)) {
  console.log(
    `  pid ${String(item.pid).padEnd(7)} 写 ${String(item.writeMBps).padStart(6)} MB/s  CPU ${String(item.cpuPct).padStart(5)}%  ${item.cmd}`
  )
}
