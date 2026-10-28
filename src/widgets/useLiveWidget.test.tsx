// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const postMock = vi.hoisted(() => vi.fn())
const fetchMock = vi.hoisted(() => vi.fn())

vi.mock('momai:sdk', () => ({
  getSDK: () => ({ api: { post: postMock } })
}))

import VisionLiveWidget from './live'

let container: HTMLDivElement
let root: Root
const drawImage = vi.fn()
let originalGetContext: unknown

function multipartBody(): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const head = encoder.encode('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n')
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
  const tail = encoder.encode('\r\n')
  const all = new Uint8Array(head.length + jpeg.length + tail.length)
  all.set(head)
  all.set(jpeg, head.length)
  all.set(tail, head.length + jpeg.length)
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(all)
      controller.close()
    }
  })
}

class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  naturalWidth = 320
  naturalHeight = 240
  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

function mockPost(toolName: string, payload: unknown) {
  if (toolName === 'list_cameras') {
    return { data: { cameras: [{ id: 'cam-1', name: 'USB2.0 PC CAMERA' }] } }
  }
  if (toolName === 'get_frame') {
    return { data: { ok: true, jpegBase64: 'AAA' } }
  }
  return payload
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  drawImage.mockClear()
  postMock.mockReset()
  postMock.mockImplementation((_path: string, body: any) => Promise.resolve(mockPost(body?.toolName, body)))
  fetchMock.mockReset()
  originalGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage })) as any
  vi.stubGlobal('createImageBitmap', async () => ({ width: 320, height: 240, close: () => {} }))
  vi.stubGlobal('Image', FakeImage)
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  HTMLCanvasElement.prototype.getContext = originalGetContext as any
  vi.unstubAllGlobals()
})

async function renderWidget() {
  await act(async () => {
    root.render(<VisionLiveWidget config={{ cameraId: 'cam-1' }} />)
    await new Promise((resolve) => setTimeout(resolve, 150))
  })
}

