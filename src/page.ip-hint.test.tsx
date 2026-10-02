import { describe, expect, it } from 'vitest'
import { cameraPlaceholderSubtitle } from './page'

const IP_CAM = { id: 'ip:rtsp://192.168.0.4:554/onvif1', name: 'Portão', source: 'ip' as const, online: false, monitors: 0 }

describe('cameraPlaceholderSubtitle (IP connection hint)', () => {
  it('explains an auth failure instead of a bare "no signal"', () => {
    expect(cameraPlaceholderSubtitle({ ...IP_CAM, lastError: 'auth' }, false, 'x', false, true)).toContain('senha')
  })

  it('explains a wrong stream path (404)', () => {
    expect(
      cameraPlaceholderSubtitle({ ...IP_CAM, lastError: 'method setup failed: 404 stream not found' }, false, 'x', false, true)
    ).toContain('404')
  })

  it('explains a network/transport failure', () => {
    expect(
      cameraPlaceholderSubtitle({ ...IP_CAM, lastError: 'connection timed out' }, false, 'x', false, true)
    ).toContain('transporte')
  })

  it('stays silent without a known cause', () => {
    expect(cameraPlaceholderSubtitle({ ...IP_CAM, lastError: '' }, false, 'x', false, true)).toBeNull()
    expect(cameraPlaceholderSubtitle({ ...IP_CAM }, false, 'x', false, true)).toBeNull()
  })

  it('never hints for webcams', () => {
    const webcam = { id: 'webcam:a', name: 'USB', source: 'webcam' as const, online: false, monitors: 0, lastError: 'auth' }
    expect(cameraPlaceholderSubtitle(webcam, false, 'x', false, true)).toBeNull()
  })
})
