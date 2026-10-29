# 个人记忆系统（vibe/free）

> 一句话：**给「记忆球」加第二本账——日记记忆**。屏幕记忆回答「我在电脑上做过什么」，
> 日记记忆回答「我当时怎么想、我的目标、我是什么样的人」。
>
> 参考：Hindsight 的 retain / recall / reflect + observations；dsh-bili-scroll 的
> 「人设 + 写死红线 + 窄工具面」写法。实现是 Gotcha 自己的，不引第三方记忆引擎。

分支：`vibe/free`（从 `main` `f3ae580` 切出）

---

## 1. 两本账

| | 屏幕记忆（既有） | 日记记忆（本分支新增） |
|---|---|---|
| 数据源 | 采集的窗口段（`events` / `chain_segment`） | `charlie_vault/daily/*.md` |
| 谁写的 | 机器 | 用户自己 |
| 回答什么 | 在哪个应用 / 页面 / 时间做过什么 | 想法、目标、情绪、待办、反复出现的主题 |
| 检索 | `search_info`（关键词 + 语义 + 时间过滤） | `recall_diary`（关键词 / 日期 / 标签） |
| 引用 | `citations[{segmentId}]`，点开看截图 + 正文 | `memories[{itemId}]`，直接摊原文片段 |
| 存储 | `events` / `chain_segment` … | `mem_items` / `mem_sources` / `mem_observations` |

两边可以**同时引用**：模型给 `citations` 和 `memories` 各若干条，界面分两节渲染。

---

## 2. 代码地图

```
src/memory/
  vault.ts     日记 markdown 解析（纯函数）：frontmatter / 模板 / Tracking / Diary 块
  schema.ts    mem_* 三张表的 DDL（v8 迁移引用）
  store.ts     增量同步、召回打分、按天读、统计与观测
  persona.ts   人设 + 红线（settings 表）+ 日记目录解析
src/db/migrations.ts   v8：建 mem_items / mem_sources / mem_observations
src/chain/agent/
  tools.ts     新增 recall_diary / read_diary / memory_profile（执行 + 参数钳制）
  parse.ts     memories[] 解析：itemId 必须落在本轮白名单里
  loop.ts      日记白名单、暂停恢复、把 memories 挂到最终结果
  payload.ts   三种新工具结果的出云组装（逐字段过脱敏策略）
src/understand/cloud/deepseek.ts  工具 schema + system 纪律 + 人设注入点
src/main/index.ts                 启动 / 提问前增量同步、工具依赖注入、persona
src/renderer/ask/                  「日记引用」卡片（日期 + 原文片段 + why）
scripts/memory-cli.mts + memory.mjs  CLI（ingest / recall / day / profile / persona）
```

---

## 3. 解析：为什么这么细

日记文件是 Obsidian 模板产出的，噪音比正文多：

- frontmatter（🌻日期🌻 / 天气 / 温度）→ 只用来兜底日期，**不进正文**；
- 开头「一言 / 提醒」引用块 → 整段丢（一条「获取失败，请检查网络连接」进记忆，之后每次问
  「我最近在想什么」都会带上它）；
- `<< [[昨天]] | [[明天]] >>` 导航行 → 丢；
- Templater 模板文件（`<%* … %>`）→ 整份跳过；
- `# Tracking` 的勾选框 → 每条待办一条（缩进子项也是独立待办），完成态进 `tags`（`open`/`done`）；
- `# Diary` 的 `- HH:mm` 块 → 一块一条，块内子项 / 引用行合并，`HH:mm` 解成当天的时间戳；
- `#tag` 进标签（过滤 `#FF5582A6` 这类高亮颜色值）；`[[双链]]` 进 refs（人 / 项目 / 书）。

条目稳定键 = `sha1(日期 + 段落 + 起始行 + 正文)`：正文改了就是新条目，旧条目在同一次事务里删掉。
同步幂等：同一批内容跑两次，第二次 `unchanged` 全中、库内容一字不变。

---

## 4. 召回：可解释、可复现

`recallMemory()` 打分 = 词命中（次数 + 词长）+ 标签/双链加权 + 类别权重 + 时间衰减（半衰期 45 天）。

每条结果都带 `reasons`（人话）：
`提到「周深」；标签「thinking」；距今天 27 天`

- **可复现**：打分不依赖会话 / 模型 / 随机数；同一问题问两次，顺序与内容完全一致。
- **不装懂**：纯过滤（没给关键词）只按时间列，并在 `mode` 里标 `filter`，模型不能把它当「相关」。
- 不用 FTS5：日记是每人几千条 × 一两百字的量级，LIKE 全表扫是毫秒级；trigram FTS 对 1–2 个汉字
  反而搜不到（和 `events_fts` 同一个坑）。上万条 / 接向量检索时再换。

