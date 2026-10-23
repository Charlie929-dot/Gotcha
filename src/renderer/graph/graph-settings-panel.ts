/**
 * 设置抽屉（M2 Phase 2 / D21/D22/D24）
 *
 * - 归纳参数（自动 / 间隔 / 预算 / 退避 / 批量 / 输出上限）；
 * - 供应商列表（id / 名称 / baseUrl / model / apiKeyEnv）+ 当前供应商；密钥值不回显、不落库；
 * - 快捷键两键 + 保存后注册冲突标红；
 * - 出网确认门（D24，可撤销）。
 *
 * 所有值都交给主进程 `graph:settings:save` 校验，这里不做「静默修正」；失败原样显示原因。
 */

import type { GraphSettingsView } from '../../main/graph-settings'
import type { HotkeyRegisterResult } from '../../main/hotkeys'
import type { GraphApi } from '../graph-preload'

export interface SettingsPanel {
  open(): Promise<void>
  close(): void
  isOpen(): boolean
}

const ELEMENT_IDS = [
  'drawer',
  'settings-close',
  'settings-form',
  'set-auto',
  'set-interval',
  'set-budget',
  'set-backoff',
  'set-batch',
  'set-max-tokens',
  'set-consent',
  'usage',
  'set-active',
  'set-providers',
  'set-add-provider',
  'set-hotkey-toggle',
  'set-hotkey-graph',
  'set-hotkey-status',
  'settings-msg',
  'settings-save'
] as const

type ElementKey = (typeof ELEMENT_IDS)[number]

function byId<T extends HTMLElement = HTMLElement>(root: HTMLElement, id: ElementKey): T {
  const element = root.querySelector<T>(`#${id}`)
  if (!element) throw new Error(`设置抽屉缺少 #${id}`)
  return element
}

interface ProviderRow {
  id: HTMLInputElement
  label: HTMLInputElement
  baseUrl: HTMLInputElement
  model: HTMLInputElement
  apiKeyEnv: HTMLInputElement
  remove: HTMLButtonElement
  root: HTMLElement
}

