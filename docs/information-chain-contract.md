# 信息链契约 v0.2（提案，待拍板）

> 状态：**提案**。拍板后本文件成为 `src/chain/` 的实现依据；未拍板前不建表、不写代码。
> v0.2（2026-10-26）：§5 六项已由拍板人给出结论（其中保留策略的合并语义、空闲判定的补充条件仍待确认）。
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

## 5. 拍板登记（2026-10-26，v0.2）

| # | 事项 | 结论 | 状态 |
| - | - | - | - |
| 1 | 标题是否参与段身份 | **参与**（同进程不同标题 = 换了一件事）；但加**抖动抑制**：标题在 T 秒内变回原值就不切段（`T` 默认 3s，实测中见过 1 秒内的 A→B→A） | ✅ 已定（抑制窗口大小可调） |
| 2 | 入场帧 | 段开始时默认截一张，`source='enter'` | ✅ 已定 |
| 3 | 空闲阈值 | 空闲 **60s**；回来后由**事件**触发恢复采集 | ✅ 已定 |
| 4 | 双链 / 标签合并 | AI 抽取时**机械检索语义相近的已有双链单元**，再让 LLM 判断「复用已有的 / 保留新的」；标签同思路。明显高相似（≥0.95）直接复用、不问模型；模糊带才问（省调用，与 D29 主题合并口径一致） | ✅ 已定 |
| 5 | 内容变化率 | **不新增独立指标**：内容变化由操作驱动（滚轮、点击），因此以「操作触发的快照」为准；帧差只用于两处——判定真空闲、视频/动画场景的低频补采 | ✅ 已定（砍掉独立指标） |
| 6 | 保留期 | 分级：1 周 → 两两合一；1 个月 → 再合一次；半年 → 归档压缩，需要时可解出原图。**必须始终可查、可回溯**，用调用时间换存储 | 🟡 方向已定，合并语义待确认（见下） |

### 5.1 保留策略的两种读法（需确认）

「两两合一」有两种可能，代价完全不同：

- **拼图**（两张截屏拼成一张画布）：省的是文件数与 DB 行数，**不省字节**（像素还在）。
- **重编码**（降分辨率 / 降质量 / 两帧取差异）：**省字节**，但会损失可读性。

如果目标是省磁盘，只有第二种有效；如果目标是省元数据开销，第一种有用。建议组合成三级：

| 层级 | 时间 | 动作 | 省什么 |
| - | - | - | - |
| hot | 0–7 天 | 原图（WebP） | — |
| warm | 7–30 天 | 重编码到较小尺寸（仍可读） | 字节（约一半以上，需实测） |
| cold | 1–6 月 | 再压一档 + 打包成归档容器 | 字节与文件数 |
| archive | >6 月 | 高压缩归档，按需解出 | 字节 |

三级都必须保留 **`shot.id → 事件 / 段` 的映射**，解出后能回到原来那一刻。

## 5.2 仍然空白的一处：空闲判定会漏掉「没操作但有内容」

按「60s 无任何输入 = 空闲 → 停采」，会漏掉两类场景：**看视频**、**读长文**（只滚动不点击之前）。它们没有输入，但画面在变或内容有价值。

建议补一个条件：**空闲 = 60s 无输入 且 画面无变化**（帧差已有），画面在变就继续采（降频）。这样视频不会丢，真正离开才停。**待确认。**

## 6. 最小闭环（第一版只做这条）

> 窗口段 → 事件 → 截图 → 内容 → 能按时间与应用查出段，并从段反查到截图与内容原文。

做到这条就算第一版成立；双链、标签、向量、个人记忆都排它后面。
