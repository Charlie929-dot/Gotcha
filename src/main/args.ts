/**
 * 启动参数解析（纯函数，argv / env 由调用方注入，供单测固定输入）
 *
 * M1a 开启采集的唯一途径（m1a-plan §4.6）：
 * - 启动参数 `--capture`
 * - 环境变量 `GOTCHA_CAPTURE=1`
 * 其余一律默认暂停（security.md「默认暂停，显式开启」硬前提，A3 验收红线）。
 */

export interface LaunchEnv {
  GOTCHA_CAPTURE?: string
}

/** 解析采集开关：显式开启才为 true，默认暂停 */
export function resolveCapture(argv: readonly string[], env: LaunchEnv): boolean {
  if (argv.includes('--capture')) return true
  return env.GOTCHA_CAPTURE === '1'
}
