import { describe, expect, it, vi, beforeEach } from 'vitest'

const postMock = vi.hoisted(() => vi.fn())

vi.mock('momai:sdk', () => ({
  getSDK: () => ({ api: { post: postMock } })
}))

import {
  buildWidgetStreamUrl,
  fetchWidgetCameraName,
  fetchWidgetFrame
} from './services/widgetStream'

beforeEach(() => {
  postMock.mockReset()
})

describe('buildWidgetStreamUrl', () => {
  it('builds the same stream URL the tab uses', () => {
    const url = buildWidgetStreamUrl('webcam:0', 'abc')
    expect(url).toContain('/media/camera/stream/0')
    expect(url).toContain('ext=momai-vision')
    expect(url).toContain('r=abc')
  })

  it('keeps IP camera ids untouched and rejects empty ids', () => {
    expect(buildWidgetStreamUrl('ip:http://1.2.3.4/video', 1)).toContain(
      encodeURIComponent('ip:http://1.2.3.4/video')
    )
    expect(buildWidgetStreamUrl('', 1)).toBeNull()
  })
})

describe('fetchWidgetCameraName', () => {
  it('resolves the display name from list_cameras', async () => {
    postMock.mockResolvedValue({
      data: { cameras: [{ id: 'cam-1', name: 'USB2.0 PC CAMERA' }] }
    })
    await expect(fetchWidgetCameraName('cam-1')).resolves.toBe('USB2.0 PC CAMERA')
    expect(postMock).toHaveBeenCalledWith(
      '/extensions/momai-vision/command',
      { toolName: 'list_cameras', args: {} }
    )
  })

  it('falls back to the id when unknown', async () => {
    postMock.mockResolvedValue({ data: { cameras: [] } })
    await expect(fetchWidgetCameraName('cam-9')).resolves.toBe('cam-9')
  })
})

describe('fetchWidgetFrame', () => {
  it('maps the latest frame to a data URI', async () => {
    postMock.mockResolvedValue({ data: { ok: true, jpegBase64: 'AAA' } })
    await expect(fetchWidgetFrame('cam-1')).resolves.toEqual({
      image: 'data:image/jpeg;base64,AAA'
    })
  })

  it('throws backend failures so the widget shows the reason', async () => {
    postMock.mockResolvedValue({ data: { ok: false, error: 'camera paused' } })
    await expect(fetchWidgetFrame('cam-1')).rejects.toThrow('camera paused')
  })
})