describe('VisionLiveWidget live stream', () => {
  it('draws stream frames on canvas with the camera name', async () => {
    fetchMock.mockResolvedValue({ ok: true, body: multipartBody() })
    await renderWidget()
    expect(drawImage).toHaveBeenCalled()
    expect(container.textContent).toContain('USB2.0 PC CAMERA')
  })

  it('falls back to frame polling when the stream fails', async () => {
    fetchMock.mockRejectedValue(new Error('stream down'))
    await renderWidget()
    expect(drawImage).toHaveBeenCalled()
    expect(container.textContent).not.toContain('stream down')
  })

  it('shows backend errors with a retry action', async () => {
    postMock.mockImplementation((_path: string, body: any) => {
      if (body?.toolName === 'list_cameras') {
        return Promise.resolve({ data: { cameras: [{ id: 'cam-1', name: 'Cam' }] } })
      }
      return Promise.resolve({ data: { ok: false, error: 'camera paused' } })
    })
    await renderWidget()
    expect(container.textContent).toContain('camera paused')
  })

  it('dispatches navigation and expand event on double click', async () => {
    fetchMock.mockResolvedValue({ ok: true, body: multipartBody() })
    await renderWidget()

    const navListener = vi.fn()
    const expandListener = vi.fn()
    window.addEventListener('momai_navigate', navListener)
    window.addEventListener('momai-vision:expand-camera', expandListener)

    const widgetDiv = container.firstElementChild as HTMLElement
    await act(async () => {
      widgetDiv.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    expect(localStorage.getItem('momai-vision:auto-expand')).toBe('cam-1')
    expect(navListener).toHaveBeenCalled()
    expect(expandListener).toHaveBeenCalled()

    window.removeEventListener('momai_navigate', navListener)
    window.removeEventListener('momai-vision:expand-camera', expandListener)
  })

  it('does not navigate on single click', async () => {
    fetchMock.mockResolvedValue({ ok: true, body: multipartBody() })
    await renderWidget()

    const navListener = vi.fn()
    window.addEventListener('momai_navigate', navListener)

    const widgetDiv = container.firstElementChild as HTMLElement
    await act(async () => {
      widgetDiv.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(navListener).not.toHaveBeenCalled()
    window.removeEventListener('momai_navigate', navListener)
  })
  it('updates camera name immediately when momai-vision:cameras-updated is dispatched', async () => {
    fetchMock.mockResolvedValue({ ok: true, body: multipartBody() })
    await renderWidget()

    expect(container.textContent).toContain('USB2.0 PC CAMERA')

    // Dispatches rename event
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('momai-vision:cameras-updated', {
          detail: { cameraId: 'cam-1', name: 'Portão de Entrada' }
        })
      )
    })

    expect(container.textContent).toContain('Portão de Entrada')
  })

  it('renders no active camera state when cameraId is empty and navigates on activate click', async () => {
    const navListener = vi.fn()
    const openAddListener = vi.fn()
    window.addEventListener('momai_navigate', navListener)
    window.addEventListener('momai-vision:open-add-camera', openAddListener)

    postMock.mockImplementation((_path: string, body: any) => {
      if (body?.toolName === 'list_cameras') {
        return Promise.resolve({ data: { cameras: [] } })
      }
      return Promise.resolve(mockPost(body?.toolName, body))
    })

    await act(async () => {
      root.render(<VisionLiveWidget config={{ cameraId: '' }} />)
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    expect(container.textContent).toContain('Não possui nenhuma câmera ativa')
    expect(container.textContent).toContain('Deseja ativar uma câmera agora?')
    expect(container.textContent).toContain('Ativar câmera')
    expect(container.textContent).not.toContain('Tentar de novo')

    const activateBtn = container.querySelector('button') as HTMLButtonElement
    expect(activateBtn).toBeTruthy()
    await act(async () => {
      activateBtn.click()
    })

    expect(navListener).toHaveBeenCalled()
    expect(openAddListener).toHaveBeenCalled()
    expect(localStorage.getItem('momai-vision:auto-add-camera')).toBe('webcam')

    window.removeEventListener('momai_navigate', navListener)
    window.removeEventListener('momai-vision:open-add-camera', openAddListener)
  })

  it('renders no active camera state when configured camera is unknown and targets ip tab', async () => {
    postMock.mockImplementation((_path: string, body: any) => {
      if (body?.toolName === 'list_cameras') {
        return Promise.resolve({ data: { cameras: [] } })
      }
      return Promise.resolve({ data: { ok: false, error: 'unknown camera: ip:rtsp://192.168.0.4:554/onvif1' } })
    })

    const navListener = vi.fn()
    const openAddListener = vi.fn()
    window.addEventListener('momai_navigate', navListener)
    window.addEventListener('momai-vision:open-add-camera', openAddListener)

    await act(async () => {
      root.render(<VisionLiveWidget config={{ cameraId: 'ip:rtsp://192.168.0.4:554/onvif1' }} />)
      await new Promise((resolve) => setTimeout(resolve, 150))
    })

    expect(container.textContent).toContain('Não possui nenhuma câmera ativa')
    expect(container.textContent).toContain('Deseja ativar uma câmera agora?')
    expect(container.textContent).toContain('Ativar câmera')
    expect(container.textContent).not.toContain('Tentar de novo')

    const buttons = container.querySelectorAll('button')
    const activateBtn = Array.from(buttons).find((b) => b.textContent?.includes('Ativar câmera'))
    expect(activateBtn).toBeTruthy()

    await act(async () => {
      activateBtn!.click()
    })

    expect(navListener).toHaveBeenCalled()
    expect(openAddListener).toHaveBeenCalled()
    expect(localStorage.getItem('momai-vision:auto-add-camera')).toBe('ip')

    window.removeEventListener('momai_navigate', navListener)
    window.removeEventListener('momai-vision:open-add-camera', openAddListener)
  })
})