export function createSettingsPanel(
  root: HTMLElement,
  api: GraphApi,
  onSaved: (settings: GraphSettingsView) => void
): SettingsPanel {
  const drawer = byId(root, 'drawer')
  const closeButton = byId<HTMLButtonElement>(root, 'settings-close')
  const form = byId<HTMLFormElement>(root, 'settings-form')
  const autoInput = byId<HTMLInputElement>(root, 'set-auto')
  const intervalInput = byId<HTMLInputElement>(root, 'set-interval')
  const budgetInput = byId<HTMLInputElement>(root, 'set-budget')
  const backoffInput = byId<HTMLInputElement>(root, 'set-backoff')
  const batchInput = byId<HTMLInputElement>(root, 'set-batch')
  const maxTokensInput = byId<HTMLInputElement>(root, 'set-max-tokens')
  const consentInput = byId<HTMLInputElement>(root, 'set-consent')
  const usageEl = byId(root, 'usage')
  const activeSelect = byId<HTMLSelectElement>(root, 'set-active')
  const providersEl = byId(root, 'set-providers')
  const addProviderButton = byId<HTMLButtonElement>(root, 'set-add-provider')
  const hotkeyToggleInput = byId<HTMLInputElement>(root, 'set-hotkey-toggle')
  const hotkeyGraphInput = byId<HTMLInputElement>(root, 'set-hotkey-graph')
  const hotkeyStatusEl = byId(root, 'set-hotkey-status')
  const messageEl = byId(root, 'settings-msg')
  const saveButton = byId<HTMLButtonElement>(root, 'settings-save')

  const rows: ProviderRow[] = []
  let current: GraphSettingsView | null = null

  function setMessage(text: string, kind: 'ok' | 'error' | 'muted' = 'muted'): void {
    messageEl.textContent = text
    messageEl.style.color = kind === 'error' ? 'var(--error)' : kind === 'ok' ? 'var(--activity)' : ''
  }

  function syncActiveOptions(selected?: string): void {
    const previous = selected ?? activeSelect.value
    activeSelect.replaceChildren()
    for (const row of rows) {
      const id = row.id.value.trim() || '（未命名）'
      const option = document.createElement('option')
      option.value = row.id.value.trim()
      option.textContent = row.label.value.trim() || id
      activeSelect.append(option)
    }
    if ([...activeSelect.options].some((option) => option.value === previous)) {
      activeSelect.value = previous
    }
  }

  function addProviderRow(provider?: {
    id: string
    label: string
    baseUrl: string
    model: string
    apiKeyEnv: string
  }): void {
    const rowEl = document.createElement('div')
    rowEl.className = 'provider-row'
    rowEl.dataset.role = 'provider'

    const make = (field: string, placeholder: string, value: string): HTMLInputElement => {
      const input = document.createElement('input')
      input.type = 'text'
      input.dataset.field = field
      input.placeholder = placeholder
      input.value = value
      rowEl.append(input)
      return input
    }

    const id = make('id', 'id（唯一）', provider?.id ?? '')
    const label = make('label', '名称', provider?.label ?? '')
    const baseUrl = make('baseUrl', 'baseUrl（https）', provider?.baseUrl ?? '')
    const model = make('model', 'model', provider?.model ?? '')
    const apiKeyEnv = make('apiKeyEnv', 'API key 环境变量名', provider?.apiKeyEnv ?? '')
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = '删除'
    remove.addEventListener('click', () => {
      const index = rows.findIndex((row) => row.root === rowEl)
      if (index >= 0) rows.splice(index, 1)
      rowEl.remove()
      syncActiveOptions()
    })
    rowEl.append(remove)
    id.addEventListener('input', () => syncActiveOptions())
    label.addEventListener('input', () => syncActiveOptions())

    providersEl.append(rowEl)
    rows.push({ id, label, baseUrl, model, apiKeyEnv, remove, root: rowEl })
    syncActiveOptions()
  }

  function fillProviders(settings: GraphSettingsView): void {
    providersEl.replaceChildren()
    rows.length = 0
    for (const provider of settings.providers) addProviderRow(provider)
    if (settings.providers.length === 0) addProviderRow()
    syncActiveOptions(settings.activeProvider)
  }

  async function refreshHotkeyStatus(): Promise<void> {
    try {
      const results = await api.hotkeys()
      if (!Array.isArray(results)) return
      hotkeyToggleInput.classList.remove('hotkey-error')
      hotkeyGraphInput.classList.remove('hotkey-error')
      const failures = results.filter((result) => !result.ok)
      for (const result of failures) {
        if (result.action === 'toggleCapture') hotkeyToggleInput.classList.add('hotkey-error')
        if (result.action === 'openGraph') hotkeyGraphInput.classList.add('hotkey-error')
      }
      hotkeyStatusEl.textContent =
        failures.length === 0
          ? '两个热键均已注册。'
          : failures
              .map(
                (result: HotkeyRegisterResult) =>
                  `${result.accelerator}：${
                    result.reason === 'duplicate'
                      ? '与另一个快捷键相同'
                      : result.reason === 'invalid'
                        ? '格式不支持'
                        : '被系统或其他应用占用'
                  }`
              )
              .join('；')
    } catch {
      hotkeyStatusEl.textContent = '无法读取热键注册状态。'
    }
  }

  async function open(): Promise<void> {
    drawer.hidden = false
    setMessage('读取中…')
    try {
      const settings = await api.settings()
      if ('error' in settings) {
        setMessage('读取设置失败：无权限或数据库不可用', 'error')
        return
      }
      current = settings
      autoInput.checked = settings.auto
      intervalInput.value = String(settings.intervalMinutes)
      budgetInput.value = String(settings.budgetTokensPerDay)
      backoffInput.value = settings.retryBackoffMinutes
      batchInput.value = String(settings.batchMaxMoments)
      maxTokensInput.value = String(settings.maxTokens)
      consentInput.checked = settings.outboundConsent
      hotkeyToggleInput.value = settings.hotkeys.toggleCapture
      hotkeyGraphInput.value = settings.hotkeys.openGraph
      usageEl.textContent = `今日用量：${settings.usage.calls} 次调用 / 输入 ${settings.usage.promptTokens} tokens / 输出 ${settings.usage.completionTokens} tokens`
      fillProviders(settings)
      setMessage('')
      void refreshHotkeyStatus()
    } catch (error) {
      setMessage(`读取设置失败：${String(error)}`, 'error')
    }
  }

  function close(): void {
    drawer.hidden = true
  }

  addProviderButton.addEventListener('click', () => addProviderRow())
  closeButton.addEventListener('click', close)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!current) return
    saveButton.disabled = true
    setMessage('保存中…')
    try {
      const providers = rows.map((row) => ({
        id: row.id.value.trim(),
        label: row.label.value.trim(),
        baseUrl: row.baseUrl.value.trim(),
        model: row.model.value.trim(),
        apiKeyEnv: row.apiKeyEnv.value.trim()
      }))
      const payload = {
        auto: autoInput.checked,
        intervalMinutes: Number(intervalInput.value),
        budgetTokensPerDay: Number(budgetInput.value),
        retryBackoffMinutes: backoffInput.value
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part !== '')
          .map(Number),
        batchMaxMoments: Number(batchInput.value),
        maxTokens: Number(maxTokensInput.value),
        providers,
        activeProvider: activeSelect.value,
        hotkeys: {
          toggleCapture: hotkeyToggleInput.value.trim(),
          openGraph: hotkeyGraphInput.value.trim()
        },
        outboundConsent: consentInput.checked
      }
      const result = await api.saveSettings(payload)
      if (!result.ok) {
        setMessage(result.error, 'error')
        return
      }
      current = result.settings
      fillProviders(result.settings)
      hotkeyToggleInput.value = result.settings.hotkeys.toggleCapture
      hotkeyGraphInput.value = result.settings.hotkeys.openGraph
      consentInput.checked = result.settings.outboundConsent
      setMessage('已保存', 'ok')
      onSaved(result.settings)
      void refreshHotkeyStatus()
    } catch (error) {
      setMessage(`保存失败：${String(error)}`, 'error')
    } finally {
      saveButton.disabled = false
    }
  })

  return {
    open,
    close,
    isOpen: () => !drawer.hidden
  }
}
