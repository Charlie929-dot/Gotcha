/**
 * 设置抽屉（M2 Phase 2 / D21/D22/D24，2026-10-23 增补；D53 起由问记忆页共用）
 *
 * 同一个面板服务两类页面，字段**按页面里实际存在的元素裁剪**：
 * - 图谱页（经典 / 全局）：归纳参数、视图阈值、供应商、快捷键、出网确认、用量全在；
 * - 问记忆页（D53 迁移）：只放供应商 + 出网确认 + 用量——没有归纳 / 快捷键输入框，
 *   保存时就不带这些字段，绝不把别的页面的设置写成空值（这是本文件最要紧的约定）。
 *
 * 其它纪律沿用旧实现：密钥由主进程写入 userData/.env，settings 只存 apiKeyEnv 名；
 * 所有值交给主进程校验，这里不做「静默修正」，失败原样显示原因。
 */

import type { GraphSettingsSaveResult, GraphSettingsView } from '../../main/graph-settings'
import type { HotkeyRegisterResult } from '../../main/hotkeys'
import type {
  GraphRecomputeResult,
  ProviderKeySaveResult,
  ProviderModelsInput
} from '../../main/graph-ipc'
import type { LlmProvider } from '../../understand/cloud/providers'
import type { ApiKeySource } from '../../understand/cloud/providers'
import type { FetchModelsResult } from '../../understand/cloud/models'

export interface SettingsPanel {
  open(): Promise<void>
  close(): void
  isOpen(): boolean
}

/** 保存后哪些「需要重算图」的设置变了（调用方据此决定要不要重新拉图） */
export interface SettingsChange {
  /** 相似度阈值 / 连线数变了：主进程已按新阈值重算连线，调用方重新 load 即可 */
  thresholds: boolean
}

/**
 * 设置面板需要的**最小** API 面（不是整个 GraphApi）。
 * 图谱 preload 与问记忆 preload 都结构兼容；问记忆没有图谱，所以 recomputeGraph 可选。
 */
export interface SettingsApi {
  settings(): Promise<GraphSettingsView | { error: string }>
  saveSettings(patch: unknown): Promise<GraphSettingsSaveResult>
  providerModels(input: ProviderModelsInput): Promise<FetchModelsResult>
  saveProviderKey(providerId: string, apiKey: string): Promise<ProviderKeySaveResult>
  providerKeys(): Promise<Record<string, ApiKeySource | string>>
  hotkeys?(): Promise<HotkeyRegisterResult[]>
  /** 只有暴露了相似度阈值的页面才会用到 */
  recomputeGraph?(): Promise<GraphRecomputeResult>
}

type KeySource = 'env' | 'file' | 'none' | 'unknown'

/** 必须有：缺了说明页面标记写错，直接报错（比静默半残好） */
function byId<T extends HTMLElement = HTMLElement>(root: HTMLElement, id: string): T {
  const element = root.querySelector<T>(`#${id}`)
  if (!element) throw new Error(`设置抽屉缺少 #${id}`)
  return element
}

