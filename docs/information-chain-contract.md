# 信息链契约 v0.3（提案，待拍板）

> 状态：**提案**。拍板后本文件成为 `src/chain/` 的实现依据；未拍板前不建表、不写代码。
> v0.3（2026-10-26）：§5 六项全部落定（空闲即停采、视频不采、内容变化率整项砍掉、保留策略按重编码三级）。**唯一待确认**：§5.2 的纯键盘输入补采规则。
> 依据：D38（方向：冻结旧时刻—主题管线）、D39（段与空闲语义）、探针实测（`docs/chain-probe.md`）。
> 概念出处：`docs/information-chain-direction.md`（窗口球 / 双链球 / 事件点 / 证据截图）。
> 这份契约只回答「数据长什么样、什么不许变」，不回答「怎么采集」（钩子方案另议）。

## 0. 一句话

**一段记忆 = 一个窗口的一段焦点占用；段内的事件点触发截图作为证据；内容是 UIA 优先、OCR 兜底的文本流；标签与双链是可重建的派生，随时可以推翻重算。**

## 1. 三个契约（立不住，后面全部返工）

1. **一段到底包含什么**：段的边界、身份、有效时长怎么算。
2. **事件 / 内容 / 截图怎么互指**：用稳定 id，不靠时间戳猜。
3. **哪些不可变、哪些可重建**：证据只写一次，理解随便改。

## 2. 实体与字段

命名统一 `chain_` 前缀，与旧表并存，不迁移旧数据（D38）。

### 2.1 段 `chain_segment`

```sql
CREATE TABLE chain_segment (
  id          INTEGER PRIMARY KEY,
  start_ts    INTEGER NOT NULL,   -- 首次成为焦点
  end_ts      INTEGER NOT NULL,   -- 最后一次焦点结束（含接续后的跨度）
  active_ms   INTEGER NOT NULL,   -- 有效占用：排除空闲
  idle_ms     INTEGER NOT NULL,   -- 段内被排除的空闲（接续造成）
  day_key     TEXT    NOT NULL,   -- 本地日期 yyyy-mm-dd，按 start_ts 归日
  app         TEXT,               -- active-win 的 owner.name
  exe         TEXT,               -- 进程名，小写
  pid         INTEGER,
  hwnd        INTEGER,
  title_first TEXT,               -- 段开始时的标题
  title_last  TEXT,               -- 段结束时的标题
  created_at  INTEGER NOT NULL
);
```

- **身份**：`pid + title`。同进程但标题不同 = 换了一件事（不同网页 / 不同文档）。
- **标题抖动抑制**：标题在 3 秒内变回原值则不切段（实测见过 1 秒内的 A→B→A，见 `docs/chain-probe.md`）。未读计数、播放进度这类会持续变的标题，抑制窗口内不产生新段。
- **边界**：焦点切走即切段；空闲 >60s 断开；**走开又回到同一窗口就接续**（D39），接续上限 30 分钟。
- **时长**：`active_ms` 是有效占用，`end_ts - start_ts` 是跨度；两者不等时差额就是 `idle_ms`。
- **不变量**：任意时刻最多一个段在占用；段与段不重叠。

### 2.2 事件 `chain_event`

```sql
CREATE TABLE chain_event (
  id         INTEGER PRIMARY KEY,
  segment_id INTEGER NOT NULL,    -- 属于且仅属于一个段
  ts         INTEGER NOT NULL,
  kind       TEXT    NOT NULL,    -- click_left / click_right / click_middle / wheel / move_pause / enter
  x          INTEGER,             -- 屏幕物理像素（wheel / click 有效）
  y          INTEGER,
  delta      INTEGER              -- wheel 的方向与格数
);
```

- **事件不是图谱节点**，不上画布，只作段内时间锚点与截图触发器（D39 / 方向文档）。
- `enter` = 段开始时的入场事件（保证每段至少有一个锚点）。
- `move_pause` = 移动 ≥40px 后静止 ≥400ms（探针口径，可调）。

### 2.3 截图 `chain_shot`

```sql
CREATE TABLE chain_shot (
  id         INTEGER PRIMARY KEY,
  segment_id INTEGER NOT NULL,
  event_id   INTEGER,             -- 入场帧为空
  ts         INTEGER NOT NULL,
  path       TEXT,                -- 文件路径；剪载荷时置空，行不删
  width      INTEGER,
  height     INTEGER,
  bytes      INTEGER,
  source     TEXT NOT NULL,       -- event / enter
  tier       TEXT NOT NULL,       -- hot / warm / cold（归档层，见 §5）
  container  TEXT                 -- 归档容器路径；hot 为空
);
```

- **只写一次，不覆盖**；截图是「AI 命中后回来核验」的最终证据。
- 入场帧：段开始时默认截一张，`source='enter'`。
- `sensitive=1` 的段不存图（对齐 D10 / D19）。
- 分级保留见 §5：任何归档都必须保留 `shot.id → 事件 / 段` 的映射，解出后能回到原来那一刻。
- 过期只删文件、置空 `path`，**行与 id 永不删**（对齐 D32 的「剪载荷不剪 id」）。

### 2.4 内容 `chain_content`

```sql
CREATE TABLE chain_content (
  id          INTEGER PRIMARY KEY,
  segment_id  INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  source      TEXT NOT NULL,      -- uia / ocr / manual
  text        TEXT NOT NULL,
  chars       INTEGER NOT NULL,
  hash        TEXT NOT NULL       -- 去空白后的指纹，用于判重与变化率
);
```

- 一段可以有多条（随时间增长），**每条都带来源**，不许把 UIA 与 OCR 混成无来源的一坨。
- UIA 拿不到（实测微信 6 字符、终端 90 字符）才走 OCR；两者都失败就留空并标记，不编造。