---

## 5. 工具与引用（工具使用架构）

模型拿到三个新工具（都是**窄口**的，参数在 `tools.ts` 里钳死）：

| 工具 | 参数 | 返回 |
|---|---|---|
| `recall_diary` | keywords / day / from-to / tag / limit(1–20) | 条目 id、日期、120 字摘要、标签、双链、理由 |
| `read_diary` | day（必填）/ offset / limit(≤6000) | 当天全文 + 每条 itemId |
| `memory_profile` | 无 | 条目 / 天数 / 连续记录 / 待办完成率 / 高频标签与双链 |

引用纪律（和屏幕段同一套）：

1. `memories[].itemId` 只能取**本轮工具给过**的条目（白名单在 `loop.ts`）；
2. 编造 / 重复 / 没接日记库 → 整条剥掉；剥完一条不剩就按「没找到」收口，不放出无依据的正文；
3. 工具结果在出云前逐字段过脱敏策略（`payload.ts`），记事里的敏感串同样被墙挡；
4. 人设**不进 branded 载荷**：它是本地配置，经 `LlmCompleteOptions.personaPrompt` 拼在 system 最前面，
   出云确认门仍按整次请求在 `askChain` 门口判定。

---

## 6. 性格架构

`memory/persona.ts`：

- 可改：`memory.persona_name` / `memory.persona_tone`（一句话口吻）；
- 写死（任何配置都删不掉）：
  1. 只依据检索到的记录说话，没查到就说没查到；
  2. 不主动抖隐私（日记原文 / 路径 / 账号 / 密钥）；
  3. 不替用户做决定、不评价对错。
- 用户追加红线：`memory.persona_redlines`（`|` 分隔，最多 8 条）。

---

## 7. 怎么用

```powershell
npm run memory -- ingest "D:\Github\charlie_vault\daily"
npm run memory -- profile
npm run memory -- sources                 # 看索引里有哪些来源、各多少条
npm run memory -- recall 周深 --limit 5
npm run memory -- day 2026-09-29
npm run memory -- forget "C:\Users\HP\charlie_vault\daily"   # 只删这个目录的记忆
npm run memory -- persona set tone "说话短一点，别煽情"
npm run memory -- persona set redlines "别提比赛成绩|别用感叹号"
```

应用内：
- 启动后 2s、以及每次提问前（节流 60s）自动增量同步；目录不存在就什么都不做（不为没开的功能够建库）；
- 日记目录查找顺序：`GOTCHA_MEMORY_VAULT` → settings `memory.vault_dir`（`ingest` 会写）→
  `%USERPROFILE%\charlie_vault\daily` 与 `D:\Github\charlie_vault\daily` 里**日记最多的那个**；
- 问「我最近在想什么 / 我为什么放弃 X / 我以前怎么看周深」→ 模型应该走 `recall_diary` / `read_diary`，
  回答卡下面出现「日记引用（N 条）」。

> ⚠️ 换目录不会误删另一个目录的记忆：同步只清理**本次目录下**消失的文件（`isUnderRoot`），
> `forget` 同理。这条是踩出来的：本机同时有 `D:\Github\charlie_vault`（171 篇）和
> `%USERPROFILE%\charlie_vault`（6 篇旧副本），旧实现按目录顺序挑到了旧副本、把 D 盘的
> 2382 条当「源文件已删除」全清了。

---

## 8. 已实测（2026-10-29，本机真库）

```
scanned 171 · skipped 51（模板 / 空日记）· added 2382 · items 2382
覆盖 120 天：2025-12-10 → 2026-10-19
```

抽查「周深」：25 条候选，前 5 条都是真实日记（2026-10-02 的 thinking、2026-09-29 的评选、
2026-01-01 的新年目标…），理由行都能对上原文。

---

## 9. 明确没做（下一阶段）

1. **LLM 归纳（Hindsight 的 reflect）**：现在 `mem_observations` 只有统计型观测，不编心理分析。
   接模型需要新增 branded payload + 客户端方法（`completeMemoryReflect`），属于第二期。
2. **向量召回**：日记还没进 bge 会话；关键词召回在 2 千条量级够用，上万条再说。
3. **冲突消解**：`mem_observations.status` 已留 `superseded`，但「去年讨厌数学 / 今年想学好」这类
   互相打架的记忆还没有自动取代规则。
4. **UI 管理页**：现在只有 CLI + 问记忆里的引用卡片；编辑人设要走 `npm run memory -- persona`。
5. **多来源**：只接了日记目录，B站 / 邮件 / 文件还没进来（参考 bili-scroll 的定时轮 + 只读工具面）。
