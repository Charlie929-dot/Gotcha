/**
 * 问记忆的**云端**出云边界实现。
 *
 * 核心（`src/chain/agent/payload.ts`）只负责协议组装；「哪些文本允许离开本机」
 * 是安全策略，放在这里。组合根（`main/index.ts`）只在使用**远端供应商**时
 * 注入本实现——本机模型 / 测试可以注入 `createLocalAskOutbound()` 直通。
 *
 * 不变量：
 * - 任何远端 LLM 调用都必须拿到本模块产出的载荷（`redactSensitive` 已生效）；
 * - 本模块之外不得再出现「为出云而脱敏」的调用（旧 `redact.ts` 里的同名包装
 *   只为兼容旧管线保留，内部同样走这里）；
 * - 脱敏规则本身仍在 `understand/sanitize.ts`（唯一规则源）。
 */

import {
  createAskOutbound,
  type AskOutbound,
  type AskTextPolicy
} from '../../chain/agent/payload'
import { redactSensitive } from '../sanitize'

/** 出云文本策略：密码类规则整条阻断，其余命中片段替换为 `[已脱敏]` */
export const cloudAskTextPolicy: AskTextPolicy = {
  redact: (text) => redactSensitive(text)
}

/** 远端供应商专用：问记忆载荷的脱敏边界 */
export function createCloudAskOutbound(): AskOutbound {
  return createAskOutbound(cloudAskTextPolicy)
}
