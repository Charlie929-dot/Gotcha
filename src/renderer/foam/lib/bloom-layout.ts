/**
 * 大图「静态展开」布局（性能方案 P1-2 的 LOD 收尾）。
 *
 * 背景：4k 节点的全局图里 88% 是时刻点，而时刻点**没有位置 seed**（`node_positions` 只存主题）。
 * 打开图谱时它们从随机位置开始，靠力导跑 180 tick 才散开——每 tick 约 30–55 ms，用户要等 9 s。
 *
 * 这里换一种排法：主题用库里的 seed（没有 seed 的放到已定位邻居的重心），时刻按「绕自己主题
 * 的一圈螺旋」直接算出来。全都是**确定性纯函数**——同样的输入永远得到同样的坐标，所以可以：
 * - 一次性摆好后把节点钉住（`fx/fy`），引擎不用跑，打开即静；
 * - `graph:changed` 就地刷新时不会因为多了一张时刻而整体跳一下。
 *
 * 取舍：时刻不再参与力导，拖主题时时刻不会自动跟过去（画布在拖拽结束时按新位置重摆该主题的成员）。
 */

export interface BloomPoint {
  x: number
  y: number
}

export interface BloomNodeLike {
  id: string
}

/** 只用到端点与 kind；force-graph 初始化后会把它换成对象，这里两种都认 */
export interface BloomLinkLike {
  source: unknown
  target: unknown
  kind?: string
  /** 画布会按 weight 算距离，这里不看，只是为了能直接吃 GraphModelLink */
  weight?: number
}

export interface BloomLayoutOptions {
  nodes: readonly BloomNodeLike[]
  links: readonly BloomLinkLike[]
  /** 节点类型（全局图里主题是 activity / knowledge、时刻是 moment）；缺省按 id 前缀兜底 */
  typeOf?: (id: string) => string | undefined
  /** 主题半径：成员时刻的螺旋要从圆外面开始，否则会被主题盖住 */
  sizeOf?: (id: string) => number
  /** 主题的历史坐标（`node_positions`） */
  seeds?: ReadonlyMap<string, BloomPoint> | null
  /** 「重排」按钮换一个角度，其余输入不变时结果也不变 */
  rotation?: number
}

/** 每个主题自身在轨道上的角度偏移，避免所有主题的时刻都朝同一方向 */
const THEME_ANGLE_HASH = Math.PI * 2

/** 时刻绕主题的第一圈半径 / 每往外一圈的增量 */
const MOMENT_RING_BASE = 12
const MOMENT_RING_STEP = 5
/** 相邻时刻的角度增量（黄金角：任意前缀都不会挤在一起） */
const GOLDEN_ANGLE = 2.399963229728653

/** FNV-1a 32 位：把 id 稳定地映射到 [0,1)，不受节点顺序影响 */
export function hashUnit(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0x1_0000_0000
}

function endpointId(endpoint: unknown): string | null {
  if (typeof endpoint === 'string') return endpoint
  if (endpoint && typeof endpoint === 'object' && 'id' in endpoint) {
    const id = (endpoint as { id: unknown }).id
    if (typeof id === 'string') return id
    if (typeof id === 'number') return String(id)
  }
  return null
}

function defaultTypeOf(id: string): string {
  if (id.startsWith('m:')) return 'moment'
  if (id.startsWith('t:')) return 'theme'
  return 'other'
}

/** 只按「是不是时刻」分两类：全局图的主题 type 是 activity / knowledge，不叫 theme */
function isMomentNode(id: string, type: string | undefined): boolean {
  if (type === 'moment') return true
  if (type) return false
  return id.startsWith('m:')
}

/**
 * 第 `index` 个成员时刻绕主题中心的位置（黄金角螺旋：任意前缀都不会挤在一起）。
 * 画布在「拖完主题」时也用它把成员时刻摆到新位置，保证拖拽前后是同一套规则。
 */
export function momentOrbitPoint(
  themeId: string,
  index: number,
  center: BloomPoint,
  rotation = 0,
  baseRadius = MOMENT_RING_BASE
): BloomPoint {
  const angle = rotation * 0.35 + hashUnit(themeId) * THEME_ANGLE_HASH + index * GOLDEN_ANGLE
  const radius = Math.max(baseRadius, MOMENT_RING_BASE) + MOMENT_RING_STEP * Math.sqrt(index)
  return {
    x: center.x + Math.cos(angle) * radius,
    y: center.y + Math.sin(angle) * radius
  }
}

/**
 * 算出整张图的静态坐标。
 *
 * - 有 seed 的主题：原地不动（用户上次看到的布局保持不变）；
 * - 没有 seed 的主题：优先落在「已定位的相邻主题」的重心旁边（新主题不会飞到天边）；
 *   连一个已定位邻居都没有的，按 id 哈希撒在外圈；
 * - 时刻：绕它的第一个主题排黄金角螺旋；多归属时刻落在几个主题的重心附近。
 */
