/**
 * 设置抽屉（M2 Phase 2 / D21/D22/D24，2026-10-23 增补）
 *
 * - 归纳参数（自动 / 间隔 / 预算 / 退避 / 批量 / 输出上限）；
 * - 供应商：名称 / baseUrl / API Key（直接填写，写后不回显）/ 模型（可「获取模型」）/ 高级变量名；
 *   密钥由主进程写入 userData/.env，settings 表只存 apiKeyEnv 名，永远不存密钥值；
 * - 快捷键两键 + 保存后注册冲突标红；
 * - 出网确认门（D24，可撤销）。
 *
 * 所有值都交给主进程校验，这里不做「静默修正」；失败原样显示原因。
 */

import type { GraphSettingsView } from '../../main/graph-settings'
import type { HotkeyRegisterResult } from '../../main/hotkeys'
import type { LlmProvider } from '../../understand/cloud/providers'
import type { GraphApi } from '../graph-preload'

export interface SettingsPanel {
  open(): Promise<void>
  close(): void
  isOpen(): boolean
}

type KeySource = 'env' | 'file' | 'none' | 'unknown'

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
  root: HTMLElement
  idInput: HTMLInputElement
  nameInput: HTMLInputElement
  baseUrlInput: HTMLInputElement
  modelInput: HTMLInputElement
  modelList: HTMLDataListElement
  modelDropdown: HTMLElement
  apiKeyInput: HTMLInputElement
  keyStatus: HTMLElement
  apiKeyEnvInput: HTMLInputElement
  fetchModelsButton: HTMLButtonElement
  modelsStatus: HTMLElement
  removeButton: HTMLButtonElement
}

