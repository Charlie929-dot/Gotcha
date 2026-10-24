/**
 * 全局图侧栏（v0.3 §7.2 / §7.4）
 *
 * - 主题：标题 / 摘要 / 活跃区间 / 成员时刻数 / 来源事件数 / 连接数 + 成员事件；
 * - 时刻：原始事件列表 +「也属于」其它主题（多归属），主题可点击继续下钻；
 * - `missingIds` 非空要显式提示（C4 / G1 要求来源可溯，不允许静默丢来源）；
 * - 原始事件不上画布，只在这里展开。
 */

import type { GlobalMomentDto, GlobalThemeDto, NodeEventsResult } from '../../understand/graph-query'
import { formatTime, summary } from '../timeline'

export interface GlobalPanelElements {
  panel: HTMLElement
  title: HTMLElement
  summary: HTMLElement
  meta: HTMLElement
  relatedTitle: HTMLElement
  related: HTMLElement
  eventsTitle: HTMLElement
  events: HTMLElement
  timelineButton: HTMLButtonElement
}

export interface GlobalPanel {
  showTheme(theme: GlobalThemeDto, result: NodeEventsResult): void
  showMoment(
    moment: GlobalMomentDto,
    result: NodeEventsResult,
    themes: Array<Pick<GlobalThemeDto, 'id' | 'title'>>
  ): void
  hide(): void
}

const TYPE_LABEL: Record<string, string> = {
  knowledge: '知识',
  activity: '行为',
  protected: '已保护'
}

export function createGlobalPanel(
  elements: GlobalPanelElements,
  options: {
    openTimeline(ts: number): void
    selectTheme(themeId: number): void
  }
): GlobalPanel {
  let currentTs: number | null = null

  elements.timelineButton.addEventListener('click', () => {
    if (currentTs !== null) options.openTimeline(currentTs)
  })

  function renderEvents(result: NodeEventsResult, emptyText: string): void {
    elements.events.replaceChildren()
    if (!result.found) {
      elements.events.append(listItem('记录不存在或已被清理'))
    } else if (result.malformed) {
      elements.events.append(listItem('来源数据损坏（事件 id 不是合法 JSON）'))
    } else if (result.events.length === 0) {
      elements.events.append(listItem(emptyText))
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
        listItem(
          `有 ${result.missingIds.length} 个来源事件已不在库中（id: ${result.missingIds.join(', ')}）`,
          'missing'
        )
      )
    }
    elements.timelineButton.disabled = !result.found
  }

  function showRelated(themes: Array<Pick<GlobalThemeDto, 'id' | 'title'>>): void {
    elements.related.replaceChildren()
    const others = themes.slice(1)
    elements.relatedTitle.hidden = others.length === 0
    elements.related.hidden = others.length === 0
    if (others.length === 0) return
    for (const theme of others) {
      const li = document.createElement('li')
      li.dataset.themeId = String(theme.id)
      li.textContent = theme.title || `主题 #${theme.id}`
      li.title = '点击查看这个主题'
      li.addEventListener('click', () => options.selectTheme(theme.id))
      elements.related.append(li)
    }
  }

  return {
    showTheme(theme, result) {
      currentTs = theme.tsStart
      elements.panel.hidden = false
      elements.title.textContent = theme.title || '（无标题主题）'
      elements.summary.textContent = theme.summary
      const type = TYPE_LABEL[theme.type] ?? theme.type
      const range =
        theme.tsEnd > theme.tsStart
          ? `${formatTime(theme.tsStart)} – ${formatTime(theme.tsEnd)}`
          : formatTime(theme.tsStart)
      elements.meta.textContent = `${type} · ${range} · ${theme.memberCount} 个时刻 · ${theme.sourceCount} 条来源 · 连接 ${theme.degree}`
      showRelated([])
      elements.eventsTitle.textContent = '成员事件'
      renderEvents(result, '这个主题暂时没有可展示的成员事件')
    },

    showMoment(moment, result, themes) {
      currentTs = moment.startTs
      elements.panel.hidden = false
      const app = moment.app || '未知应用'
      const title = moment.windowTitle || moment.ocrSummary || '（无标题时刻）'
      elements.title.textContent = `${app} · ${title}`
      elements.summary.textContent = moment.ocrSummary ?? ''
      elements.meta.textContent = `${moment.dayKey} · ${formatTime(moment.startTs)} – ${formatTime(moment.endTs)} · ${result.events.length} 条原始事件 · ${themes.length} 个主题`
      showRelated(themes)
      elements.eventsTitle.textContent = '原始事件'
      renderEvents(result, '这个时刻暂时没有可展示的原始事件')
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