/** 可选：没有这段界面时整组跳过（问记忆页 / 经典页共用面板靠它） */
function opt<T extends HTMLElement = HTMLElement>(root: HTMLElement, id: string): T | null {
  return root.querySelector<T>(`#${id}`)
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
  api: SettingsApi,
  onSaved: (settings: GraphSettingsView, changed: SettingsChange) => void
): SettingsPanel {
  const drawer = byId(root, 'drawer')
  const closeButton = byId<HTMLButtonElement>(root, 'settings-close')
  const form = byId<HTMLFormElement>(root, 'settings-form')
  const messageEl = byId(root, 'settings-msg')
  const saveButton = byId<HTMLButtonElement>(root, 'settings-save')

  /* ---- 归纳（只有图谱页有；问记忆页缺省即整组不读不写） ---- */
  const autoInput = opt<HTMLInputElement>(root, 'set-auto')
  const onlineInput = opt<HTMLInputElement>(root, 'set-online')
  const intervalInput = opt<HTMLInputElement>(root, 'set-interval')
  const budgetInput = opt<HTMLInputElement>(root, 'set-budget')
  const backoffInput = opt<HTMLInputElement>(root, 'set-backoff')
  const batchInput = opt<HTMLInputElement>(root, 'set-batch')
  const maxTokensInput = opt<HTMLInputElement>(root, 'set-max-tokens')
  const usageEl = opt(root, 'usage')

  /* ---- 视图（只有全局图页有；三项阈值必须整组出现） ---- */
  const dayHeatInput = opt<HTMLInputElement>(root, 'set-day-heat')
  const scaleHintInput = opt<HTMLInputElement>(root, 'set-scale-hint')
  const mergeSimInput = opt<HTMLInputElement>(root, 'set-merge-sim')
  const edgeSimInput = opt<HTMLInputElement>(root, 'set-edge-sim')
  const edgeKInput = opt<HTMLInputElement>(root, 'set-edge-k')
  const thresholdInputs =
    mergeSimInput && edgeSimInput && edgeKInput
      ? { mergeSimInput, edgeSimInput, edgeKInput }
      : null

  /* ---- 供应商（图谱页与问记忆页都有） ---- */
  const activeSelect = opt<HTMLSelectElement>(root, 'set-active')
  const providersEl = opt(root, 'set-providers')
  const addProviderButton = opt<HTMLButtonElement>(root, 'set-add-provider')

  /* ---- 快捷键（只有图谱页有） ---- */
  const hotkeyToggleInput = opt<HTMLInputElement>(root, 'set-hotkey-toggle')
  const hotkeyGraphInput = opt<HTMLInputElement>(root, 'set-hotkey-graph')
  const hotkeyStatusEl = opt(root, 'set-hotkey-status')
  const hotkeySection = hotkeyToggleInput && hotkeyGraphInput && hotkeyStatusEl ? true : false

  /* ---- 出网确认（两类页面都有） ---- */
  const consentInput = opt<HTMLInputElement>(root, 'set-consent')

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

  /**
   * 阈值输入框 → `thresholds` patch。空框不发（保留库里已有值）；
   * 非数字原样发（JSON 里变 null，主进程按区间校验整单拒绝），这里不静默兜底。
   */
  function readThresholdPatch(): Record<string, number> | null {
    if (!thresholdInputs) return null
    const fields: Array<[string, HTMLInputElement]> = [
      ['themeMergeSim', thresholdInputs.mergeSimInput],
      ['edgeMinSim', thresholdInputs.edgeSimInput],
      ['edgeTopK', thresholdInputs.edgeKInput]
    ]
    const patch: Record<string, number> = {}
    for (const [key, input] of fields) {
      const raw = input.value.trim()
      if (raw === '') continue
      patch[key] = Number(raw)
    }
    return Object.keys(patch).length > 0 ? patch : null
  }

  /** 三个「要重算图」的阈值有没有变——没变就不触发回填 */
  function changedThresholds(
    before: GraphSettingsView['thresholds'],
    after: GraphSettingsView['thresholds']
  ): boolean {
    return (
      before.themeMergeSim !== after.themeMergeSim ||
      before.edgeMinSim !== after.edgeMinSim ||
      before.edgeTopK !== after.edgeTopK
    )
  }

  /** 阈值变了 -> 让主进程按新阈值重算连线，并给出可读结果（不抛错） */
  async function recomputeAfterThresholdChange(): Promise<string> {
    if (!api.recomputeGraph) return '已保存'
    try {
      const result = await api.recomputeGraph()
      if (!result.ok) {
        return result.reason === 'busy'
          ? '已保存；图谱正在回填，稍后重新打开图谱会按新阈值重算'
          : '已保存；数据库暂不可用，本次没能重算连线'
      }
      if (!result.embeddings) {
        return '已保存；本地向量模型未就绪，本次没有重算连线'
      }
      const merged = result.merges > 0 ? `，合并 ${result.merges} 个近重复主题` : ''
      return `已保存；已按新阈值重算 ${result.edges} 条相似连线${merged}`
    } catch {
      return '已保存；重算连线失败，下次打开图谱会自动重算'
    }
  }

  function nextCustomId(): string {
    for (;;) {
      customSeq += 1
      const candidate = `custom-${customSeq}`
      if (!rows.some((row) => row.idInput.value === candidate)) return candidate
    }
  }

  function syncActiveOptions(selected?: string): void {
    if (!activeSelect) return
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
    if (!providersEl) return
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
    if (!providersEl) return
    providersEl.replaceChildren()
    rows.length = 0
    for (const provider of settings.providers) addProviderRow(provider)
    if (settings.providers.length === 0) addProviderRow()
    syncActiveOptions(settings.activeProvider)
  }

  async function refreshKeyStatus(): Promise<void> {
    if (rows.length === 0) return
    let statuses: Record<string, ApiKeySource | string> = {}
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
    if (!hotkeyToggleInput || !hotkeyGraphInput || !hotkeyStatusEl || !api.hotkeys) return
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

  /** 把一份设置回填到本页存在的输入框里（缺什么填什么，缺的组整组跳过） */
  function fill(settings: GraphSettingsView): void {
    current = settings
    if (autoInput) autoInput.checked = settings.auto
    if (onlineInput) onlineInput.checked = settings.onlineThemes
    if (intervalInput) intervalInput.value = String(settings.intervalMinutes)
    if (budgetInput) budgetInput.value = String(settings.budgetTokensPerDay)
    if (backoffInput) backoffInput.value = settings.retryBackoffMinutes
    if (batchInput) batchInput.value = String(settings.batchMaxMoments)
    if (maxTokensInput) maxTokensInput.value = String(settings.maxTokens)
    if (dayHeatInput) dayHeatInput.value = String(settings.dayHeatMax)
    if (scaleHintInput) scaleHintInput.value = String(settings.scaleHintMoments)
    if (thresholdInputs) {
      thresholdInputs.mergeSimInput.value = String(settings.thresholds.themeMergeSim)
      thresholdInputs.edgeSimInput.value = String(settings.thresholds.edgeMinSim)
      thresholdInputs.edgeKInput.value = String(settings.thresholds.edgeTopK)
    }
    if (consentInput) consentInput.checked = settings.outboundConsent
    if (hotkeyToggleInput) hotkeyToggleInput.value = settings.hotkeys.toggleCapture
    if (hotkeyGraphInput) hotkeyGraphInput.value = settings.hotkeys.openGraph ?? ''
    if (usageEl) {
      usageEl.textContent = `今日用量：${settings.usage.calls} 次调用 / 输入 ${settings.usage.promptTokens} tokens / 输出 ${settings.usage.completionTokens} tokens`
    }
    fillProviders(settings)
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
      fill(settings)
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

  addProviderButton?.addEventListener('click', () => addProviderRow())
  closeButton.addEventListener('click', close)

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!current) return
    /** 保存前先留一份阈值：保存后库和 `current` 都是新值，只有这里能判断「真的变了」 */
    const before = current.thresholds
    saveButton.disabled = true
    setMessage('保存中…')
    try {
      /** 只发本页存在的字段：塞默认值会把别的页面（或旧版本）的设置覆盖掉 */
      const payload: Record<string, unknown> = {}
      if (autoInput) payload.auto = autoInput.checked
      if (onlineInput) payload.onlineThemes = onlineInput.checked
      if (intervalInput) payload.intervalMinutes = Number(intervalInput.value)
      if (budgetInput) payload.budgetTokensPerDay = Number(budgetInput.value)
      if (backoffInput) {
        payload.retryBackoffMinutes = backoffInput.value
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part !== '')
          .map(Number)
      }
      if (batchInput) payload.batchMaxMoments = Number(batchInput.value)
      if (maxTokensInput) payload.maxTokens = Number(maxTokensInput.value)
      if (dayHeatInput) payload.dayHeatMax = Number(dayHeatInput.value)
      if (scaleHintInput) payload.scaleHintMoments = Number(scaleHintInput.value)
      if (consentInput) payload.outboundConsent = consentInput.checked

      if (providersEl && activeSelect) {
        payload.providers = rows.map((row) => ({
          id: row.idInput.value.trim(),
          label: row.nameInput.value.trim(),
          baseUrl: row.baseUrlInput.value.trim(),
          model: row.modelInput.value.trim(),
          apiKeyEnv: row.apiKeyEnvInput.value.trim() || deriveEnvName(row.idInput.value)
        }))
        payload.activeProvider = activeSelect.value
      }
      if (hotkeySection && hotkeyToggleInput && hotkeyGraphInput) {
        payload.hotkeys = {
          toggleCapture: hotkeyToggleInput.value.trim(),
          openGraph: hotkeyGraphInput.value.trim()
        }
      }
      const thresholdPatch = readThresholdPatch()
      if (thresholdPatch) payload.thresholds = thresholdPatch

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

      fill(result.settings)
      for (const row of rows) {
        const key = failedKeys.get(row.idInput.value)
        if (key) row.apiKeyInput.value = key
      }
      void refreshKeyStatus()
      void refreshHotkeyStatus()

      // 阈值变了才重算（没变就不打扰后台回填）；重算完调用方再重新拉图
      const thresholdsChanged =
        thresholdInputs !== null && changedThresholds(before, result.settings.thresholds)
      let recomputeNote = ''
      if (thresholdsChanged) {
        setMessage('已保存，正在按新阈值重算连线…')
        recomputeNote = await recomputeAfterThresholdChange()
      }
      onSaved(result.settings, { thresholds: thresholdsChanged })

      if (failures.length > 0) {
        setMessage(`设置已保存，但密钥未保存：${failures.join('；')}`, 'error')
      } else if (warnings.length > 0) {
        setMessage(`已保存；${warnings.join('；')}`, 'ok')
      } else if (recomputeNote !== '') {
        setMessage(recomputeNote, 'ok')
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
