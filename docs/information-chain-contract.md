# 信息链契约 v0.1（提案，待拍板）

> 状态：**提案**。拍板后本文件成为 `src/chain/` 的实现依据；未拍板前不建表、不写代码。
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
  event_id   INTEGER,             -- 入场帧可为空
  ts         INTEGER NOT NULL,
  path       TEXT,                -- 文件路径；剪载荷时置空，行不删
  width      INTEGER,
  height     INTEGER,
  bytes      INTEGER,
  source     TEXT NOT NULL        -- event / enter
);
```

- **只写一次，不覆盖**；截图是「AI 命中后回来核验」的最终证据。
- `sensitive=1` 的段不存图（对齐 D10 / D19）。
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

## 4. 与旧数据的关系

- 旧 `events` 是「2 秒采样的 OCR 观察」，**不是**事件点，**不能**改名叫事件。
- 旧 `moments` 是「同 app + 同标题 + 相邻 ≤90s 的分组」，**不是**焦点占用段（没有真实焦点边界、没有输入事件）。
- 新表与旧表并行；旧数据只做「历史观察」检索，不进新段的证据链。

## 5. 待拍板（不定就不动代码）

1. **标题是否参与段身份**：提案默认「参与」，但标题抖动（如「(3) 微信」「未读 1」）会导致碎段 —— 建议加「标题变化 <3s 内又变回来不切段」的抑制，具体值待定。
2. **入场帧**：段开始时是否默认截一张（提案：是，作为该段的封面证据）。
3. **空闲停采**：空闲超阈值后停采、恢复时机；漏采风险如何兜（拍板人已表态「空闲当然停采」，需定触发与恢复细节）。
4. **双链生成规则**：LLM 抽、用户手标、还是关键词共现；别名怎么合并。
5. **内容变化率**：判断「这段有没有新内容」的指标（UIA/OCR 文本 hash 变化次数），与密度解耦。
6. **保留期**：截图与内容的默认保存时长、总容量上限。

## 6. 最小闭环（第一版只做这条）

> 窗口段 → 事件 → 截图 → 内容 → 能按时间与应用查出段，并从段反查到截图与内容原文。

做到这条就算第一版成立；双链、标签、向量、个人记忆都排它后面。
