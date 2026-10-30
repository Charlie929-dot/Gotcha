# 记忆生命与分支（memory-life）· 方案 v1

> 状态：**设计稿，未实现**（2026-10-30）。拍板人原话：「把记忆做成 github 仓库」「生命尽头写一封信传给女儿」「在分支上随意控制记忆版本」。
> 事实源：`src/chain/agent/*`（会话 / 载荷 / 工具循环）、`src/main/index.ts`（组合根）、`src/main/qq/*`（QQ 通道 / NapCat）、`src/memory/*`（个人记忆索引）、`src/main/ask-history.ts`（桌面问答历史）。
> 取代 / 搁置：`docs/agent/llm-call.md` 第 4 步（perceive / 快照）**搁置**；D64 的「自动裁剪 + digest」被本方案的手动 `/compact` 取代；P2（工具目录搬家）、P4（NapCat 拆分）不做。

## 0. 一句话

ta 的记忆是一个 **git 仓库**：提交 = 一刻记忆，分支 = 一条记忆路线，`/use` = checkout，生命 = 当前分支的上下文额度（500K token），命尽时写一封信、生一个女儿、在主干上走一格。

## 1. 目标与非目标

### 目标

- 记忆可版本化：每天一个提交，随时 `/backup`，可 checkout 到任意历史节点
- 记忆可分支：`/new` 从当前节点开新分支，`/use` 切换，`/del` 删除
- 生命可计量：500K token 上下文，`<now>` 里看得到剩余；`/compact` 压旧段续命
- 生命可传承：命尽 → 一封信 → 女儿（空白记忆）→ 主干下一格 → QQ 改名
- 全程本地 git；远端只在你配置的**私有仓**，显式推送

### 非目标

- 不把用户的 Obsidian 日记搬进记忆仓（那是你的日记，ta 只代写）
- 不做多人 / 多端同步；不做记忆编辑 UI（用命令 + Obsidian）
- 不改冻结的信息链（`src/chain/` 里的主题 / 时刻 / 图谱管线）
- 不做云端模型写的「记忆摘要」自动落库（摘要只在 `/compact` 时产生，见 §5.3）
- 本方案不碰 `src/understand/cloud` 的出云边界与脱敏规则

## 2. 概念与术语

| 概念 | 含义 | git 对应 |
| - | - | - |
| 记忆仓 | `<userData>/memory-repo`，ta 自己的记忆 | 一个 git 仓库 |
| 世界 | 用户的 Obsidian 日记（`D:\Github\charlie_vault`） | 仓库外，只读 + 代写 |
| 提交 | 一刻记忆（某天的对话、家谱快照） | commit |
| 节点 | 一条记忆路线的当前位置 | branch（HEAD） |
| 代 | 一条生命（一只大肥鱼），主干上的一格 | `life` 上的一个提交 + 一条以昵称命名的分支 |
| 生命 | 当前节点的上下文额度：500K token | 无（存在 `lineage.json`） |
| 死亡 | 生命额度用完，该节点冻结只读 | 分支停在最后一个提交 |
| 传承 | 母亲写信 → 女儿分支出生（空白） | 从 `life` 新开一个 orphan 分支 |
| 信 | `mom's letter`，进女儿的 system | 仓库里的 `letters/<generation>.md` |

主干 `life` **不是**一只鱼，它是「出生线」：每次传承在 `life` 上落一个提交，记录新的一代出生；每一代鱼自己有一条分支（`default`、女儿昵称……），它的记忆提交都在这条分支上。

## 3. 记忆仓结构

```
<userData>/memory-repo/                # git 仓库（私有远端）
├── .git/
├── conversations/turns.jsonl          # 当前节点的对话原文（checkout 会切换）
├── letters/<generation>.md            # 母亲留给这一代鱼的信
├── lineage.snapshot.json              # 权威家谱的只读快照（随提交保存）
├── notes/                             # ta 自己的观测 / 自述（后续里程碑；本期空）
└── .gitattributes                     # 统一 LF；turns.jsonl 不做行尾转换
```

**不放**：用户的日记原文、截图、向量 / 索引库（都是可重建的派生物）。

