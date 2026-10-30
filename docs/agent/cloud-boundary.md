# 出云安全边界（Cloud Boundary）

> 一句话：**安全只在「数据离开设备」的那一层生效；核心功能不 import 脱敏实现，也不被它的规则卡住。**
> 本文是 `AGENTS.md` 常驻指令第 13 条与 `docs/agent/security.md` 的实现说明；规则源仍是 `security.md`，这里只定「挂在哪、谁负责」。

## 1. 为什么解耦

改造前，`src/chain/agent/ask.ts` / `loop.ts` / `tools.ts` 直接 import `understand/cloud/redact.ts` 的 `buildChainAskPayload()` / `buildChainAskLoopPayload()` 和 `Redactable*` 类型。后果：

- **安全模块成了核心的编译依赖**：脱敏规则、载荷品牌、甚至一个常量改动都可能牵动问答主路径；
- **本机模型也被迫过墙**：本机 / 测试场景没有「离开设备」，却被同一套 `question-blocked` / 整段剔除规则限制；
- **新增核心功能要懂安全细节**：任何工具结果、证据字段都要先想「会不会被脱敏挡住」。

现在把两件事拆开：

| 职责 | 归属 | 位置 |
| - | - | - |
| 载荷协议：字段、截断、品牌、工具结果视图 | 核心 | `src/chain/agent/payload.ts` |
| 哪些文本允许出云（脱敏 / 阻断） | 安全边界 | `src/understand/cloud/ask-outbound.ts` |
| 远端 / 本机策略的选择与注入 | 组合根 | `src/main/index.ts` |
| 脱敏规则的唯一实现 | 安全规则源 | `src/understand/sanitize.ts` |

## 2. 端口与两种策略

核心只认识两个东西：

```ts
interface AskTextPolicy {
  redact(text: string): { text: string; redacted: boolean; blocked: boolean }
}

interface AskOutbound {
  buildAsk(question, evidence, options?): ChainAskBuildResult
  buildLoop(input): ChainAskLoopBuildResult
}
```

- `createCloudAskOutbound()`（`understand/cloud/ask-outbound.ts`）：`redact` = `redactSensitive`。**远端供应商必须用这个**；问题命中密码类规则 → `questionBlocked`，证据 / 工具结果命中 → 整条剔除。
- `createLocalAskOutbound()`（`chain/agent/payload.ts`）：`redact` = 直通，只做协议组装与截断。用于**同进程 / 本机模型与测试**；不用于任何 HTTP 出网（含 localhost —— 那仍然离开进程、按 `security.md` 边界 ③ 处理）。

两种策略共用同一套协议实现（`buildAskPayload` / `buildAskLoopPayload`），不会出现两份载荷格式；差异只在 `AskTextPolicy`。

## 3. 不变量（违反就是 bug）

1. **远端 LLM 只能拿云端策略产出的载荷**：`main/index.ts` 的 `askOptionsFor()` 注入 `createCloudAskOutbound()`；新增远端调用路径照此办理。
2. **核心不 import `understand/cloud/redact`，也不直接调用 `redactSensitive`**：`src/chain/agent/` 里出现这类 import 就是回退。
3. **脱敏规则只有一处**：规则增删改仍在 `understand/sanitize.ts`；`payload.ts` 不写规则，`ask-outbound.ts` 不写协议 / 截断。
4. **本机策略不改变协议**：`createLocalAskOutbound()` 与云端策略输出的字段、截断、品牌完全一致，只跳过规则判定。
5. **安全规则不能成为核心验收的前置**：核心单测 / 性能探针可注入本机策略；安全行为由 `tests/unit/ask-outbound.test.ts` 与既有脱敏用例单独守。
6. **旧导出只做兼容**：`redact.ts` 里的 `buildChainAskPayload()` / `buildChainAskLoopPayload()` 仍保留给旧管线、`deepseek.ts`、`fake-llm.ts` 与既有测试；新代码不要再 import 它们。
7. **会话回放只信云端视图（D64）**：`AskConversationPort` 存的 `CloudAskConversationTurn` 是**已经过策略、当时原样发出去**的消息；回放时逐字节透传，**不得从原始文本重建、不得二次脱敏**（二次处理会改前缀，也会把 `[已脱敏]` 再加工）。会话存储只能在组合根（`main/ask-conversation.ts`）按 conversationId 存取，不能成为绕开策略的新入口。

## 4. 现状与迁移

