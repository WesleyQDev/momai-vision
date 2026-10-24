import { describe, expect, it, vi, beforeEach } from 'vitest'

const postMock = vi.hoisted(() => vi.fn())

vi.mock('momai:sdk', () => ({
  getSDK: () => ({ api: { post: postMock } })
}))

import { captureWidgetFrame } from './services/visionWidgets'

function mockCommands(responses: Record<string, unknown>): void {
  postMock.mockImplementation((_url: string, body: { toolName?: string }) => {
    return Promise.resolve({ data: responses[String(body?.toolName || '')] })
  })
}

beforeEach(() => {
  postMock.mockReset()
})

describe('captureWidgetFrame response mapping', () => {
  it('reads the frame from get_frame and resolves the camera name', async () => {
    mockCommands({
      get_frame: { ok: true, jpegBase64: 'AAA' },
      list_cameras: { ok: true, cameras: [{ id: 'cam-1', name: 'USB2.0 PC CAMERA' }] }
    })

    const frame = await captureWidgetFrame('cam-1')
    expect(frame.image).toBe('data:image/jpeg;base64,AAA')
    expect(frame.cameraName).toBe('USB2.0 PC CAMERA')
  })

  it('falls back to the camera id when the camera list is unavailable', async () => {
    mockCommands({ get_frame: { ok: true, jpegBase64: 'BBB' } })

    const frame = await captureWidgetFrame('cam-1')
    expect(frame.image).toBe('data:image/jpeg;base64,BBB')
    expect(frame.cameraName).toBe('cam-1')
  })

  it('surfaces backend failures instead of an empty frame', async () => {
    mockCommands({ get_frame: { ok: false, error: 'no frame available' } })

    await expect(captureWidgetFrame('cam-1')).rejects.toThrow('no frame available')
  })

  it('resolves empty when the backend has no image yet', async () => {
    mockCommands({ get_frame: { ok: true } })

    const frame = await captureWidgetFrame('cam-1')
    expect(frame.image).toBe('')
    expect(frame.cameraName).toBe('cam-1')
  })
})
