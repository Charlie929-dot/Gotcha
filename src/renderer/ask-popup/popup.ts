/**
 * 浮动输入框（段二 A）
 *
 * 只做三件事：显示缩略图、收发送意图、收起 / 展开。
 * 发送后由主进程关窗并打开问记忆窗口——这里不自己跳转、也不管会话。
 */

interface AskPopupApi {
  onImage(handler: (dataUrl: string) => void): () => void
  send(question: string): Promise<boolean>
  cancel(): void
  setCollapsed(collapsed: boolean): Promise<boolean>
}

declare global {
  interface Window {
    gotchaPopup?: AskPopupApi
  }
}

const api = window.gotchaPopup
if (!api) throw new Error('浮动输入框缺少 preload')

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`浮动输入框缺少 #${id}`)
  return element as T
}

const thumb = byId<HTMLImageElement>('thumb')
const input = byId<HTMLTextAreaElement>('input')
const send = byId<HTMLButtonElement>('send')
const dismiss = byId<HTMLButtonElement>('dismiss')
const cancel = byId<HTMLButtonElement>('cancel')
const collapse = byId<HTMLButtonElement>('collapse')

let sending = false
let collapsed = false

function doSend(): void {
  if (sending) return
  sending = true
  send.disabled = true
  // 空串交给主进程换成默认问句（「这张截图里是什么？」）
  void api
    ?.send(input.value)
    .catch(() => false)
    .finally(() => {
      sending = false
      send.disabled = false
    })
}

function toggleCollapsed(next = !collapsed): void {
  collapsed = next
  document.body.classList.toggle('collapsed', collapsed)
  collapse.title = collapsed ? '展开' : '收起'
  void api?.setCollapsed(collapsed)
}

send.addEventListener('click', doSend)
dismiss.addEventListener('click', () => api?.cancel())
cancel.addEventListener('click', () => api?.cancel())
collapse.addEventListener('click', () => toggleCollapsed())

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    doSend()
  }
})

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api?.cancel()
})

api.onImage((dataUrl) => {
  thumb.src = dataUrl
})

input.focus()

export {}