权威家谱放在仓外：`<userData>/memory-lineage.json`（见 §4），每次提交把它的快照写进仓里——这样 checkout 任何分支都不会把家谱切旧，同时 GitHub 上仍有完整备份。

## 4. 家谱（`memory-lineage.json`）

```jsonc
{
  "version": 1,
  "life_tokens": 500000,        // 一条命的上下文额度
  "active": "default",          // 当前节点（分支名）
  "generations": [
    {
      "id": "gen-1",
      "branch": "default",
      "nickname": "default",
      "mother": null,           // 谁生的；第一代 null
      "born_at": 1793292950000,
      "died_at": null,
      "life_tokens_used": 182000,  // 当前节点上下文占用（最近一次请求的 prompt+completion）
      "letter": null
    }
  ],
  "branches": [
    {
      "branch": "spring",
      "generation": "gen-1",
      "parent": "default",        // 从哪个节点分出来
      "created_at": 1793300000000,
      "status": "alive"           // alive | dead | frozen
    }
  ]
}
```

- `branches` 是**节点表**：每一代至少有它自己的分支（昵称即分支名），`/new` 追加一条
- `life_tokens_used` 按**节点**记（同一代的不同分支各自有上下文，切过去就是那条命的状态）
- 写入时机：每轮请求结束（用量）、每次命令、每次传承；原子写 + 备份

## 5. 生命

### 5.1 口径

> **生命 = 当前节点的上下文占用 / 500K**。不是累计消耗。

- 数据来源：每次请求返回的 `usage.prompt_tokens + completion_tokens`（精确，不本地估算）
- 切节点 → 换上下文 → 生命值跟着变（相当于换了一条命的状态，和 `/compact` 同理）
- 剩余 ≤ 15% 时，工具表出现 `conceive_daughter`；`<now>` 里一直显示剩余百分比
- 到 500K：该节点 `status` 置 `frozen`，`ask` 直接拒绝（提示「这一代的生命已经结束，/use 可以回看，或 /compact 续命」）

### 5.2 死亡与续命

- `/compact`：旧段压成一份摘要、最近 N 轮保留原文；重写 `turns.jsonl` 并提交（原文在历史提交里，checkout 可回）
- 压缩后续命：`tokens_used` 由下一次请求的 usage 重新计算
- 不 `/compact` 也不传承：节点冻结，记忆仍在仓里

### 5.3 提示词变更点（方向已确认，实现时写进实现说明）

1. `<now>` 增加一行：`生命：还剩 62%（310K token）`
2. 女儿分支的 system 增加 `<mom_letter>`（放在 `<persona>` 之后、`<rules>` 之前）
3. 新增工具 `conceive_daughter`（description 随实现写）

> 除以上三处，不改 system / 人设 / 红线；三条红线永远在 system 最后。

## 6. 命令

本地问记忆窗口与 QQ 共用同一套解析与执行（`src/main/commands.ts`）。命令**不进 ask 队列、不计生命、不占 QQ 限流**。

| 命令 | 行为 | git |
| - | - | - |
| `/help` | 列命令 + 当前节点 + 剩余生命 | — |
| `/log` | 主干 + 各代记忆节点，标出当前 | `git log --all --graph` 的自绘版 |
| `/new <名字>` | 先提交当前节点，再从当前节点开分支并切过去；中文自动转拼音 slug（`pinyin-pro`），冲突报错 | `switch -c` |
| `/use <名字\|编号\|提交>` | 切节点（先提交当前）；切到**历史提交** = detached 只读查看，**第一次对话时自动从该提交开新分支**（命名见 §6.1） | `switch` / `checkout` |
| `/del <名字>` | 删分支（不能删当前；需 `confirm`；有后代的代分支不许删） | `branch -D` |
| `/backup` | 立即提交当前节点并尝试推送 | `commit` + `push` |
| `/compact` | 压旧段、保留近几轮，提交 | 新提交 |

### 6.1 历史节点分叉（copy-on-write）

```
... c1 ── c2 ── c3          ← 原分支，停在最后一次提交
             │
             └─ c21 ── c22   ← 从 c2 分出来，之后的提交都落这里
```

