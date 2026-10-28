# 性能探针（只读为主）

配套文档：根目录 [`性能优化方案.md`](../../性能优化方案.md)。这些脚本不是产品代码的一部分，
用来把"感觉慢"变成可对比的数字；其中两个会**复制**真实库再改副本，其余全部只读。

| 脚本 | 用途 | 是否改数据 | npm 脚本 |
|---|---|---|---|
| `probe.mjs` | 库规模（dbstat / 空闲页 / WAL）+ 热点查询耗时 | 只读 | `npm run perf:probe` |
| `capture-log.mjs` | 从 `%APPDATA%\Gotcha\logs\main.log` 抽 OCR / 抓帧分布、每日产出 | 只读 | `npm run perf:capture` |
| `runtime-sample.mjs` | 对运行中的 electron 进程采样 10 s：CPU、磁盘写 | 只读 | `npm run perf:sample` |
| `write-bench.mjs` | 单条写入：带 FTS / 无 FTS / 批量事务 | 只改临时副本 | — |
| `scale-bench.mjs` | 关键词检索随正文增长的曲线（灌数据到副本） | 只改临时副本 | — |

另有 `tests/perf/` 下的真实模块基线（检索、载荷、图谱、d3-force、关键词合并）：

```powershell
npm run perf:suite
# 只跑关键词合并（P0-3）：逐词 vs 合并 vs 迁移 v3 后，外加工具调用端到端
npx vitest run --config tests/perf/vitest.perf.config.ts tests/perf/keyword-merge.perf.test.ts
```

## 判重前移（P0-1）怎么量

`runtime-sample.mjs` 会把**所有** electron 进程加在一起；要单量一个隔离实例，用临时 userData：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 本机 harness 会带这个变量
$env:GOTCHA_USER_DATA = "$env:TEMP\gotcha-perf-verify"
& .\node_modules\electron\dist\electron.exe . --capture
# 另开一个窗口：node scripts/perf/runtime-sample.mjs --seconds 60
```

跑完读该实例库里的当日统计（`settings` 的 `stats.day.<date>`）：
`frames_total / frames_same / encode_count / encode_ms / write_bytes` —— `encode_count`
应当只占 `frames_total - frames_same`，而不是每个 tick 都编码。

## 约定

- 默认库：`%APPDATA%\Gotcha\memory.db`；`probe.mjs` 支持 `--db <path>` 与 `--json`。
- 副本脚本把库复制到 `%TEMP%`，跑完删掉，**不碰真实库**。
- 应用正在运行也可以跑（SQLite 只读 + WAL 并发安全）；写基准用的是副本，不会与采集争锁。
- 判断"有没有退化"看脚本输出里的毫秒数和行数，而不是通过/失败。