| 范围 | 状态 | 说明 |
| - | - | - |
| 问记忆单发 / 工具循环（`chain/agent`） | ✅ 已解耦 | 核心 `ask.ts` / `loop.ts` / `tools.ts` 只依赖 `AskOutbound`；`redact.ts` 只剩兼容包装 |
| 出云确认门 / 日预算（`canSend` / `overBudget`） | 保留在组合根 | 仍是显式回调，核心不知道原因；本机模式由组合根决定是否传 |
| 派生层（`chain/derive/runner.ts`） | ✅ 已解耦 | 协议组装进 `chain/derive/payload.ts`，云端策略 `understand/cloud/derive-outbound.ts`；`runner.ts` 只依赖 `DeriveOutbound` |
| 旧「时刻—主题」管线（`understand/theme-*`） | 🧊 冻结 | 不改造，保持 `redact.ts` 旧导出 |

## 5. 验收

```bash
npm run typecheck
npx vitest run tests/unit/ask-outbound.test.ts \
  tests/unit/chain-agent-ask.test.ts \
  tests/unit/chain-agent-loop.test.ts \
  tests/unit/chain-agent-loop-edges.test.ts \
  tests/unit/sanitize.test.ts
```

`tests/unit/ask-outbound.test.ts` 的可执行口径：

- 同一句敏感问题（`密码` / `PIN 1234`），云端策略返回 `question-blocked`，本机策略正常走到模型并返回 `answer`；
- 同一段敏感证据，云端策略整段剔除，本机策略原样保留；
- 两种策略的循环载荷字段一致，只有命中集合不同；
- 派生层同样：`createCloudDeriveOutbound()` 整段剔除，`createLocalDeriveOutbound()` 原样保留（见 `tests/unit/chain-derive-outbound.test.ts`）。

## 6. 附：仍然会掣肘核心功能的项（现状清单）

> 这些不是本次改造的回退，而是下一步要逐项拍板的「摩擦源」。按对核心功能的影响排序。

| # | 摩擦源 | 现状 | 对核心的影响 | 建议 |
| - | - | - | - | - |
| 1 | **出云确认门（D24）是全局一次性开关** | `graph.outbound_consent=1` 才允许任何远端调用；问记忆、派生、旧图谱共用 | 新功能第一次跑真实模型前必须先确认；测试 / 演示都要先开门 | 保留远端门，但允许「本机模型」与「只读检索」绕过；确认文案按功能分项，而不是一次全开 |
| 2 | **问题 / 证据命中敏感规则就整次拒答** | `question-blocked`、整段 `blockedSegmentIds` | 「我的密码是多少」这类正常问法直接无回答；检索命中被悄悄变少 | 云端保留；本机模式直通；云端可改成「先本地检索 + 明示哪段被保护」，而不是整次拒答 |
| 3 | **本机模型路由尚未接线** | `resolveClient()` 只回客户端，不回「供应商是否本机」；组合根目前一律注入云端策略 | 本机模型接入后仍会被脱敏 / 确认门限制，直通策略没有选择依据 | 让 provider 解析结果带上 `local`（或 `baseUrl` 是否 loopback）；只有真本机（同进程 / 本机模型）走直通，HTTP 一律按出云 |
| 4 | **sanitize 的整帧丢弃规则影响采集覆盖** | `capture/pipeline.ts` 命中密码类词整帧丢弃（最近收紧了 `pin` 规则） | 这是本地隐私规则，但会减少 OCR 内容 / 段证据，直接影响「找得到」 | 把「本地隐私丢弃」与「出云脱敏」分成两份规则：本地只做密码输入框等结构判定，文本规则只用于出云 |
| 5 | **开工门按文件数 / 涉及面卡执行** | `AGENTS.md`：>2 文件或涉及行为 / 决策 / 依赖 / 出网 / 数据 / schema 必须先发理解卡 | 核心功能的小步重构也要停下来等确认，迭代节奏被流程切断 | 保留「行为 / 决策 / 数据」确认；把「出网」收窄为「新增离开设备的路径」，本地重构不再单独过安全门 |
| 6 | **冻结旧管线（D38）与新能力的边界** | `understand/theme-*` / `main/*-runtime` / `renderer/graph/` 只修 bug | 旧图谱页的问题不能顺手修，核心能力只能往 `chain/` 写 | 保持冻结；把「旧页只读兼容」写进验收，避免新功能被旧页拖住 |
| 7 | **测试只在提交前跑一次（D47）** | 不在开 PR / 合并前重复跑 | 本身不是安全项，但「只有一次机会」让重构时不敢大步走 | 保留 D47；重构类分支允许 `npm test -- <相关文件>` 增量跑，提交前仍跑全量一次 |
| 8 | **主进程 / worker 的同步重活** | 检索、向量、图谱布局已陆续搬 worker，但仍有同步段 | 核心功能一多就卡主线程，体感像「功能没做完」 | 延续性能方案：新重活默认进 `utilityProcess`，主进程只做编排 |