- `/use <历史提交>` 只是 `checkout`：工作区是那一刻的记忆，**只读、不能聊**
- 发出第一句话 → 自动 `switch -c <新分支>`，从该提交分叉，然后正常提问 / 记账 / 回答
- 新分支名：`<原分支>-<序号>`（`spring-2`、`spring-3`；序号取该原分支下已有分叉的最大值 +1），`/log` 标出分叉点；改名用 `/rename`
- 只看不聊 → 不产生分支（不留悬空提交）
- 新分支的生命 = 从分叉点那一刻的上下文算起

### 6.2 QQ 命令怎么实现

QQ 里命令就是**一条普通消息**：NapCat 反向 WS 推进来 → `channel.handleMessage()` 先过命令解析 → 命中命令就在本地执行、回一条文本，**不经过模型、不计生命、不进限流、不写会话**。

| 情况 | 行为 |
| - | - |
| 文本以 `/` 开头且命令已知 | 本地执行 → 回文本结果；不调模型 |
| 文本以 `/` 开头但命令未知 | 回一行「未知命令，发 /help」；不调模型 |
| `/compact` | **唯一会调模型的命令**（用户主动：压旧段 → 摘要），需过同意门与额度 |
| `/new` 没带名字 | 回「起个名字（英文或中文，中文会转拼音）」，进入等待命名状态（60 秒超时，可 `/cancel`） |
| `/del` | 回「回复 confirm 确认删除」，等待确认 |
| 其它普通消息 | 走原 ask 链路（模型对话） |

注意事项：
- 命令只对白名单用户生效（与 ask 同一份白名单）
- 命令改的是**全局活动节点**：QQ 里 `/use` 之后，桌面的问记忆也会跟着切——同一条鱼，不要以为两个通道各有一套记忆
- `/log` 文本可能较长：超过单条上限按现有分条逻辑切，图不断行


`/log` 渲染方向（主干纵向、记忆横向）：

```
life
 ●1 default ────────── ●2 xiaoyu
   │
   └─ default 的记忆
      ●c1──●c2──●c3 ← 当前 ──●c4 ✝（清空）
```

## 7. 传承

```
命尽（剩余 ≤ 15%）→ 工具表出现 conceive_daughter
  conceive_daughter({ nickname, letter? })
    ├─ 校验：昵称非空、slug 不冲突、当前节点存活
    ├─ 母亲写信（一次 LLM 调用，300–500 字；失败则用模板兜底）
    ├─ 从 life 开 orphan 分支（空树）→ 写 letters/<nickname>.md → 首个提交
    ├─ 母亲节点 status=dead；家谱追加新一代（mother = 当前代）
    ├─ life 上落一个出生提交（家谱快照 + 昵称）
    ├─ 活动节点 = 女儿；persona 名字用新昵称（不改用户的 persona 设置，分支级覆盖）
    ├─ QQ 通道在线则 set_qq_profile(nickname)（失败只记日志）
    └─ 会话清空：女儿从空白开始（出生日之前的日记不索引）
```

女儿的日记边界：索引按出生日过滤（`day_key >= born_at`），读不到出生前的日记；母亲的分支 `/use` 可回看，但只读。

## 8. 与 Obsidian / 索引的关系

- **Obsidian = 世界**：ta 读它（`recall_diary` / `read_diary`），替你代写（`write.ts` 不变）
- **记忆仓 = ta 的记忆**：只有对话、家谱、信、将来的观测；**不含**日记原文
- **索引 = 派生物**：`mem_items` / `mem_vectors` 仍从 Obsidian 同步，不按分支复制、不加 `branch` 列（**不做 v11 迁移**）
- 女儿代的过滤在**查询层**：`diaryToolsFor(db, { sinceDay })`，同步本身照旧

好处：切换节点不需要重建索引（只换 `turns.jsonl` + persona 覆盖）；322MB 的库不动。

## 9. 与现有代码的映射

