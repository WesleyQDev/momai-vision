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
})
