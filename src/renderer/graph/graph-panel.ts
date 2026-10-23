/**
 * 节点侧栏（M2 Phase 2 / C4 下钻）
 *
 * 点击节点 → 标题 / 摘要 / 时间范围 / 成员事件（时间、应用、标题、OCR 摘要 80 字、
 * 敏感徽标）+「在时间线中查看」。成员事件来自 `graph:node-events` 只读查询；
 * `missingIds` 非空要显式提示（C4 要求来源 100% 可溯，不允许静默丢来源）。
 */

import type { GraphDayData, GraphEventDto, GraphNodeDto, NodeEventsResult } from '../../understand/graph-query'
import { formatTime, summary } from '../timeline'

export interface NodePanelElements {
  panel: HTMLElement
  title: HTMLElement
  summary: HTMLElement
  meta: HTMLElement
  events: HTMLElement
  timelineButton: HTMLButtonElement
}

const TYPE_LABEL: Record<string, string> = {
  knowledge: '知识',
  activity: '行为',
  protected: '已保护'
}

export interface NodePanel {
  show(node: GraphNodeDto, result: NodeEventsResult): void
  showEvent(event: GraphEventDto, parentNode?: GraphNodeDto): void
  hide(): void
}

export function createNodePanel(
  elements: NodePanelElements,
  options: { openTimeline(ts: number): void }
): NodePanel {
  let currentTs: number | null = null

  elements.timelineButton.addEventListener('click', () => {
    if (currentTs !== null) options.openTimeline(currentTs)
  })

  return {
    show(node, result) {
      currentTs = node.tsStart
      elements.panel.hidden = false
      elements.title.textContent = node.title || '（无标题）'
      elements.summary.textContent = node.summary
      const type = TYPE_LABEL[node.type] ?? node.type
      const range =
        node.tsEnd > node.tsStart
          ? `${formatTime(node.tsStart)} – ${formatTime(node.tsEnd)}`
          : formatTime(node.tsStart)
      elements.meta.textContent = `${type} · ${range} · ${node.sourceCount} 条来源 · 连接 ${node.degree}`

      elements.events.replaceChildren()
      if (!result.found) {
        elements.events.append(listItem('节点不存在或已被删除'))
      } else if (result.malformed) {
        elements.events.append(listItem('节点来源数据损坏（source_events 不是合法 JSON）'))
      } else if (result.events.length === 0) {
        elements.events.append(listItem('没有可展示的成员事件'))
      } else {
        for (const event of result.events) {
          const li = document.createElement('li')
          li.dataset.eventId = String(event.id)

          const head = document.createElement('div')
          head.className = 'ev-head'
          const time = document.createElement('span')
          time.textContent = formatTime(event.ts)
          const app = document.createElement('span')
          app.textContent = event.app
          head.append(time, app)
          if (event.sensitive === 1) {
            const badge = document.createElement('span')
            badge.className = 'badge'
            badge.textContent = '敏感'
            head.append(badge)
          }

          const title = document.createElement('div')
          title.className = 'ev-title'
          title.textContent = event.windowTitle ?? ''

          const ocr = document.createElement('div')
          ocr.className = 'ev-ocr'
          ocr.textContent = summary(event.ocrText)

          li.append(head, title, ocr)
          elements.events.append(li)
        }
      }

      if (result.missingIds.length > 0) {
        elements.events.append(
          listItem(`有 ${result.missingIds.length} 个来源事件已不在库中（id: ${result.missingIds.join(', ')}）`, 'missing')
        )
      }
      elements.timelineButton.disabled = !result.found
    },

    showEvent(event, parentNode) {
      currentTs = event.ts
      elements.panel.hidden = false
      elements.title.textContent = event.windowTitle || event.app || '事件记录'
      elements.summary.textContent = `应用：${event.app} · 事件编号 #${event.id}`
      elements.meta.textContent = `${formatTime(event.ts)}${parentNode ? ` · 归属于「${parentNode.title}」` : ' · 游离事件'}`
      elements.events.replaceChildren()

      const li = document.createElement('li')
      li.dataset.eventId = String(event.id)
      const head = document.createElement('div')
      head.className = 'ev-head'
      const time = document.createElement('span')
      time.textContent = formatTime(event.ts)
      const app = document.createElement('span')
      app.textContent = event.app
      head.append(time, app)
      if (event.sensitive === 1) {
        const badge = document.createElement('span')
        badge.className = 'badge'
        badge.textContent = '敏感'
        head.append(badge)
      }
      const title = document.createElement('div')
      title.className = 'ev-title'
      title.textContent = event.windowTitle ?? ''
      li.append(head, title)
      elements.events.append(li)

      elements.timelineButton.disabled = false
    },

    hide() {
      currentTs = null
      elements.panel.hidden = true
    }
  }
}

function listItem(text: string, className?: string): HTMLLIElement {
  const li = document.createElement('li')
  if (className) li.className = className
  li.textContent = text
  return li
}