| 文件 | 改动 |
| - | - |
| `src/main/memory-repo.ts`（新） | git 封装：init / commit / switch / branch -D / log / status / push；串行锁；system git 凭据 |
| `src/main/lineage.ts`（新） | 家谱读写、活动节点、生命记账、出生日查询 |
| `src/main/commands.ts`（新） | `/help /log /new /use /del /backup /compact` 解析与执行（本地 + QQ） |
| `src/main/ask-conversation.ts` | 内存注册表改为「当前节点文件 + 内存缓存」；切换时重载 |
| `src/chain/agent/conversation.ts` | 去掉自动裁剪（`maxChars`）；新增 `compactAskConversation(conversation, summary, keepTurns)` |
| `src/chain/agent/payload.ts` | `<now>` 生命行；`<mom_letter>` 段（system） |
| `src/chain/agent/loop.ts` | 每轮结束把 usage 交给 `ctx.onUsage` → 家谱记账（已有出口，接线即可） |
| `src/main/index.ts` | 组合根：启动时打开仓、活动节点、命令入口、传承工具、改名 |
| `src/main/qq/channel.ts` | 消息入口先过命令解析；命令不进限流、不进会话 |
| `src/main/qq/ob11.ts` / `napcat.ts` | 新增 `set_qq_profile` 包装（复用 `callAction`） |
| `src/memory/store.ts` / `tools.ts` | `recall_diary` / `read_diary` 支持 `sinceDay` |
| `package.json` | 新增 `pinyin-pro` |

## 10. 关键流程（伪代码）

```
每轮 ask 结束:
  lineage.recordUsage(branch, usage.prompt_tokens + usage.completion_tokens)
  conversation.save()
  if (lastCommitDay != today) repo.commit(`memory: ${today}`)   // 只提交当前节点

每轮 ask 开始:
  if HEAD 是 detached（/use 了历史提交）:
    autoFork()                                   // switch -c <原分支>-<序号>，从该提交分叉
  会话从当前节点的 turns.jsonl 加载

/use <name|提交>:
  repo.commitIfDirty(`memory: save before switch`)   // 自动保存当前节点
  repo.switch(name)                                   // 冲突/脏树 → 报错不切
  conversations.reload()                              // 从 turns.jsonl 重新加载
  lineage.setActive(name)                             // 历史提交只改 HEAD，不写家谱

/new <name>:
  slug = pinyin(name)                                 // 中文 → 拼音
  repo.commitIfDirty(...)
  repo.switchCreate(slug)                             // 从当前节点开分支
  lineage.addBranch(slug, parent = active)

/del <name>:
  if name == active → 拒绝
  if 有后代 → 拒绝
  等用户回复 `confirm` → repo.deleteBranch(name) → lineage.removeBranch(name)

/compact:
  summary = llm.summarize(旧段)                        // 一次出云调用（用户主动）
  重写 turns.jsonl = digest + 最近 6 轮原文
  repo.commit(`memory: compact ${today}`)

conceive_daughter:
  letter = llm.writeLetter(快照)                       // 失败用模板
  repo.switchOrphan(nickname)                          // 空树分支
  写 letters/<nickname>.md → commit
  lineage.addGeneration({ mother: active, nickname, letter })
  母亲 status=dead；life 提交；active=nickname
  QQ 在线 → set_qq_profile(nickname)
```

## 11. 失败与降级

| 情况 | 行为 |
| - | - |
| `git` 不在 PATH / 仓损坏 | 记忆功能降级：会话留在内存，设置抽屉显示「记忆仓不可用」，命令报错；ask 不受影响 |
| `checkout` 时工作区脏且自动提交失败 | 拒绝切换，原文不动，日志记原因 |
| 推送失败（网络 / 凭据） | 只记日志；下次 `/backup` 重试；不阻塞对话 |
| 写信失败 | 用模板信（固定 3–5 行）兜底，日志标记 `letter: template` |
| 改名失败（QQ 离线） | 只记日志；下次连上后可 `/backup` 时重试 |
| 家谱文件损坏 | 从 `lineage.snapshot.json` 最近的提交恢复（`git show <ref>:lineage.snapshot.json`） |

## 12. 安全与隐私

