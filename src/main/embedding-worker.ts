/**
 * 向量推理工作进程入口（Electron `utilityProcess`；P1-4）
 *
 * 只做三件事：收消息 → 交给 `createEmbedWorkerHandler` → 回消息。
 * 会话（`onnxruntime-node`）与词表都在这个进程里，主进程不再直接跑推理，
 * 所以 512 token 的 258 ms 推理不会卡住球 / 热键 / IPC。
 *
 * 注意：
 * - 这里**不能** import 'electron' 之外的东西——utility process 只拿到 `process.parentPort`；
 * - 模型缺失 / 推理失败都以 `{ok:false, code}` 回去，不 throw 到进程级（否则整进程退出，
 *   主进程还要重建一次会话，白等 1s）；
 * - 日志红线不变：不打印文本、不打印向量。
 */

import { createEmbedWorkerHandler, type EmbedResponseMessage } from '../understand/embedding/remote'
import { createLocalEmbedder } from '../understand/embedding/session'

const port = process.parentPort

const handler = createEmbedWorkerHandler({
  createEmbedder: (profile) =>
    createLocalEmbedder({
      modelDir: profile.modelDir,
      maxLength: profile.maxLength,
      batchSize: profile.batchSize,
      intraOpNumThreads: profile.intraOpNumThreads
    })
})

port.on('message', (event) => {
  void handler
    .handle(event.data)
    .then((response: EmbedResponseMessage | null) => {
      if (response) port.postMessage(response)
    })
    .catch(() => {
      // handle 内部已经把业务错误包成 ok:false；这里只剩「连回包都失败」，丢掉即可。
    })
})
