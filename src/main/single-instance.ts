/**
 * 单实例锁（m1b-plan §3 Phase 1 / §4.8）
 *
 * 采集与球都是进程级资源：双开会起两个 scheduler、两个写连接（SQLite 争锁）
 * 与重复 events，所以在创建任何窗口前先抢锁；没抢到直接退出，让已有实例
 * 把时间线窗口打开并聚焦（second-instance）。
 *
 * 宿主抽象成接口，单测用假锁直接跑（tests/unit/single-instance.test.ts）。
 */

export interface SingleInstanceHost {
  requestSingleInstanceLock(): boolean
  quit(): void
  on(event: 'second-instance', listener: (event: unknown, argv: string[]) => void): unknown
}

/**
 * 抢单实例锁。
 *
 * - 抢到：注册 `second-instance` 回调，返回 true，继续启动。
 * - 没抢到：立即 `quit()`，返回 false，调用方不得再创建窗口。
 */
export function claimSingleInstance(
  host: SingleInstanceHost,
  onSecondInstance: (argv: readonly string[]) => void
): boolean {
  if (!host.requestSingleInstanceLock()) {
    host.quit()
    return false
  }
  host.on('second-instance', (_event, argv) => onSecondInstance(argv))
  return true
}