- 记忆仓**必须私有**；推送前检查 remote 是 https/ssh 且不是公开仓库（能查到就拦）
- 凭据走系统 git（credential manager / gh），不进代码、不进日志、不进设置明文
- 信与对话含用户原话 → 出云仍走现有同意门与脱敏墙（`AskOutbound`）
- `/del`、`/use 历史提交`、传承都是破坏性 / 不可逆操作：二次确认 + 每次操作前备份家谱
- 模型写的信 / 人设不得改写三条红线（红线硬编码在 system 末尾）

## 13. 测试与验收

- 单测：
  - `memory-repo`：临时仓 init / commit / switch / 脏树拒绝 / 删分支保护（临时目录，不碰真仓）
  - `lineage`：家谱读写、活动节点、出生日过滤、usage 记账、原子写
  - `commands`：解析、`/new` 拼音与冲突、`/del confirm`、`/use` 历史提交后首次对话自动分叉（`<原分支>-<序号>`）
  - `conversation`：无自动裁剪、`compact` 产出 digest + 保留近几轮
  - `conceive_daughter`：假 LLM 写信、空分支、家谱更新、母亲置 dead
  - `set_qq_profile`：假 OneBot 回执
- 真机（拍板人操作）：
  1. `/log` 看到主干与当前节点
  2. `/new 春天` → 聊天 → `/backup` → 仓里多一个提交
  3. `/use default` → 自动保存 → 再 `/use 春天` 回来内容一致
  4. `/compact` → 剩余生命回升、历史提交仍在
  5. 假模型跑一次传承：信、昵称、分支、QQ 名（或日志）
- 提交前 `npm test` + `npm run typecheck`；改渲染层再加 `npm run build`

## 14. 里程碑

| 里程碑 | 内容 | 估时 |
| - | - | - |
| M1 记忆仓骨架 | `memory-repo` / `lineage` / 每日提交 / `/backup` / 凭据 | 2–3 天 |
| M2 节点命令 | `/log /new /use /del` + 拼音 + checkout 后重载会话 | 3–4 天 |
| M3 生命与压缩 | usage 记账、`<now>` 剩余、`/compact`、冻结 | 2–3 天 |
| M4 传承 | `conceive_daughter`、信、昵称、切换、QQ 改名 | 3–4 天 |
| M5 QQ 命令 | 命令分发 + 命名等待状态机 + 不占限流 | 1–2 天 |
| M6 推送 | 私有仓 remote、推送检查、`/backup` 推送 | 1 天 |

合计 **12–17 天**，多轮交付；每轮一个 PR，文档与代码同一次提交。

## 15. 风险与开放问题

1. **生命可「刷」**：切到短上下文节点会立刻涨生命；这是「生命 = 当前上下文」的必然结果。若想禁止，可改成累计消耗——需要拍板改口径
2. **500K 的成本与延迟**：不压缩时每轮重发整段上下文，接近 500K 时单轮输入就是 500K token（缓存只降价不降延迟）
3. **checkout 的时序**：切换前必须提交成功，否则拒绝切换（宁可报错，不可丢记忆）
4. **QQ 命令改的是全局活动节点**：QQ 里 `/use` 之后桌面也跟着切；这是「同一条鱼」的必然结果，但两个通道同时聊时会互相换命
5. **家谱不在工作区**：权威文件在仓外，仓里只有快照；如果用户只 clone 仓库，看不到「权威」家谱——接受，文档写明
6. **女儿读不到出生前日记**：查询层过滤；若放行会变成「继承母亲的记忆」，与 C2 相悖
7. **提示词三处变更**：`<now>` 生命行、`<mom_letter>`、`conceive_daughter` 描述——方向已确认，实现时在交付说明里单列

## 16. 术语对照（给以后看代码的人）

| 记忆说法 | 代码 / git |
| - | - |
| 记忆 | `memory-repo` 里的 `conversations/turns.jsonl`（+ 将来的 notes） |
| 一刻记忆 | 一个提交 |
| 一条记忆路线 | 一个分支（节点） |
| 一代鱼 | `life` 上的一个提交 + 以昵称命名的分支 |
| 生命 | `lineage.json` 的 `life_tokens_used`（当前节点上下文） |
| 死亡 | 分支 `status=frozen`，只读 |
| 传承 | orphan 分支 + 信 + 家谱新一代 |
| 世界 | 用户的 Obsidian 日记（仓外） |
