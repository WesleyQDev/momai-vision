import { describe, expect, it, vi, beforeEach } from 'vitest'

const postMock = vi.hoisted(() => vi.fn())

vi.mock('momai:sdk', () => ({
  getSDK: () => ({ api: { post: postMock } })
}))

import { captureWidgetFrame } from './services/visionWidgets'

beforeEach(() => {
  postMock.mockReset()
})

describe('captureWidgetFrame response mapping', () => {
  it('reads the frame from the structured response payload', async () => {
    postMock.mockResolvedValue({
      data: {
        ok: true,
        cameraId: 'cam-1',
        cameraName: 'USB2.0 PC CAMERA',
        structuredResponse: {
          type: 'vision_alert',
          data: {
            cameraId: 'cam-1',
            cameraName: 'USB2.0 PC CAMERA',
            imageDataUri: 'data:image/jpeg;base64,AAA'
          }
        }
      }
    })

    const frame = await captureWidgetFrame('cam-1')
    expect(frame.image).toBe('data:image/jpeg;base64,AAA')
    expect(frame.cameraName).toBe('USB2.0 PC CAMERA')
  })

  it('keeps supporting a top-level image field', async () => {
    postMock.mockResolvedValue({
      data: { ok: true, cameraName: 'Cam', imageDataUri: 'data:image/png;base64,BBB' }
    })

    const frame = await captureWidgetFrame('cam-1')
    expect(frame.image).toBe('data:image/png;base64,BBB')
  })

  it('surfaces backend failures instead of an empty frame', async () => {
    postMock.mockResolvedValue({ data: { ok: false, error: 'no frame available' } })

    await expect(captureWidgetFrame('cam-1')).rejects.toThrow('no frame available')
  })

  it('resolves empty when the backend has no image yet', async () => {
    postMock.mockResolvedValue({ data: { ok: true, cameraName: 'Cam' } })

    const frame = await captureWidgetFrame('cam-1')
    expect(frame.image).toBe('')
    expect(frame.cameraName).toBe('Cam')
  })
})
