/**
 * 球专用 preload（m1b-plan §3 Phase 2 / §4.9 权限面分离）
 *
 * 只暴露球需要的通道：状态订阅 / 状态查询 / 停靠信息 / 指针进出 / 交互状态 /
 * 兜底缩回订阅 / 拖动 / 打开时间线 / 右键菜单。时间线 preload 不追加采集开关 API，
 * 球 preload 也不暴露时间线查询。
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

export type BallCaptureStatus = 'paused' | 'starting' | 'running' | 'stopping'

export type BallEdge = 'left' | 'right' | 'top' | 'bottom'

/** 与 renderer 的 `ball-interaction.ts` 状态一一对应（D16） */
export type BallInteractionState = 'idle' | 'expanded' | 'grace' | 'dragging'

/** 球上角标（与 main/ball.ts 的 BallNotice 同构） */
export type BallNotice =
  | { kind: 'countdown'; seconds: number }
  | { kind: 'error'; text: string }
  | { kind: 'hotkey-unavailable'; text: string }

export interface BallPlacement {
  docked: boolean
  edge: BallEdge | null
}

export interface BallScreenPoint {
  screenX: number
  screenY: number
}

export interface BallDragEndPayload extends BallScreenPoint {
  moved: boolean
}

export interface BallApi {
  getStatus(): Promise<BallCaptureStatus>
  onStatus(callback: (status: BallCaptureStatus) => void): () => void
  onPlacement(callback: (placement: BallPlacement) => void): () => void
  onForceRetract(callback: () => void): () => void
  onNotice(callback: (notice: BallNotice | null) => void): () => void
  setPointerInside(inside: boolean): void
  setInteractionState(state: BallInteractionState): void
  dragStart(point: BallScreenPoint): void
  dragMove(point: BallScreenPoint): void
  dragEnd(payload: BallDragEndPayload): void
  openTimeline(): void
  openContextMenu(): void
}

const api: BallApi = {
  getStatus: () => ipcRenderer.invoke('ball:current-status') as Promise<BallCaptureStatus>,
  onStatus(callback) {
    const listener = (_event: IpcRendererEvent, status: BallCaptureStatus): void => {
      callback(status)
    }
    ipcRenderer.on('ball:status', listener)
    return () => {
      ipcRenderer.removeListener('ball:status', listener)
    }
  },
  onPlacement(callback) {
    const listener = (_event: IpcRendererEvent, placement: BallPlacement): void => {
      callback(placement)
    }
    ipcRenderer.on('ball:placement', listener)
    return () => {
      ipcRenderer.removeListener('ball:placement', listener)
    }
  },
  onForceRetract(callback) {
    const listener = (): void => {
      callback()
    }
    ipcRenderer.on('ball:force-retract', listener)
    return () => {
      ipcRenderer.removeListener('ball:force-retract', listener)
    }
  },
  onNotice(callback) {
    const listener = (_event: IpcRendererEvent, notice: BallNotice | null): void => {
      callback(notice)
    }
    ipcRenderer.on('ball:notice', listener)
    return () => {
      ipcRenderer.removeListener('ball:notice', listener)
    }
  },
  setPointerInside: (inside) => ipcRenderer.send('ball:pointer-inside', inside === true),
  setInteractionState: (state) => ipcRenderer.send('ball:interaction-state', state),
  dragStart: (point) => ipcRenderer.send('ball:drag-start', point),
  dragMove: (point) => ipcRenderer.send('ball:drag-move', point),
  dragEnd: (payload) => ipcRenderer.send('ball:drag-end', payload),
  openTimeline: () => ipcRenderer.send('ball:open-timeline'),
  openContextMenu: () => ipcRenderer.send('ball:context-menu')
}

contextBridge.exposeInMainWorld('gotchaBall', api)
