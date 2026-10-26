/**
 * 信息链 · 保留期分层（契约 §5.1，D44）
 *
 * 纯逻辑：只算「这张证据该在哪个层、该做什么」，不读文件、不碰数据库。
 * 真正的重编码 / 打包在 `main/chain-retention.ts`（需要 Electron 的 nativeImage）。
 *
 * ## 参数怎么来的（2026-10-26 实测，不是拍脑袋）
 *
 * 用 9 张真机证据图（`npm run dev:capture` 在 DSH / Obsidian / RustDesk 上跑出来，
 * 3206–3840 宽、486 KB–6.4 MB），拿生产同款编码器（Electron `nativeImage`）重编码，
 * 再用 WinRT OCR 比「重编码后还能读出原图多少字」：
 *
 * | 档位 | 均值字节 | 相对原图 | OCR 字符保留 | 文本相似度 |
 * | - | - | - | - | - |
 * | 原图 PNG（采集管线 2× 上采样） | ~1.48 MB | 1× | 100% | 1.0 |
 * | 原分辨率 JPEG q85 | 232 KB | 6.4× | 99.6% | 0.959 |
 * | 宽 1920 JPEG q85 | 107 KB | 13.8× | 95.2% | 0.840 |
 * | 宽 1440 JPEG q80 | 63 KB | 23.5× | 88.5% | 0.717 |
 * | 宽 1280 JPEG q75 | 47 KB | 31.5× | 77.0% | 0.600 |
 *
 * 两个结论直接定了这里的参数：
 * 1. **降低 JPEG 质量几乎不掉字**（原分辨率 q85 → q60 相似度只掉 0.03），**缩小宽度掉得多**
 *    （1920 → 1280 相似度从 0.84 掉到 0.60）。所以分层主要靠「宽度」，质量只微调。
 * 2. 本机屏幕是 1920×1080 @125%，采集管线为了 OCR 把窗口裁剪**放大 2×** 再存——证据图
 *    的 3840 宽里有一半是插值。宽 1920 恰好是**屏幕原生分辨率**（人真正看到的像素）。
 *
 * 时间窗沿用契约 §5.1（7 天 / 1 月 / 半年）；**参数改动要重跑这套标定**，别凭直觉压 1280。
 */
import type { ChainShotRow, ChainShotTier } from './schema'

export const RETENTION_DAY_MS = 86_400_000

/** 一档的编码参数：宽度上限（`null` = 不缩放）+ JPEG 质量 */
export interface RetentionEncoding {
  maxWidth: number | null
  quality: number
}

export interface RetentionParams {
  /** < 这个天数 = hot */
  hotDays: number
  /** < 这个天数 = warm */
  warmDays: number
  /** < 这个天数 = cold；再老 = archive */
  coldDays: number
  hot: RetentionEncoding
  warm: RetentionEncoding
  cold: RetentionEncoding
  archive: RetentionEncoding
}

export const DEFAULT_RETENTION: RetentionParams = {
  hotDays: 7,
  warmDays: 30,
  coldDays: 183,
  // hot：采集时就按这个编码落盘（见 `main/chain-shot.ts` 的 `encode` 注入）
  hot: { maxWidth: null, quality: 85 },
  warm: { maxWidth: 1920, quality: 85 },
  cold: { maxWidth: 1440, quality: 80 },
  archive: { maxWidth: 1280, quality: 75 }
}

const TIER_ORDER: Record<ChainShotTier, number> = { hot: 0, warm: 1, cold: 2, archive: 3 }

/** 按年龄算这一张「现在属于哪一层」 */
export function tierForAge(shotTs: number, now: number, params: RetentionParams = DEFAULT_RETENTION): ChainShotTier {
  const age = Math.max(0, now - shotTs)
  if (age < params.hotDays * RETENTION_DAY_MS) return 'hot'
  if (age < params.warmDays * RETENTION_DAY_MS) return 'warm'
  if (age < params.coldDays * RETENTION_DAY_MS) return 'cold'
  return 'archive'
}

/** 采集管线改用 JPEG 之前的行（hot 层还是 PNG） */
export function isPngPath(path: string): boolean {
  return /\.png$/i.test(path)
}

/** `.png` → `.jpg`；已经是 `.jpg` 就原样返回 */
export function jpegPathOf(path: string): string {
  return isPngPath(path) ? path.replace(/\.png$/i, '.jpg') : path
}

export type RetentionPlan =
  | { kind: 'keep' }
  /** 就地重编码：写新文件、更新行，旧文件删掉 */
  | { kind: 'encode'; tier: ChainShotTier; encoding: RetentionEncoding }
  /** 重编码并打进当天的归档容器：行里 `path` 置空、`container` 指向容器 */
  | { kind: 'pack'; tier: 'cold' | 'archive'; encoding: RetentionEncoding }

/**
 * 一张证据的保留期动作。
 *
 * - `hot`：已经是 JPEG 就什么都不做；还是 PNG（老数据）就重编码成 hot 层 JPEG。
 * - `warm`：hot 的行重编码；已经 warm 就跳过。
 * - `cold` / `archive`：不是这一层的行重编码 + 打包；已经是就跳过。
 * - **不降级**：时钟回拨等原因算出更年轻的层时保持原样（证据已经在更省字节的层里，
 *   拿不回来；再重编码只会二次损失）。
 */
export function planShotRetention(
  shot: Pick<ChainShotRow, 'ts' | 'tier' | 'path'>,
  now: number,
  params: RetentionParams = DEFAULT_RETENTION
): RetentionPlan {
  const tier = tierForAge(shot.ts, now, params)

  if (tier === 'hot') {
    if (shot.path !== null && isPngPath(shot.path)) {
      return { kind: 'encode', tier: 'hot', encoding: params.hot }
    }
    return { kind: 'keep' }
  }

  if (shot.tier === tier) return { kind: 'keep' }
  if (TIER_ORDER[shot.tier] > TIER_ORDER[tier]) return { kind: 'keep' }

  if (tier === 'warm') return { kind: 'encode', tier: 'warm', encoding: params.warm }
  return { kind: 'pack', tier, encoding: params[tier] }
}

/** 需要扫描的截图时间上限：比 hot 窗口更老的都可能有活干（更年轻的只可能是历史 PNG） */
export function retentionScanBefore(now: number, params: RetentionParams = DEFAULT_RETENTION): number {
  return now - params.hotDays * RETENTION_DAY_MS
}

/** 当天某一层的归档容器文件名（一天一层一个文件） */
export function containerName(dayKey: string, tier: 'cold' | 'archive'): string {
  return `${dayKey}-${tier}.cgar`
}