export function computeBloomLayout(options: BloomLayoutOptions): Map<string, BloomPoint> {
  const typeOf = options.typeOf ?? defaultTypeOf
  const rotation = options.rotation ?? 0
  const seeds = options.seeds ?? null

  const themeIds: string[] = []
  const momentIds: string[] = []
  for (const node of options.nodes) {
    // 全局图里的主题是 activity / knowledge 两种 type，时刻固定是 moment ——
    // 所以只认「是不是时刻」，其余都当主题（将来的 tag / 占位节点也不会被漏掉）。
    if (isMomentNode(node.id, typeOf(node.id))) momentIds.push(node.id)
    else themeIds.push(node.id)
  }
  const result = new Map<string, BloomPoint>()
  if (themeIds.length === 0 && momentIds.length === 0) return result

  const themeSet = new Set(themeIds)
  const positions = new Map<string, BloomPoint>()

  // 1) seed 先落位
  for (const id of themeIds) {
    const seed = seeds?.get(id)
    if (seed && Number.isFinite(seed.x) && Number.isFinite(seed.y)) {
      positions.set(id, { x: seed.x, y: seed.y })
    }
  }

  // 2) 主题之间的邻接（只认两端都是主题的边；无向，两个方向都要记）
  const themeNeighbors = new Map<string, string[]>()
  for (const link of options.links) {
    const source = endpointId(link.source)
    const target = endpointId(link.target)
    if (source === null || target === null) continue
    if (!themeSet.has(source) || !themeSet.has(target)) continue
    const forward = themeNeighbors.get(source) ?? []
    forward.push(target)
    themeNeighbors.set(source, forward)
    const backward = themeNeighbors.get(target) ?? []
    backward.push(source)
    themeNeighbors.set(target, backward)
  }

  // 3) 没 seed 的主题：先挂到已定位邻居的重心，剩下的按哈希撒在外圈
  const unplaced = themeIds.filter((id) => !positions.has(id))
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false
    for (const id of unplaced) {
      if (positions.has(id)) continue
      const neighbors = (themeNeighbors.get(id) ?? []).filter((other) => positions.has(other))
      if (neighbors.length === 0) continue
      let sumX = 0
      let sumY = 0
      for (const other of neighbors) {
        const point = positions.get(other) as BloomPoint
        sumX += point.x
        sumY += point.y
      }
      // 与邻居错开一点：否则同簇新主题会精确重叠成一个点（与 rotation 无关：
      // 「重排」只换成员时刻的角度，主题不该因为点了一下按钮就整体漂移）
      const jitter = hangOff(hashUnit(id), 90)
      positions.set(id, {
        x: sumX / neighbors.length + jitter.x,
        y: sumY / neighbors.length + jitter.y
      })
      changed = true
    }
    if (!changed) break
  }
  const outerRadius = Math.max(160, 40 * Math.sqrt(themeIds.length))
  unplaced.filter((id) => !positions.has(id)).forEach((id, index) => {
    const angle = hashUnit(id) * Math.PI * 2
    const radius = outerRadius * (0.7 + 0.6 * ((index + 1) / (unplaced.length + 1)))
    positions.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
  })

  for (const [id, point] of positions) result.set(id, point)

  // 4) 时刻：按所属主题分组，组内按稳定顺序排黄金角螺旋
  const themesOfMoment = new Map<string, string[]>()
  for (const link of options.links) {
    if (link.kind !== 'membership') continue
    const source = endpointId(link.source)
    const target = endpointId(link.target)
    if (source === null || target === null) continue
    if (!themeSet.has(source)) continue
    const list = themesOfMoment.get(target) ?? []
    list.push(source)
    themesOfMoment.set(target, list)
  }

  const ringIndex = new Map<string, number>()
  for (const momentId of momentIds) {
    const themes = (themesOfMoment.get(momentId) ?? []).filter((id) => positions.has(id))
    if (themes.length === 0) {
      // 没有归属（模型没归 / 主题被筛掉）：撒在外圈，别把所有孤儿时刻堆在原点
      const angle = hashUnit(momentId) * Math.PI * 2
      const radius = outerRadius * 1.15 + hashUnit(`${momentId}@`) * 60
      result.set(momentId, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius })
      continue
    }

    if (themes.length === 1) {
      const themeId = themes[0]
      const index = ringIndex.get(themeId) ?? 0
      ringIndex.set(themeId, index + 1)
      const size = Math.max(0, options.sizeOf?.(themeId) ?? 0)
      result.set(
        momentId,
        momentOrbitPoint(
          themeId,
          index,
          positions.get(themeId) as BloomPoint,
          rotation,
          size + 7
        )
      )
      continue
    }

    // 多归属：落在几个主题的重心，再按时刻自己的哈希散开一点
    let sumX = 0
    let sumY = 0
    for (const themeId of themes) {
      const point = positions.get(themeId) as BloomPoint
      sumX += point.x
      sumY += point.y
    }
    const angle = hashUnit(momentId) * Math.PI * 2
    const radius = 6 + hashUnit(`${momentId}@`) * 10
    result.set(momentId, {
      x: sumX / themes.length + Math.cos(angle) * radius,
      y: sumY / themes.length + Math.sin(angle) * radius
    })
  }

  return result
}

function hangOff(unit: number, radius: number): BloomPoint {
  const angle = unit * Math.PI * 2
  const distance = radius * (0.35 + 0.65 * unit)
  return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance }
}
