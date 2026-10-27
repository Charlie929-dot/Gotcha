/**
 * 问记忆窗口（S3-lite）
 *
 * 一次提问 → 一段回答 + 引用段列表；点引用 → 段证据（内容片段 + 截图）。
 * 没有 UI 框架：直接建 DOM，状态只有「就绪 / 在想 / 出错」三种。
 */
import type { ChainAskCitation, ChainAskResult } from '../../chain/agent/types'
import type { ChainAskErrorReason } from '../../chain/agent/types'
import type { SegmentEvidence } from '../../chain/agent/evidence'
import type { AskApi } from '../ask-preload'

declare global {
  interface Window {
    gotchaAsk?: AskApi
  }
}

const api = window.gotchaAsk

function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`缺少元素 #${id}`)
  return element as T
}

const form = must<HTMLFormElement>('form')
const questionInput = must<HTMLInputElement>('question')
const submitButton = must<HTMLButtonElement>('submit')
const statusEl = must<HTMLSpanElement>('status')
const consentBox = must<HTMLElement>('consent')
const answerBox = must<HTMLElement>('answer-box')
const answerText = must<HTMLParagraphElement>('answer')
const citationCount = must<HTMLSpanElement>('citation-count')
const citationsList = must<HTMLUListElement>('citations')
const emptyBox = must<HTMLElement>('empty')
const emptyText = must<HTMLParagraphElement>('empty-text')
const evidenceBox = must<HTMLElement>('evidence')
const evidenceTitle = must<HTMLElement>('evidence-title')
const evidenceMeta = must<HTMLParagraphElement>('evidence-meta')
const evidenceShots = must<HTMLElement>('evidence-shots')
const evidenceText = must<HTMLPreElement>('evidence-text')

function setStatus(kind: 'idle' | 'busy' | 'error', text: string): void {
  statusEl.dataset.kind = kind
  statusEl.textContent = text
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function hideAll(): void {
  answerBox.hidden = true
  emptyBox.hidden = true
  evidenceBox.hidden = true
}

function showEmpty(text: string): void {
  emptyText.textContent = text
  emptyBox.hidden = false
}

const ERROR_TEXT: Record<ChainAskErrorReason, string> = {
  'empty-question': '问题不能为空。',
  consent: '还没允许出云，先把上面那条确认掉。',
  budget: '今天的模型额度用完了，明天再问。',
  client: '没有可用的模型：去设置里配好供应商与 API key 再来。',
  'question-blocked': '这句话里有敏感内容（密码类），没有发出去。',
  unparseable: '模型这次答得不成形（结构不对），换个问法再试。',
  failed: '问记忆出错了，细节看日志。'
}

function renderCitations(citations: ChainAskCitation[]): void {
  citationsList.replaceChildren()
  citationCount.textContent = `（${citations.length} 段）`
  for (const citation of citations) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    const title = document.createElement('span')
    title.className = 'citation-title'
    title.textContent = citation.title || '（无标题窗口）'
    const meta = document.createElement('span')
    meta.className = 'citation-meta'
    meta.textContent = `${citation.app || '未知应用'} · ${formatTime(citation.at)}`
    button.append(title, meta)
    if (citation.why) {
      const why = document.createElement('span')
      why.className = 'citation-why'
      why.textContent = citation.why
      button.append(why)
    }
    button.addEventListener('click', () => {
      void showEvidence(citation.segmentId)
    })
    item.append(button)
    citationsList.append(item)
  }
}

function renderAnswer(result: Extract<ChainAskResult, { kind: 'answer' }>): void {
  answerText.textContent = result.answer
  renderCitations(result.citations)
  answerBox.hidden = false
}

async function showEvidence(segmentId: number): Promise<void> {
  if (!api) return
  setStatus('busy', '读取证据…')
  try {
    const evidence = await api.segment(segmentId)
    if (!evidence) {
      setStatus('error', '这段证据读不到了')
      return
    }
    renderEvidence(evidence)
    setStatus('idle', '就绪')
  } catch (error) {
    setStatus('error', `读证据失败：${String(error)}`)
  }
}

function renderEvidence(evidence: SegmentEvidence): void {
  evidenceTitle.textContent = evidence.title || '（无标题窗口）'
  const parts = [
    evidence.app || '未知应用',
    `${formatTime(evidence.startTs)} → ${formatTime(evidence.endTs)}`,
    `有效 ${formatDuration(evidence.activeMs)}`
  ]
  if (evidence.tags.length > 0) parts.push(`标签：${evidence.tags.join(' / ')}`)
  if (evidence.links.length > 0) parts.push(`双链：${evidence.links.join(' / ')}`)
  evidenceMeta.textContent = parts.join(' · ')

  evidenceShots.replaceChildren()
  for (const shot of evidence.shots) {
    if (!shot.dataUrl) continue
    const image = document.createElement('img')
    image.src = shot.dataUrl
    image.alt = `证据截图 ${formatTime(shot.ts)}`
    evidenceShots.append(image)
  }
  evidenceText.textContent =
    evidence.contents.map((content) => content.text).join('\n\n---\n\n') || '（这一段没有可读正文）'
  evidenceBox.hidden = false
}

async function ask(question: string): Promise<void> {
  if (!api) {
    setStatus('error', '窗口没接上主进程（preload 缺失）')
    return
  }
  hideAll()
  submitButton.disabled = true
  questionInput.disabled = true
  setStatus('busy', '在想…')
  try {
    const result = await api.query(question)
    if (result.kind === 'answer') {
      renderAnswer(result)
      setStatus('idle', `命中 ${result.stats.hits} 段，引用 ${result.citations.length} 段`)
    } else if (result.kind === 'no-evidence') {
      showEmpty('信息链里没找到。换个说法，或者把时间范围说具体一点。')
      setStatus('idle', `命中 ${result.stats.hits} 段，但证据不足以回答`)
    } else {
      showEmpty(ERROR_TEXT[result.reason] ?? result.message)
      setStatus('error', ERROR_TEXT[result.reason] ?? '出错了')
    }
  } catch (error) {
    showEmpty(`问记忆出错了：${String(error)}`)
    setStatus('error', '出错了')
  } finally {
    submitButton.disabled = false
    questionInput.disabled = false
    questionInput.focus()
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const question = questionInput.value.trim()
  if (question === '') {
    setStatus('error', '问题不能为空')
    return
  }
  void ask(question)
})

must<HTMLButtonElement>('consent-allow').addEventListener('click', () => {
  void api
    ?.setConsent(true)
    .then((view) => {
      if (view?.consented) consentBox.hidden = true
    })
    .catch((error: unknown) => setStatus('error', `确认失败：${String(error)}`))
})

must<HTMLButtonElement>('consent-deny').addEventListener('click', () => {
  consentBox.hidden = true
  showEmpty('没允许出云，问记忆不会把内容发出去。想用时再点上面那条确认。')
  setStatus('idle', '不出网')
})

must<HTMLButtonElement>('evidence-close').addEventListener('click', () => {
  evidenceBox.hidden = true
})

void (async () => {
  questionInput.focus()
  if (!api) {
    setStatus('error', '窗口没接上主进程（preload 缺失）')
    return
  }
  try {
    const view = await api.consent()
    if (!view) return
    if (!view.consented) consentBox.hidden = false
    if (!view.clientReady) {
      setStatus('error', `没有可用的模型（${view.clientReason ?? '未配置'}）`)
    }
  } catch (error) {
    setStatus('error', `读取状态失败：${String(error)}`)
  }
})()
