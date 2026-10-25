/**
 * `graph:*` IPC handler 表（不经过 ipcMain，直接调用通道函数）
 *
 * 重点回归：`graph:settings:save` 必须在**写库之前**读旧确认门。
 * 旧实现写库后才取 `getSnapshot().consent`（已是新值），比较永远相等 →
 * 撤销 D24 出网授权停不掉归纳调度、也 abort 不了在途请求（2026-10-25 发现并修）。
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, removeHandler: () => {} }
}))

import { createGraphIpcHandlers, type GraphIpcDeps } from '../../src/main/graph-ipc'
import type { GraphSettingsView } from '../../src/main/graph-settings'
import { GRAPH_THRESHOLD_DEFAULTS } from '../../src/understand/graph-thresholds'

const MAIN_FRAME = { mainFrame: true }

function settingsView(overrides: Partial<GraphSettingsView> = {}): GraphSettingsView {
  return {
    auto: true,
    intervalMinutes: 10,
    budgetTokensPerDay: 1_000_000,
    retryBackoffMinutes: '1,5,15',
    batchMaxMoments: 20,
    maxTokens: 2_000,
    dayHeatMax: 4_000,
    activeProvider: 'deepseek',
    providers: [
      {
        id: 'deepseek',
        label: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat',
        apiKeyEnv: 'DEEPSEEK_API_KEY'
      }
    ],
    providersInvalid: false,
    hotkeys: { toggleCapture: 'Alt+P', openGraph: 'Alt+Space' },
    outboundConsent: false,
    thresholds: { ...GRAPH_THRESHOLD_DEFAULTS },
    usage: { calls: 0, promptTokens: 0, completionTokens: 0 },
    ...overrides
  }
}

/** 只实现用到的几个依赖，其余用不到（被测通道不会碰） */
function fakeDeps(options: {
  previous: GraphSettingsView
  saved: GraphSettingsView
  onSaved?: (settings: GraphSettingsView, previousConsent: boolean) => void
}): GraphIpcDeps {
  const deps = {
    getGraphWindow: () => ({
      isDestroyed: () => false,
      webContents: { id: 7, mainFrame: MAIN_FRAME }
    }),
    readSettings: () => options.previous,
    saveSettings: () => ({ ok: true as const, settings: options.saved }),
    onSettingsSaved:
      options.onSaved ??
      (() => {
        /* 默认忽略 */
      }),
    log: () => {}
  }
  return deps as unknown as GraphIpcDeps
}

function handlerOf(deps: GraphIpcDeps, channel: string) {
  const handlers = createGraphIpcHandlers(deps)
  const found = handlers.find(([name]) => name === channel)
  if (!found) throw new Error(`没有 ${channel} 通道`)
  return found[1]
}

const EVENT = {
  sender: { id: 7 },
  senderFrame: MAIN_FRAME
} as unknown as Parameters<ReturnType<typeof handlerOf>>[0]

describe('graph:settings:save · 确认门顺序', () => {
  it('把「保存前」的确认门交给 onSettingsSaved（撤销授权时能停调度）', () => {
    const calls: Array<[boolean, boolean]> = []
    const deps = fakeDeps({
      previous: settingsView({ outboundConsent: true }),
      saved: settingsView({ outboundConsent: false }),
      onSaved: (settings, previousConsent) => calls.push([previousConsent, settings.outboundConsent])
    })

    const result = handlerOf(deps, 'graph:settings:save')(EVENT, { outboundConsent: false })
    expect(result).toMatchObject({ ok: true })
    // 旧值 true / 新值 false —— 顺序反了这里会变成 [false, false]
    expect(calls).toEqual([[true, false]])
  })

  it('授权方向同样拿得到旧值（true 之前是 false）', () => {
    const calls: Array<[boolean, boolean]> = []
    const deps = fakeDeps({
      previous: settingsView({ outboundConsent: false }),
      saved: settingsView({ outboundConsent: true }),
      onSaved: (settings, previousConsent) => calls.push([previousConsent, settings.outboundConsent])
    })
    handlerOf(deps, 'graph:settings:save')(EVENT, { outboundConsent: true })
    expect(calls).toEqual([[false, true]])
  })

  it('保存失败不触发 onSettingsSaved', () => {
    const onSaved = vi.fn()
    const deps = fakeDeps({
      previous: settingsView(),
      saved: settingsView(),
      onSaved
    })
    deps.saveSettings = () => ({ ok: false, error: 'bad' })
    expect(handlerOf(deps, 'graph:settings:save')(EVENT, {})).toMatchObject({ ok: false })
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('非图谱窗口主 frame 的调用一律拒绝', () => {
    const onSaved = vi.fn()
    const deps = fakeDeps({ previous: settingsView(), saved: settingsView(), onSaved })
    const handler = handlerOf(deps, 'graph:settings:save')
    const intruder = { sender: { id: 99 }, senderFrame: MAIN_FRAME } as unknown as typeof EVENT
    expect(handler(intruder, {})).toMatchObject({ ok: false, error: 'forbidden' })
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe('graph:recompute · 保存阈值后重算连线', () => {
  it('主 frame 调用：把主进程的重算结果原样返回', async () => {
    const deps = fakeDeps({ previous: settingsView(), saved: settingsView() })
    deps.recomputeGraph = async () => ({ ok: true, edges: 172, merges: 2, embeddings: true })

    const result = await handlerOf(deps, 'graph:recompute')(EVENT)

    expect(result).toEqual({ ok: true, edges: 172, merges: 2, embeddings: true })
  })

  it('模型未就绪（embeddings=false）也照原样返回，不伪装成已重算', async () => {
    const deps = fakeDeps({ previous: settingsView(), saved: settingsView() })
    deps.recomputeGraph = async () => ({ ok: true, edges: 0, merges: 0, embeddings: false })

    expect(await handlerOf(deps, 'graph:recompute')(EVENT)).toEqual({
      ok: true,
      edges: 0,
      merges: 0,
      embeddings: false
    })
  })

  it('回填在途（busy）如实透传，渲染层据此提示稍后再试', async () => {
    const deps = fakeDeps({ previous: settingsView(), saved: settingsView() })
    deps.recomputeGraph = async () => ({ ok: false, reason: 'busy' })

    expect(await handlerOf(deps, 'graph:recompute')(EVENT)).toEqual({ ok: false, reason: 'busy' })
  })

  it('非图谱窗口主 frame 的调用不触发重算', async () => {
    const recompute = vi.fn()
    const deps = fakeDeps({ previous: settingsView(), saved: settingsView() })
    deps.recomputeGraph = recompute
    const intruder = { sender: { id: 99 }, senderFrame: MAIN_FRAME } as unknown as typeof EVENT

    expect(await handlerOf(deps, 'graph:recompute')(intruder)).toMatchObject({ ok: false })
    expect(recompute).not.toHaveBeenCalled()
  })

  it('重算抛错只记「失败了」，返回 unavailable', async () => {
    const logged: string[] = []
    const deps = fakeDeps({ previous: settingsView(), saved: settingsView() })
    deps.recomputeGraph = async () => {
      throw new Error('boom')
    }
    deps.log = (_level, msg) => logged.push(msg)

    expect(await handlerOf(deps, 'graph:recompute')(EVENT)).toEqual({
      ok: false,
      reason: 'unavailable'
    })
    expect(logged).toEqual(['graph recompute failed'])
  })
})
