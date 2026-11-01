# 自调用与自主作息（草案 v0.1）

> **状态：草案，未拍板。** 三个待定项见 §7；拍板后再决定并入 `llm-call.md` §5 还是独立成文。
> 来源：2026-11-01 与拍板人的对话（「sleep 是不是多余」/ 三种定时情况 / 心情打分 / 主动 vs 被动）。
> 上位设计：`docs/agent/llm-call.md` §5（任务记忆与调度）、§5.4（follow-up review）、§5.5（合流）；本草案只细化「自调用」这一刀，不改上位设计的其余部分。

## 0. 一句话

ta 的「作息」只由任务表决定：**有到期任务就醒，没有就睡**。`sleep` 不是独立概念，它就是「下一条任务排在未来某一刻」。

## 1. 现状（2026-11-01 核对）

| 能力 | 状态 | 依据 |
| - | - | - |
| 定时 commit / push 记忆仓 | ✅ 已实现 | `src/main/memory-schedule.ts` |
| 问记忆 / 对话循环 | ✅ 已实现 | `src/chain/agent/loop.ts` |
| `mem_tasks` 表、调度器、`schedule_task` | ❌ 未实现 | `llm-call.md` §12 第 6 步；`src/memory/schema.ts` 仍是 v10（五张表，无 `mem_tasks`） |
| perceive / act 两段式 | ❌ 未实现 | §12 第 4 步（还压着「体验关口」） |
| `self.md` / `routine.md` | ❌ 未实现 | §12 第 7 步；`src` 里搜不到这两个字面量 |

> 结论：当前任何「自我」都只有 [`persona.ts`](../../src/memory/persona.ts) 拼的人设段与 `payload.ts` 的 `<now>`，没有 `self.md` / `routine.md` 的装配路径。自调用要落地，绕不开先建任务表与调度器。

## 2. 统一任务模型

一条任务 = 一行 `mem_tasks`：

| 字段 | 含义 |
| - | - |
| `kind` | `checkin` / `idle` / `wake` / `remind`（见 §3） |
| `at` / `next_due_at` | 下一次该醒的本地毫秒时间戳 |
| `instruction` | 醒来那一轮做什么（自然语言，进 perceive/act 的任务上下文） |
| `status` | `pending → due → running → done / skipped` |
| `repeat` | 空（一次性）/ `daily` / `weekly` |
| `mood_snapshot` | 排这条任务时的心情（只有 `idle` 用） |
| `last_run_at` | 去重与「错过不补」的判断依据 |

调度规则（沿用 `llm-call.md` §5.3，未实现）：

- 30s 检查一次到期任务；同一时刻只跑一个 agent turn（单飞）。
- 错过 > 30 分钟不补，直接 `skipped` 并记日志。
- 到点任务的合流按 §5.5：`checkin` / `remind` 属于要合流的一类（用户提问时先接用户、再自然带出）；`idle` 是后台类，静默排在当前 turn 之后，不弹窗。

## 3. 三种「定时情况」→ 三种 `kind`

| 拍板人说法 | `kind` | 默认 instruction | 醒来后做什么 |
| - | - | - | - |
| 30 分钟后冒个泡 | `checkin` | 「跟他说句话」 | 跑一轮，说一句就完；不自行续排 |
| 30 分钟后找点事做 | `idle` | 「按心情挑一件事做」 | 读 `mood_snapshot` + 行动注册表挑一个行动；本轮注册表为空 → 记一行日志、什么都不做 |
| 8 小时后起床 | `wake` | 「该醒了」 | 跑一轮，照常待命 |
| 用户说了一个计划 | `remind` | 用户原话（如「提醒他交周报」） | 到点提醒或说句话 |

**没有 pending 任务 = 真睡**：进程里没有任何定时唤醒，零出云。

## 4. 心情（mood）

- 八维，取值 `0 / 1`（有 / 没有）：`happy` `sad` `angry` `boring` `afraid` `expect` `nervous` `worried`，可再扩。
- 表达方式（**待拍板，见 §7-2**）：
  - **A（推荐）工具 `set_mood`**：ta 想报就调，不调就沿用上一次。只改工具 description，不碰提示词（常驻指令 14 的唯一例外就是工具描述）。
  - **B 主回答 JSON 加字段**：要让模型在固定输出契约里多写一段，属于改提示词，需拍板人明确放行。
- 存储：settings 键 `memory.mood_state`（JSON + 时间戳），不新建表。
- 用途：**只给 `idle` 挑行动**用；不参与主回答，不写在脸上。

