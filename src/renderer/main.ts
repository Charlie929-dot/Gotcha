/**
 * 时间线只读视图（m1a-plan §3 Phase 3，无图谱、纯 DOM）
 */

import type { EventRow } from '../db'
import { dayRange, formatDate, formatTime, groupByDay, startOfDay, summary } from './timeline'

declare global {
  interface Window {
    gotcha: {
      timeline: {
        query(from: number, to: number): Promise<EventRow[]>
      }
    }
  }
}

const listEl = document.getElementById('list')
const dateEl = document.getElementById('date')
const prevButton = document.getElementById('prev')
const nextButton = document.getElementById('next')
const todayButton = document.getElementById('today')
const refreshButton = document.getElementById('refresh')
const liveBadge = document.getElementById('live')

let day = startOfDay(Date.now())
let rendering = false
let pollTimer: ReturnType<typeof setInterval> | null = null
let lastRenderedSignature = ''

function state(text: string): HTMLElement {
  const p = document.createElement('p')
  p.className = 'state'
  p.textContent = text
  return p
}

function computeSignature(rows: EventRow[]): string {
  if (rows.length === 0) return 'empty'
  const first = rows[0]
  const last = rows[rows.length - 1]
  return `${rows.length}-${first.id}-${last.id}-${last.ts}`
}

function renderRows(rows: EventRow[]): void {
  listEl?.replaceChildren()
  if (rows.length === 0) {
    listEl?.append(state('这一天还没有记录'))
    return
  }
  for (const group of groupByDay(rows)) {
    const heading = document.createElement('h2')
    heading.textContent = group.date
    listEl?.append(heading)

    const ul = document.createElement('ul')
    for (const row of group.rows) {
      const li = document.createElement('li')

      const time = document.createElement('span')
      time.className = 'time'
      time.textContent = formatTime(row.ts)

      const app = document.createElement('span')
      app.className = 'app'
      app.textContent = row.app

      const title = document.createElement('span')
      title.className = 'title'
      title.textContent = row.window_title ?? ''

      const ocr = document.createElement('span')
      ocr.className = 'ocr'
      ocr.textContent = summary(row.ocr_text)

      li.append(time, app, title, ocr)
      if (row.sensitive === 1) {
        const badge = document.createElement('span')
        badge.className = 'badge'
        badge.textContent = '敏感'
        li.append(badge)
      }
      ul.append(li)
    }
    listEl?.append(ul)
  }
}

function updateLiveState(): void {
  const isToday = day === startOfDay(Date.now())
  if (liveBadge) {
    liveBadge.style.display = isToday ? 'inline-flex' : 'none'
  }
  if (isToday) {
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        void render({ silent: true })
      }, 2000)
    }
  } else if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function render({ silent = false }: { silent?: boolean } = {}): Promise<void> {
  if (rendering) return
  rendering = true
  const { from, to } = dayRange(day)
  if (dateEl) dateEl.textContent = formatDate(day)
  updateLiveState()

  if (!silent) {
    listEl?.replaceChildren(state('加载中…'))
  }

  try {
    const rows = await window.gotcha.timeline.query(from, to)
    const signature = computeSignature(rows)
    // 静默刷新时，若内容无变化则不触碰 DOM，保持极佳性能与滚动位置
    if (silent && signature === lastRenderedSignature) {
      return
    }
    lastRenderedSignature = signature
    renderRows(rows)
  } catch (error) {
    if (!silent) {
      listEl?.replaceChildren(state(`读取失败：${String(error)}`))
    }
  } finally {
    rendering = false
  }
}

function shiftDay(delta: number): void {
  const next = new Date(day)
  next.setDate(next.getDate() + delta)
  day = startOfDay(next.getTime())
  lastRenderedSignature = ''
  void render()
}

prevButton?.addEventListener('click', () => shiftDay(-1))
nextButton?.addEventListener('click', () => shiftDay(1))
todayButton?.addEventListener('click', () => {
  day = startOfDay(Date.now())
  lastRenderedSignature = ''
  void render()
})
refreshButton?.addEventListener('click', () => {
  lastRenderedSignature = ''
  void render()
})

void render()