### 2.5 派生层（可重建）

```sql
CREATE TABLE chain_tag        (id INTEGER PRIMARY KEY, segment_id INTEGER, name TEXT, source TEXT);
CREATE TABLE chain_link       (id INTEGER PRIMARY KEY, name TEXT UNIQUE, aliases TEXT);
CREATE TABLE chain_link_seg   (link_id INTEGER, segment_id INTEGER, weight REAL, PRIMARY KEY (link_id, segment_id));
CREATE TABLE chain_vector     (segment_id INTEGER PRIMARY KEY, model TEXT, dim INTEGER, vec BLOB, text_hash TEXT);
```

- 标签、双链、向量、摘要、命名**全部可重建**：删掉能从 `chain_content` 重算。
- 双链是**多对多**（方向文档的「双链球可以指向多个窗口」），生成规则待定（§5）。

## 3. 不变量（写测试时逐条对应）

| # | 不变量 |
| - | - |
| 1 | 同一时刻最多一个段在占用，段区间不重叠 |
| 2 | `active_ms + idle_ms = end_ts - start_ts`（接续段必成立） |
| 3 | 每个事件的 `segment_id` 存在，且 `ts` 落在该段的 `[start_ts, end_ts]` 内 |
| 4 | 每张截图必然挂在一个存在的段上；`event_id` 非空时必须属于同一个段 |
| 5 | 每条内容必须有 `source`，且 `chars = text.length` |
| 6 | 证据层（段 / 事件 / 截图）只有 INSERT；更新仅限「置空载荷字段」 |
| 7 | 派生层可以随时全删重建，重建后检索结果不劣化 |
| 8 | 旧 `events` / `moments` / `themes` 不被新代码写入 |
| 9 | 截图进入任何归档层后，`shot.id` 与其事件 / 段的映射仍可解出，解压后能回到原来那一刻 |

## 4. 与旧数据的关系

- 旧 `events` 是「2 秒采样的 OCR 观察」，**不是**事件点，**不能**改名叫事件。
- 旧 `moments` 是「同 app + 同标题 + 相邻 ≤90s 的分组」，**不是**焦点占用段（没有真实焦点边界、没有输入事件）。
- 新表与旧表并行；旧数据只做「历史观察」检索，不进新段的证据链。

## 5. 拍板登记（2026-10-26，v0.3）

| # | 事项 | 结论 | 状态 |
| - | - | - | - |
| 1 | 标题是否参与段身份 | **参与**（同进程不同标题 = 换了一件事）；但加**抖动抑制**：标题在 T 秒内变回原值就不切段（`T` 默认 3s，实测中见过 1 秒内的 A→B→A） | ✅ 已定 |
| 2 | 入场帧 | 段开始时默认截一张，`source='enter'` | ✅ 已定 |
| 3 | 空闲与采集 | **空闲 = 60 秒无任何输入 → 直接停采**，回来由事件触发恢复。**不加「画面无变化」条件**：读长文必然要滚动（无输入就是没在读）；**视频不采**——AI 也看不了视频，逐帧截它既浪费存储又没有用 | ✅ 已定 |
| 4 | 双链 / 标签合并 | AI 抽取时**机械检索语义相近的已有双链单元**，再让 LLM 判断「复用已有的 / 保留新的」；标签同思路。明显高相似（≥0.95）直接复用、不问模型；模糊带才问（与 D29 口径一致） | ✅ 已定 |
| 5 | 内容变化率 | **不做**。内容变化由操作驱动；视频既已被排除，帧差也就不再承担「要不要采」的判据 | ✅ 已定（整项砍掉） |
| 6 | 保留期 | 三级分层 + **重编码**（目标是省字节，不是省文件数）：hot 原图 → warm 重编码小尺寸 → cold 再压一档并打包 → archive 高压缩归档、按需解出；`shot.id → 事件 / 段` 的映射任何层级都不许丢 | ✅ 已定 |

### 5.1 保留策略落地参数

| 层级 | 时间 | 动作 | 验收 |
| - | - | - | - |
| hot | 0–7 天 | 原图（WebP） | 原分辨率可读 |
| warm | 7–30 天 | 重编码到较小尺寸（宽度上限 ~1280） | 仍可辨认文字区域，体积显著下降（首轮实测后回填比例） |
| cold | 1–6 月 | 再压一档 + 打包成归档容器 | 解出后可达 warm 质量 |
| archive | >6 月 | 高压缩归档，按需解出 | 解出后仍能定位到那一刻 |

初次实测前不写死压缩参数；实现时用真实库样本量一次体积与可读性，再回填本表。

## 5.2 一处需要补的漏洞：纯键盘输入不会被采到

按「只有鼠标事件才触发采集」，会漏掉**只打字不用鼠标**的场景：

- 写文档、写代码、在聊天框里连续输入；
- 用 `Alt+Tab` 切窗口（无鼠标事件，但前台窗口变化钩子能抓到，没问题）。

漏掉的是**输入本身**：`GetLastInputInfo` 能告诉我们「刚才有输入」，但拿不到输入内容（也不该拿）。

建议补一条**不加键盘钩子**的规则：**有输入、但连续 N 秒没有鼠标事件 → 每 N 秒补采一张**（`N` 默认 5–10s，用 `GetLastInputInfo` 的更新时刻判断）。这样打字场景每几秒有一帧证据，视频场景仍不采（因为视频期间没有键鼠输入）。

**待确认。**

## 6. 最小闭环（第一版只做这条）

> 窗口段 → 事件 → 截图 → 内容 → 能按时间与应用查出段，并从段反查到截图与内容原文。

做到这条就算第一版成立；双链、标签、向量、个人记忆都排它后面。