## 5. 主动 vs 被动

- **主动**：`checkin` / `idle` / `wake` 由 ta 自己在收尾判断里排（§6）；排不排、排多远，它自己定。
- **被动**：用户在对话里说了计划 → ta 调 `schedule_task` 写 `mem_tasks` → 到点 `remind`。这是 `llm-call.md` §5.2 已有设计。
- **行动注册表（本轮为空）**：以后每加一个心情行动，就往注册表里塞一条（匹配心情、动作、是否需要用户在场）；调度器不用动。
  - 候选（本轮**都不做**）：`boring` → 刷 B站 / 知乎并分享；`sad` / `happy` / `angry` / `expect` → 发 QQ 空间；`nervous` → 反复吐槽；`worried` → 反复确认（拍板人原话「感觉不太顺手」，nervous / worried 明确不做）。

## 6. 收尾：每轮结束要不要排下一个任务

- 每个 turn 结束跑一次收尾判断，输出「下一个任务」或「不排」。
- 不排 = 睡到下一个已有任务（可能永远不醒）。
- 额度与开关：设置里一个总开关（**默认关**），加每日醒来上限（建议 24 次，超了跳过并记日志，数值待定）。

## 7. 待拍板（3 项）

1. **醒来那一轮走哪条循环？**
   - A：复用现有 `src/chain/agent/loop.ts`（instruction 当问题，不弹窗；改动最小，但要碰 `src/chain/agent` 加工具名）。
   - B：按 D57 在 `src/memory/agent/` 另写薄循环（不碰 chain，工具 / 退避 / 解析 / trace 要重做一遍）。
   - 倾向：A。
2. **心情怎么表达？** A 工具 `set_mood`（推荐，不碰提示词）／ B 主回答 JSON 加字段（需放行改提示词）。
3. **额度**：默认关 + 每日上限（建议 24 次），行不行？

## 8. 本轮范围

**做**：`mem_tasks`（schema v11）+ 30s 调度器（单飞、错过不补）+ 四个工具（`schedule_task` / `cancel_task` / `update_task` / `set_mood`）+ 收尾判断 + 设置开关与「下次醒来时间」显示 + 单测 + 文档。

**不做**：perceive / act 两段式重写；`self.md` / `routine.md` 文件本身；夜报 / 周报；具体心情行动（注册表留空）；免打扰时段 / 开机自启（2026-10-29 已拍板本轮不做）；任何提示词改动（只改工具 description，见 §7-2）；多端 / 云同步。

## 9. 验收（草案）

- 单测：`next_due` 四种形态（一次性 / 每天 / 每周 / 指定时刻）、去重、错过 >30 分钟不补、单飞、收尾判断解析失败回退、开关关闭不跑、额度用尽跳过。
- 假模型端到端：设 2 分钟后 `checkin` → 到点跑一轮 → 标 `done` → 不重复。
- 真机：开开关，跟 ta 说「你睡 5 分钟，醒来叫我喝水」→ 5 分钟后自己醒并说一句。

## 10. 改动文件（预估）

- 新 `src/memory/agent/`：`tasks.ts`（解析 / `next_due` / 去重）、`scheduler.ts`（30s tick + 单飞）、`review.ts`（收尾判断）。
- `src/memory/schema.ts`：v11 `mem_tasks`。
- `src/main/index.ts`：组合根接线 + IPC。
- `src/main/memory-schedule.ts`：可能抽公共定时器（或只复制模式，不抽）。
- `src/chain/agent/tool-catalog.ts`、`tools.ts`、`payload.ts`（`<now>` 里的到期任务行）：加工具名与描述。
- 渲染层设置抽屉：开关 + 下次醒来时间。
- 单测 + `decisions.md` / `progress.md` 流水。

## 11. 工程量与风险

- 约 1.5–2.5 天（不含真机验收来回）。
- 主要风险：① 醒来那一轮的入口（§7-1）；② 出云账单（§7-3）；③ 与 §5.5 合流的时序（到点时用户正在提问）。

## 12. 与上位设计的关系

- 本草案只细化 `llm-call.md` §5 的「自调用」子集；perceive/act（§3）、向量回想（§4）、夜报周报（§6）不在本轮。
- 拍板后：若并入 `llm-call.md` §5，本文件改为指向；若保留独立，则更新 `architecture.md` 的「任务记忆 + 调度」行与 `AGENTS.md` 的事实源列表。
