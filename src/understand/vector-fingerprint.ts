/**
 * 派生向量的输入指纹（P2 · S3，docs/m2-graph-redesign.md §5.1 / §5.2）
 *
 * 为什么要有指纹：向量是**派生数据**，输入变了才该重算，没变就该复用。
 * 只看「有没有向量」会漏掉**原地更新**——归纳批量路径会把「同本地日 + 同 type + 同标题」的主题
 * 摘要改长（`src/understand/induction.ts` 的 `UPDATE nodes SET summary = ?`），旧实现
 * `onlyMissing` 因此永远留着过期向量；成员归属同样是追加写的，光看行数判断不出「谁变了」。
 *
 * 口径：
 * - 64 位 FNV-1a（两个不同种子的 32 位结果拼接成 16 位十六进制），确定性、不依赖随机盐；
 *   只用来回答「输入变了没有」，**不是**安全哈希，不进日志、不出网；
 * - 事件 id 集合先排序去重再算：同一组 id 的追加顺序不同不该触发重算；
 * - 坏值（非正整数 id）直接忽略，与 `parseSourceEventIds` 的口径一致。
 */

/** 32 位 FNV-1a；`seed` 不同 → 结果不同，用来拼出更宽的指纹 */
function fnv1a32(text: string, seed: number): number {
  let hash = seed >>> 0
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function toHex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0')
}

/** 任意文本的稳定指纹（16 位十六进制） */
export function stableFingerprint(text: string): string {
  const first = fnv1a32(text, 0x811c9dc5)
  // 第二个种子混入长度：单纯换种子仍可能对「同前缀不同长度」的文本撞车
  const second = fnv1a32(text, (0x9e3779b9 ^ text.length) >>> 0)
  return `${toHex(first)}${toHex(second)}`
}

/** 事件 id 集合的稳定指纹（排序去重后计算；顺序无关） */
export function eventIdsFingerprint(ids: Iterable<number>): string {
  const unique = new Set<number>()
  for (const id of ids) {
    if (Number.isInteger(id) && id > 0) unique.add(id)
  }
  const sorted = [...unique].sort((a, b) => a - b)
  return stableFingerprint(sorted.join(','))
}
