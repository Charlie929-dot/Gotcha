import { describe, expect, it, vi } from 'vitest'
import {
  buildTrayMenu,
  toMenuTemplate,
  toggleEnabled,
  toggleLabel,
  type TrayMenuAction,
  type TrayMenuActions,
  type TrayMenuEntry
} from '../../src/main/tray-menu'

function actions(): TrayMenuActions {
  return {
    openGraph: vi.fn((): void => {}),
    openTimeline: vi.fn((): void => {}),
    toggleCapture: vi.fn((): void => {}),
    quit: vi.fn((): void => {})
  }
}

function pickAction(entries: TrayMenuEntry[], id: string): TrayMenuAction {
  const found = entries.find((entry) => 'id' in entry && entry.id === id)
  if (!found || !('id' in found)) throw new Error(`找不到菜单项 ${id}`)
  return found
}

describe('toggleLabel / toggleEnabled：状态映射', () => {
  it('暂停态显示「开始记录」且可点', () => {
    expect(toggleLabel('paused')).toBe('开始记录')
    expect(toggleEnabled('paused')).toBe(true)
  })

  it('运行态显示「暂停记录」且可点', () => {
    expect(toggleLabel('running')).toBe('暂停记录')
    expect(toggleEnabled('running')).toBe(true)
  })

  it('转换在途显示进行时文案并禁用', () => {
    expect(toggleLabel('starting')).toBe('正在开始…')
    expect(toggleEnabled('starting')).toBe(false)
    expect(toggleLabel('stopping')).toBe('正在暂停…')
    expect(toggleEnabled('stopping')).toBe(false)
  })
})

describe('buildTrayMenu：托盘 / 球右键共用菜单（Q4）', () => {
  it('结构固定：打开图谱 / 打开时间线 / 开关 / 退出，含两条分隔线', () => {
    const entries = buildTrayMenu('paused', actions())
    expect(entries.map((entry) => ('id' in entry ? entry.id : entry.type))).toEqual([
      'open-graph',
      'open-timeline',
      'separator',
      'toggle-capture',
      'separator',
      'quit'
    ])
  })

  it('点击菜单项调用对应动作', () => {
    const handlers = actions()
    const entries = buildTrayMenu('running', handlers)

    pickAction(entries, 'open-graph').click()
    pickAction(entries, 'open-timeline').click()
    pickAction(entries, 'toggle-capture').click()
    pickAction(entries, 'quit').click()

    expect(handlers.openGraph).toHaveBeenCalledTimes(1)
    expect(handlers.openTimeline).toHaveBeenCalledTimes(1)
    expect(handlers.toggleCapture).toHaveBeenCalledTimes(1)
    expect(handlers.quit).toHaveBeenCalledTimes(1)
  })

  it('运行态开关项文案为「暂停记录」；starting 时禁用', () => {
    expect(pickAction(buildTrayMenu('running', actions()), 'toggle-capture').label).toBe('暂停记录')
    const starting = pickAction(buildTrayMenu('starting', actions()), 'toggle-capture')
    expect(starting.enabled).toBe(false)
    expect(starting.label).toBe('正在开始…')
  })
})

describe('toMenuTemplate', () => {
  it('分隔线映射为 type=separator', () => {
    expect(toMenuTemplate({ type: 'separator' })).toEqual({ type: 'separator' })
  })

  it('动作项保留 id / label / enabled / click', () => {
    const click = (): void => {}
    expect(toMenuTemplate({ id: 'quit', label: '退出', enabled: true, click })).toEqual({
      id: 'quit',
      label: '退出',
      enabled: true,
      click
    })
  })
})
