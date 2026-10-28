/**
 * P1-4 探针：主线程 vs utilityProcess 跑同一段 512-token 推理，比「事件循环被挡多久」。
 *
 * 用法（仓库根目录，先 `npm run build` 出 out/main/embedding-worker.js）：
 *   npx electron scripts/perf/embed-probe
 *
 * 只看两件事：
 * 1. 主进程里直接 session.run()（老口径）时，10ms 心跳还能不能跳；
 * 2. 交给 out/main/embedding-worker.js（新口径）时，心跳照跳的频率 + 往返耗时；
 * 顺带验证 worker 返回的向量维度 / 归一化，以及连续两条请求的串行行为。
 */
const { app, utilityProcess } = require('electron')
const { join } = require('node:path')

const REPO = join(__dirname, '..', '..', '..')
const MODEL_DIR = join(REPO, 'resources', 'models', 'bge-small-zh-v1.5')
const WORKER = join(REPO, 'out', 'main', 'embedding-worker.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 10ms 心跳：返回「这段时间里实际跳了几次」 */
function startHeartbeat() {
  let beats = 0
  const timer = setInterval(() => {
    beats += 1
  }, 10)
  return {
    stop() {
      clearInterval(timer)
      return beats
    }
  }
}

async function heartbeatDuring(fn, label) {
  const beat = startHeartbeat()
  const t0 = performance.now()
  const result = await fn()
  const ms = performance.now() - t0
  const beats = beat.stop()
  const expected = Math.max(1, Math.round(ms / 10))
  console.log(
    `${label}: ${ms.toFixed(0)} ms，10ms 心跳 ${beats} 次（理论上限 ~${expected}，越低说明主线程被挡得越久）`
  )
  return result
}

function longText() {
  return '这段文字用来占满 512 个 token，模拟信息链里段收口时的正文。'.repeat(40)
}

app.whenReady().then(async () => {
  console.log(`worker = ${WORKER}`)
  console.log(`model  = ${MODEL_DIR}`)
  await sleep(200)

  // ---- 老口径：主进程里直接推理（用固定 [1,512] 输入，不依赖 tokenizer） ----
  try {
    const ort = require('onnxruntime-node')
    const session = await ort.InferenceSession.create(join(MODEL_DIR, 'model.onnx'), {
      intraOpNumThreads: 4,
      graphOptimizationLevel: 'all'
    })
    const ids = new BigInt64Array(512).fill(101n)
    const mask = new BigInt64Array(512).fill(1n)
    const types = new BigInt64Array(512)
    const runOnce = () =>
      session.run({
        input_ids: new ort.Tensor('int64', ids, [1, 512]),
        attention_mask: new ort.Tensor('int64', mask, [1, 512]),
        token_type_ids: new ort.Tensor('int64', types, [1, 512])
      })
    await runOnce() // 预热，别把首次图优化算进对比
    await heartbeatDuring(runOnce, '主进程内 session.run（老口径）')
    await session.release?.()
  } catch (error) {
    console.log(`主进程内对照失败（不影响 worker 结论）：${error && error.message}`)
  }

  // ---- 新口径：utilityProcess ----
  const child = utilityProcess.fork(WORKER, [], { serviceName: 'gotcha-embedding-probe' })
  const pending = new Map()
  let nextId = 0
  child.on('message', (message) => {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    entry(message)
  })
  const embed = (texts) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, (message) => {
        if (message.ok) resolve(message)
        else reject(new Error(`${message.code}: ${message.message}`))
      })
      child.postMessage({
        type: 'embed',
        id,
        profile: {
          key: 'chain',
          modelDir: MODEL_DIR,
          maxLength: 512,
          batchSize: 1,
          intraOpNumThreads: 4
        },
        texts
      })
    })

  try {
    const first = await heartbeatDuring(() => embed([longText()]), 'worker 首条（含加载模型 + 建会话）')
    const vector = first.vectors[0]
    let norm = 0
    for (const value of vector) norm += value * value
    console.log(
      `向量：dim=${first.dim}（实际 ${vector.length}），L2 范数=${Math.sqrt(norm).toFixed(4)}，model=${first.model}`
    )

    const warm = await heartbeatDuring(() => embed([longText()]), 'worker 热请求（512 token）')
    console.log(`热请求 dim=${warm.dim}`)

    // 串行性：同时发三条，worker 应该一条一条回
    const t0 = performance.now()
    const batch = await Promise.all([embed([longText()]), embed([longText()]), embed([longText()])])
    console.log(`并发 3 条全部返回：${(performance.now() - t0).toFixed(0)} ms（维度 ${batch.map((r) => r.dim).join('/')}）`)
  } catch (error) {
    console.log(`worker 探针失败：${error && error.message}`)
  } finally {
    child.kill()
    app.quit()
  }
})
