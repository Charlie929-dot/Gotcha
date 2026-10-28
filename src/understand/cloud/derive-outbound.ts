/**
 * 派生层（信息链抽取 / 双链合并）的云端出云边界实现。
 *
 * 核心 `src/chain/derive/payload.ts` 只做协议组装；远端供应商在组合根注入本实现，
 * 本机模型 / 测试用 `createLocalDeriveOutbound()` 直通。规则源仍是 `understand/sanitize.ts`。
 */

import {
  createDeriveOutbound,
  type DeriveOutbound,
  type DeriveTextPolicy
} from '../../chain/derive/payload'
import { redactSensitive } from '../sanitize'

export const cloudDeriveTextPolicy: DeriveTextPolicy = {
  redact: (text) => redactSensitive(text)
}

/** 远端供应商专用：派生层载荷的脱敏边界 */
export function createCloudDeriveOutbound(): DeriveOutbound {
  return createDeriveOutbound(cloudDeriveTextPolicy)
}
