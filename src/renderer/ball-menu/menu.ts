/**
 * 球右键菜单（自绘）
 *
 * 只负责把主进程给的条目画成菜单、把点击换成一个 id 递回去。
 * 「点别处消失」由主进程的窗口失焦负责，这里不监听全局事件。
 * 键盘：↑ ↓ 移动，Enter 执行，Esc 关闭（菜单窗可聚焦，键盘是免费能力）。
 */

import type { BallMenuApi, BallMenuItem } from '../ball-menu-preload'

declare global {
  interface Window {
    gotchaBallMenu?: BallMenuApi
  }
}

const api = window.gotchaBallMenu
if (!api) throw new Error('球菜单缺少 preload')

const menuNode = document.getElementById('menu')
if (!menuNode) throw new Error('球菜单缺少 #menu')
const menu: HTMLElement = menuNode

let items: BallMenuItem[] = []

function buttons(): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>('button')]
}

function focusItem(index: number): void {
  const list = buttons()
  if (list.length === 0) return
  const next = (index + list.length) % list.length
  list[next]?.focus()
}

function render(next: BallMenuItem[]): void {
  items = next
  const nodes: HTMLElement[] = []
  for (const item of next) {
    if ('type' in item) {
      const line = document.createElement('div')
      line.className = 'separator'
      line.setAttribute('role', 'separator')
      nodes.push(line)
      continue
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'item'
    button.dataset.id = item.id
    button.textContent = item.label
    button.disabled = !item.enabled
    button.setAttribute('role', 'menuitem')
    button.addEventListener('click', () => {
      // 主进程会再校验一次 id / enabled；这里先禁点，避免连点执行两次
      button.disabled = true
      api?.select(item.id)
    })
    nodes.push(button)
  }
  menu.replaceChildren(...nodes)
  focusItem(0)
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault()
    api?.close()
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const list = buttons()
    const current = list.indexOf(document.activeElement as HTMLButtonElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    focusItem(current < 0 ? 0 : current + step)
    return
  }
  if (event.key === 'Enter' && document.activeElement instanceof HTMLButtonElement) {
    event.preventDefault()
    document.activeElement.click()
  }
})

// 点击菜单外的空白（透明区域不会发生，窗口尺寸就是菜单尺寸）不处理；
// 但点到菜单边框的空白处应当算"没选中"，保持菜单打开即可。
menu.addEventListener('mousedown', (event) => {
  if (event.target === menu) event.preventDefault()
})

api.onEntries(render)
void api.state().then((entries) => {
  if (items.length === 0) render(entries)
})

export {}
