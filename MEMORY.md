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
  schema.ts    mem_* 四张表的 DDL（v8 三张 + v9 回收站 mem_deleted）
  store.ts     增量同步、召回打分、按天读、浏览 / 删除 / 撤销、统计与观测
  persona.ts   人设 + 红线（settings 表）+ 日记目录解析
src/db/migrations.ts   v8：建 mem_items / mem_sources / mem_observations；v9：mem_deleted
src/chain/agent/
  tools.ts     新增 recall_diary / read_diary / memory_profile（执行 + 参数钳制）
  parse.ts     memories[] 解析：itemId 必须落在本轮白名单里
  loop.ts      日记白名单、暂停恢复、把 memories 挂到最终结果
  payload.ts   三种新工具结果的出云组装（逐字段过脱敏策略）
src/understand/cloud/deepseek.ts  工具 schema + system 纪律 + 人设注入点
src/main/index.ts                 启动 / 提问前增量同步、工具依赖注入、persona
src/main/memory-settings.ts       设置抽屉（日记目录 + 人设）的校验与视图；保存后由 index.ts 立即同步
src/main/memory-admin.ts          设置抽屉「记忆条目」的校验与视图（浏览 / 删除 / 撤销）
src/renderer/ask/                  「日记引用」卡片 + 设置抽屉「个人记忆」（目录 / 人设 / 条目列表）
scripts/memory-cli.mts + memory.mjs  CLI（ingest / recall / day / items / delete / restore / profile / persona）
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
npm run memory -- items 周深              # 浏览（按天倒序，20 条一页；也认 2026-09 / 2026-09-29）
npm run memory -- delete 4475             # 删一条（进回收站，同步不会再带回来）
npm run memory -- restore <uid>           # 撤销删除
npm run memory -- forget "C:\Users\HP\charlie_vault\daily"   # 只删这个目录的记忆
npm run memory -- persona set tone "说话短一点，别煽情"
npm run memory -- persona set redlines "别提比赛成绩|别用感叹号"
```

应用内：
- **设置抽屉 → 个人记忆**（2026-10-29 新增，替代 CLI 改配置）：日记目录（手填，留空 = 自动找；
  环境变量优先时状态行会注明）＋ 名字 / 口吻 ＋ 追加红线（**每行一条**，最多 8 条）。
  **保存即同步**：按钮旁直接回「N 篇 / 新增 / 删除 / 共几条」，不用再记 CLI；
- **设置抽屉 → 个人记忆 → 记忆条目**（2026-10-29）：关键词 / 日期前缀搜索、类别下拉、
  一页 20 条「加载更多」；长条目折 8 行，点一下展开。每条右上角「删除」——只从记忆里拿掉，
  **不改日记原文**；删完给「（可撤销）」，点「撤销删除」原样放回（详见第 8 节）；
- 启动后 2s、以及每次提问前（节流 60s）自动增量同步；目录不存在就什么都不做（不为没开的功能够建库）；
- 日记目录查找顺序：`GOTCHA_MEMORY_VAULT` → settings `memory.vault_dir`（`ingest` / 设置抽屉会写）→
  `%USERPROFILE%\charlie_vault\daily` 与 `D:\Github\charlie_vault\daily` 里**日记最多的那个**；
- 人设保存后从**下一次提问**开始生效（每次提问现读 settings，不用重启）；
- 问「我最近在想什么 / 我为什么放弃 X / 我以前怎么看周深」→ 模型应该走 `recall_diary` / `read_diary`，
  回答卡下面出现「日记引用（N 条）」。

> ⚠️ 换目录不会误删另一个目录的记忆：同步只清理**本次目录下**消失的文件（`isUnderRoot`），
> `forget` 同理。这条是踩出来的：本机同时有 `D:\Github\charlie_vault`（171 篇）和
> `%USERPROFILE%\charlie_vault`（6 篇旧副本），旧实现按目录顺序挑到了旧副本、把 D 盘的
> 2382 条当「源文件已删除」全清了。

---

## 8. 记忆条目：浏览与删除（2026-10-29）

设置抽屉「个人记忆」下面就是条目列表：关键词搜索（也认 `2026-09` / `2026-09-29` 这种日期前缀）、
类别下拉（日记 / 待办 / 笔记 / 摘录）、一页 20 条「加载更多」；长条目默认折 8 行，点一下展开。
每条右上角「删除」：**只从记忆里拿掉，不改用户写的 md**，删完消息行给「（可撤销）」，
点「撤销删除」原样放回。

删除的去向是 `mem_deleted`（v9，回收站）：

- 同步时按 uid **跳过**回收站里的条目 —— 日记原文还在，改别的段落会触发整份重解析，
  没有这张表，删掉的条目下一次同步就自己回来了；
- 存整行（不是只存 uid），撤销不用等下一次同步，uid 不变（再同步也不会重复插）；
- 上限 500 条，超出按删除时间丢最旧的；
- **改写被删那段 = 新的 uid = 用户新写的一条**，会重新进记忆（这是有意的：删的是「那条内容」）；
- 删除 / 撤销都要开写连接（会关掉只读连接）：**回答进行中一律拒绝**（主进程 `ask-ipc`
  按在途提问判定，渲染层也先拦一道）。

CLI 是同一套实现：`items [关键词]` / `delete <id>` / `restore <uid>`。

---

## 9. 已实测（2026-10-29，本机真库）

```
scanned 171 · skipped 51（模板 / 空日记）· added 2382 · items 2382
覆盖 120 天：2025-12-10 → 2026-10-19
```

抽查「周深」：25 条候选，前 5 条都是真实日记（2026-10-02 的 thinking、2026-09-29 的评选、
2026-01-01 的新年目标…），理由行都能对上原文。

**端到端（2026-10-29 09:47，dev 实例 + 真 key，`GOTCHA_ASK_ON_START=1`）**：
问「我最近在想什么」→ 7 轮 / 8 次工具调用（`memory_profile` → `recall_diary` 按标签/时间
→ `read_diary`×4）→ 回答 783 字，回答卡下出现「日记引用（4 条）」（10-02 ×2 / 09-23 / 10-03，
日期 + 原文片段 + why 全对得上）。

验收时修掉两个阻塞（细节见 gotchas）：
1. 某一轮模型给了 `tool_calls` 却没有 CoT → 下一轮 400；wire 层改成「DeepSeek 端点每个
   assistant(tool_calls) 都发 `reasoning_content`，缺失写空串」（真 key 探针：缺字段 400 / 空串 200）。
2. 只靠日记回答时模型偶尔漏 `citations` 键 → 误报「答得不成形」；解析层缺省当空数组。

**设置抽屉验收（2026-10-29 11:36–11:39，真机）**：
- 打开抽屉即显示「当前目录：D:\Github\charlie_vault\daily（设置里的目录）· 索引 2382 条 / 120 天」；
- 填一个不存在的目录 → 红色「没有保存：日记目录不存在：…」，设置与库都没变（校验在落库前）；
- 填临时目录（1 篇）→ 点「保存并同步」→ `memory sync {"scanned":1,"added":1,"items":2383}`，
  按钮旁回「已保存并同步：…（1 篇 / 新增 1 / 删除 0 / 共 2383 条）」，状态行同步更新；
- 切回原目录并同时改名「小记」、追加两条红线（多行）→ 同步 `171 unchanged`；
  `memory.persona_redlines` 落成 `别提成绩|别用感叹号`（多行 → `|` 存储）；
- 验收后已用 `forget` 清掉临时目录那 1 条、人设恢复默认（名字 记忆球 / 红线空）。
  注意：**换目录不会删除另一个目录的记忆**（只清本次目录下消失的文件），所以切目录后
  旧目录条目仍留在库里，要清就用 `npm run memory -- forget <旧目录>`。

**记忆条目验收（2026-10-29 12:2x，真机 dev 实例 + 真库）**：
- 抽屉里「共 2382 条」，按天倒序，每条带「删除」；搜「肖梦婷」→「共 1 条」（2026-09-29 01:19 的日记）；
- 删一条 → 消息「已删除 2026-09-29 01:19「…」（可撤销）」+「撤销删除」按钮出现，条目从列表消失；
- 点「撤销删除」→「已恢复 2026-09-29 的那一条」，条目回到列表；库里 `mem_deleted` 清空、
  条目数回到 2382（验完复原，没留垃圾）。

CLI 侧同一套（真库副本上跑，不碰真库）：
- `items 陪伴ai模型` → 1 条；`delete 4475` → 回收站 1 条、搜索变 0 条；
- **改同一份日记的另一个段落 → 整份重解析（added 1）→ 删掉的那条没有回来**（回收站仍 1 条）；
- `restore <uid>` → 回到 1 条，再 `ingest` 是 `unchanged 3 / added 0`（不重复插）。

---

## 10. 明确没做（下一阶段）

1. **LLM 归纳（Hindsight 的 reflect）**：现在 `mem_observations` 只有统计型观测，不编心理分析。
   接模型需要新增 branded payload + 客户端方法（`completeMemoryReflect`），属于第二期。
2. **向量召回**：日记还没进 bge 会话；关键词召回在 2 千条量级够用，上万条再说。
3. **冲突消解**：`mem_observations.status` 已留 `superseded`，但「去年讨厌数学 / 今年想学好」这类
   互相打架的记忆还没有自动取代规则。
4. **编辑（不只是删除）**：条目只能删 / 撤销，不能改正文——改正文应该改日记原文，下次同步自然更新。
5. **多来源**：只接了日记目录，B站 / 邮件 / 文件还没进来（参考 bili-scroll 的定时轮 + 只读工具面）。