/** 新供应商的变量名：由 id 派生，用户可在「高级」里改 */
function deriveEnvName(id: string): string {
  const normalized = id
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `GOTCHA_KEY_${normalized || 'PROVIDER'}`
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
  /**
   * 日格热力满量只在全局图页有输入框（经典按日页共用这个面板，没有「视图」段）。
   * 这里必须容错：缺元素时既不报错，也不在保存里带这个字段——
   * 否则从经典页保存会把它写成空值 / 覆盖掉全局页的设置。
   */
  const dayHeatInput = root.querySelector<HTMLInputElement>('#set-day-heat')
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
  /** 拉取过的模型清单：按 provider id 缓存，保存后重建行时仍能下拉 */
  const modelCatalogs = new Map<string, string[]>()
  let current: GraphSettingsView | null = null
  let customSeq = 0
  let rowSeq = 0

  function setMessage(text: string, kind: 'ok' | 'error' | 'muted' = 'muted'): void {
    messageEl.textContent = text
    messageEl.style.color = kind === 'error' ? 'var(--error)' : kind === 'ok' ? 'var(--activity)' : ''
  }

  function nextCustomId(): string {
    for (;;) {
      customSeq += 1
      const candidate = `custom-${customSeq}`
      if (!rows.some((row) => row.idInput.value === candidate)) return candidate
    }
  }

  function syncActiveOptions(selected?: string): void {
    const previous = selected ?? activeSelect.value
    activeSelect.replaceChildren()
    for (const row of rows) {
      const id = row.idInput.value.trim() || '（未命名）'
      const option = document.createElement('option')
      option.value = row.idInput.value.trim()
      option.textContent = row.nameInput.value.trim() || id
      activeSelect.append(option)
    }
    if ([...activeSelect.options].some((option) => option.value === previous)) {
      activeSelect.value = previous
    }
  }

  function makeField(labelText: string, placeholder: string): {
    label: HTMLLabelElement
    input: HTMLInputElement
  } {
    const label = document.createElement('label')
    label.className = 'provider-line'
    const text = document.createElement('span')
    text.textContent = labelText
    const input = document.createElement('input')
    input.type = 'text'
    input.placeholder = placeholder
    label.append(text, input)
    return { label, input }
  }

  function applyKeyStatus(row: ProviderRow, source: KeySource): void {
    row.keyStatus.dataset.source = source
    row.keyStatus.textContent =
      source === 'env'
        ? '已配置（环境变量优先）'
        : source === 'file'
          ? '已配置（userData/.env）'
          : source === 'none'
            ? '未配置密钥'
            : '密钥状态未知'
  }

  function applyCatalog(row: ProviderRow, models: string[], autoOpen = false): void {
    row.modelList.replaceChildren(
      ...models.map((id) => {
        const option = document.createElement('option')
        option.value = id
        return option
      })
    )
    row.modelDropdown.replaceChildren(
      ...models.map((id) => {
        const item = document.createElement('div')
        item.className = 'model-option'
        if (id === row.modelInput.value.trim()) item.classList.add('selected')
        item.textContent = id
        item.addEventListener('click', (e) => {
          e.stopPropagation()
          row.modelInput.value = id
          row.modelDropdown.hidden = true
        })
        return item
      })
    )
    if (models.length > 0 && row.modelInput.value.trim() === '') {
      row.modelInput.value = models[0]
    }
    if (autoOpen && models.length > 0) {
      row.modelDropdown.hidden = false
    }
  }

  async function fetchModelsForRow(row: ProviderRow): Promise<void> {
    const baseUrl = row.baseUrlInput.value.trim()
    if (baseUrl === '') {
      row.modelsStatus.textContent = '先填 Base URL'
      return
    }
    row.fetchModelsButton.disabled = true
    const original = row.fetchModelsButton.textContent
    row.fetchModelsButton.textContent = '获取中…'
    row.modelsStatus.textContent = ''
    try {
      const result = await api.providerModels({
        providerId: row.idInput.value,
        baseUrl,
        apiKey: row.apiKeyInput.value.trim() || undefined
      })
      if (!result.ok) {
        row.modelsStatus.textContent = result.error
        return
      }
      modelCatalogs.set(row.idInput.value, result.models)
      applyCatalog(row, result.models, true)
      row.modelsStatus.textContent = `已获取 ${result.models.length} 个模型（已展开选择）`
    } catch (error) {
      row.modelsStatus.textContent = `获取失败：${String(error)}`
    } finally {
      row.fetchModelsButton.disabled = false
      row.fetchModelsButton.textContent = original
    }
  }

  function addProviderRow(provider?: LlmProvider): void {
    rowSeq += 1
    const id = provider?.id ?? nextCustomId()
    const rowEl = document.createElement('div')
    rowEl.className = 'provider-row'
    rowEl.dataset.role = 'provider'

    const head = document.createElement('div')
    head.className = 'provider-head'
    const nameField = makeField('名称', '供应商名称')
    nameField.input.dataset.field = 'name'
    nameField.input.value = provider?.label ?? ''
    const removeButton = document.createElement('button')
    removeButton.type = 'button'
    removeButton.dataset.role = 'remove'
    removeButton.textContent = '删除'
    head.append(nameField.label, removeButton)

    const baseUrlField = makeField('Base URL', 'https://api.deepseek.com')
    baseUrlField.input.dataset.field = 'baseUrl'
    baseUrlField.input.value = provider?.baseUrl ?? ''

    const keyField = makeField('API Key', 'sk-…（留空则沿用已保存的密钥）')
    keyField.input.type = 'password'
    keyField.input.autocomplete = 'new-password'
    keyField.input.dataset.field = 'apiKey'
    const keyStatus = document.createElement('p')
    keyStatus.className = 'hint key-status'
    keyStatus.dataset.role = 'key-status'
    keyStatus.textContent = '未配置密钥'

    const datalistId = `model-options-${rowSeq}`
    const modelField = makeField('模型', 'deepseek-chat')
    modelField.input.dataset.field = 'model'
    modelField.input.setAttribute('list', datalistId)
    modelField.input.value = provider?.model ?? ''
    const modelList = document.createElement('datalist')
    modelList.id = datalistId

    const comboboxWrap = document.createElement('div')
    comboboxWrap.className = 'combobox-wrap'
    const toggleButton = document.createElement('button')
    toggleButton.type = 'button'
    toggleButton.className = 'combobox-toggle'
    toggleButton.textContent = '▼'
    toggleButton.title = '展开模型列表'
    const modelDropdown = document.createElement('div')
    modelDropdown.className = 'model-dropdown'
    modelDropdown.hidden = true

    // 重新组装 modelField
    modelField.label.removeChild(modelField.input)
    comboboxWrap.append(modelField.input, toggleButton, modelDropdown, modelList)
    modelField.label.append(comboboxWrap)

    const actions = document.createElement('div')
    actions.className = 'provider-actions'
    const fetchModelsButton = document.createElement('button')
    fetchModelsButton.type = 'button'
    fetchModelsButton.dataset.role = 'fetch-models'
    fetchModelsButton.textContent = '获取模型'
    const modelsStatus = document.createElement('span')
    modelsStatus.className = 'hint'
    modelsStatus.dataset.role = 'models-status'
    actions.append(fetchModelsButton, modelsStatus)

    const advanced = document.createElement('details')
    advanced.className = 'provider-advanced'
    const summary = document.createElement('summary')
    summary.textContent = '高级'
    const envField = makeField('密钥变量名', 'DEEPSEEK_API_KEY')
    envField.input.dataset.field = 'apiKeyEnv'
    envField.input.value = provider?.apiKeyEnv ?? deriveEnvName(id)
    envField.input.title = '密钥保存在 userData/.env 的这个变量名下'
    const idInput = document.createElement('input')
    idInput.type = 'hidden'
    idInput.dataset.field = 'id'
    idInput.value = id
    advanced.append(summary, envField.label, idInput)

    rowEl.append(
      head,
      baseUrlField.label,
      keyField.label,
      keyStatus,
      modelField.label,
      actions,
      advanced
    )
    providersEl.append(rowEl)

    const row: ProviderRow = {
      root: rowEl,
      idInput,
      nameInput: nameField.input,
      baseUrlInput: baseUrlField.input,
      modelInput: modelField.input,
      modelList,
      modelDropdown,
      apiKeyInput: keyField.input,
      keyStatus,
      apiKeyEnvInput: envField.input,
      fetchModelsButton,
      modelsStatus,
      removeButton
    }
    rows.push(row)

    toggleButton.addEventListener('click', (e) => {
      e.stopPropagation()
      const willOpen = modelDropdown.hidden
      // 关闭其他下拉
      for (const other of rows) other.modelDropdown.hidden = true
      if (willOpen) {
        applyCatalog(row, modelCatalogs.get(id) ?? [], true)
      }
    })

    modelField.input.addEventListener('click', () => {
      const catalog = modelCatalogs.get(id) ?? []
      if (catalog.length > 0 && modelDropdown.hidden) {
        applyCatalog(row, catalog, true)
      }
    })

    nameField.input.addEventListener('input', () => syncActiveOptions())
    removeButton.addEventListener('click', () => {
      const index = rows.findIndex((item) => item.root === rowEl)
      if (index >= 0) rows.splice(index, 1)
      rowEl.remove()
      syncActiveOptions()
    })
    fetchModelsButton.addEventListener('click', () => void fetchModelsForRow(row))
    applyCatalog(row, modelCatalogs.get(id) ?? [])
    syncActiveOptions()
  }

  function fillProviders(settings: GraphSettingsView): void {
    providersEl.replaceChildren()
    rows.length = 0
    for (const provider of settings.providers) addProviderRow(provider)
    if (settings.providers.length === 0) addProviderRow()
    syncActiveOptions(settings.activeProvider)
  }

  async function refreshKeyStatus(): Promise<void> {
    let statuses: Record<string, string> = {}
    let failed = false
    try {
      statuses = await api.providerKeys()
    } catch {
      failed = true
    }
    for (const row of rows) {
      const source = statuses[row.idInput.value]
      applyKeyStatus(
        row,
        failed ? 'unknown' : source === 'env' || source === 'file' ? source : 'none'
      )
    }
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
      if (dayHeatInput) dayHeatInput.value = String(settings.dayHeatMax)
      consentInput.checked = settings.outboundConsent
      hotkeyToggleInput.value = settings.hotkeys.toggleCapture
      hotkeyGraphInput.value = settings.hotkeys.openGraph
      usageEl.textContent = `今日用量：${settings.usage.calls} 次调用 / 输入 ${settings.usage.promptTokens} tokens / 输出 ${settings.usage.completionTokens} tokens`
      fillProviders(settings)
      void refreshKeyStatus()
      setMessage('')
      void refreshHotkeyStatus()
    } catch (error) {
      setMessage(`读取设置失败：${String(error)}`, 'error')
    }
  }

  function close(): void {
    drawer.hidden = true
    for (const row of rows) row.modelDropdown.hidden = true
  }

  document.addEventListener('click', (e) => {
    for (const row of rows) {
      if (!row.root.contains(e.target as Node)) {
        row.modelDropdown.hidden = true
      }
    }
  })

  addProviderButton.addEventListener('click', () => addProviderRow())
  closeButton.addEventListener('click', close)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!current) return
    saveButton.disabled = true
    setMessage('保存中…')
    try {
      const providers: LlmProvider[] = rows.map((row) => ({
        id: row.idInput.value.trim(),
        label: row.nameInput.value.trim(),
        baseUrl: row.baseUrlInput.value.trim(),
        model: row.modelInput.value.trim(),
        apiKeyEnv: row.apiKeyEnvInput.value.trim() || deriveEnvName(row.idInput.value)
      }))
      const payload: Record<string, unknown> = {
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
      // 只有全局图页有这个输入框；缺省时不要带字段（免得清掉已有设置）
      if (dayHeatInput) payload.dayHeatMax = Number(dayHeatInput.value)
      const result = await api.saveSettings(payload)
      if (!result.ok) {
        setMessage(result.error, 'error')
        return
      }

      // 设置落库后再写密钥：密钥单独走 userData/.env，不进 settings 表
      const failures: string[] = []
      const warnings: string[] = []
      const failedKeys = new Map<string, string>()
      for (const row of rows) {
        const key = row.apiKeyInput.value.trim()
        if (key === '') continue
        const name = row.nameInput.value.trim() || row.idInput.value
        try {
          const saved = await api.saveProviderKey(row.idInput.value, key)
          if (!saved.ok) {
            failures.push(`${name}：${saved.error}`)
            failedKeys.set(row.idInput.value, key)
          } else if (saved.warning) {
            warnings.push(`${name}：${saved.warning}`)
          }
        } catch (error) {
          failures.push(`${name}：${String(error)}`)
          failedKeys.set(row.idInput.value, key)
        }
      }

      current = result.settings
      fillProviders(result.settings)
      for (const row of rows) {
        const key = failedKeys.get(row.idInput.value)
        if (key) row.apiKeyInput.value = key
      }
      hotkeyToggleInput.value = result.settings.hotkeys.toggleCapture
      hotkeyGraphInput.value = result.settings.hotkeys.openGraph
      consentInput.checked = result.settings.outboundConsent
      if (dayHeatInput) dayHeatInput.value = String(result.settings.dayHeatMax)
      void refreshKeyStatus()
      void refreshHotkeyStatus()
      onSaved(result.settings)
      if (failures.length > 0) {
        setMessage(`设置已保存，但密钥未保存：${failures.join('；')}`, 'error')
      } else if (warnings.length > 0) {
        setMessage(`已保存；${warnings.join('；')}`, 'ok')
      } else {
        setMessage('已保存', 'ok')
      }
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
