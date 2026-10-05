import { describe, expect, it } from 'vitest'
import { buildAuthenticatedUrl, parseCameraAuth, redactCameraUrl } from './rtsp-auth'

describe('rtsp-auth helpers', () => {
  it('parses unauthenticated URLs', () => {
    const res = parseCameraAuth('rtsp://192.168.0.4:554/onvif1')
    expect(res.username).toBe('')
    expect(res.password).toBe('')
    expect(res.cleanUrl).toBe('rtsp://192.168.0.4:554/onvif1')
  })

  it('parses authenticated URLs with special characters in password', () => {
    const res = parseCameraAuth('rtsp://admin:Aa91650039%23@192.168.0.4:554/onvif1')
    expect(res.username).toBe('admin')
    expect(res.password).toBe('Aa91650039#')
    expect(res.cleanUrl).toBe('rtsp://192.168.0.4:554/onvif1')
  })

  it('builds authenticated URL properly encoding special characters', () => {
    const built = buildAuthenticatedUrl('rtsp://192.168.0.4:554/onvif1', 'admin', 'Aa91650039#')
    expect(built).toBe('rtsp://admin:Aa91650039%23@192.168.0.4:554/onvif1')
  })

  it('replaces credentials when rebuilding an already authenticated URL', () => {
    const built = buildAuthenticatedUrl('rtsp://olduser:oldpass@192.168.0.4:554/onvif1', 'newuser', 'newpass123')
    expect(built).toBe('rtsp://newuser:newpass123@192.168.0.4:554/onvif1')
  })

  it('preserves credentials if username and password are empty strings', () => {
    const built = buildAuthenticatedUrl('rtsp://admin:pass@192.168.0.4:554/onvif1', '', '')
    expect(built).toBe('rtsp://admin:pass@192.168.0.4:554/onvif1')
    expect(parseCameraAuth('rtsp://admin:pass@192.168.0.4:554/onvif1').cleanUrl).toBe('rtsp://192.168.0.4:554/onvif1')
  })

  it('defaults to admin if username is empty but password is provided', () => {
    const built = buildAuthenticatedUrl('rtsp://192.168.0.4:554/onvif1', '', 'Aa91650039#')
    expect(built).toBe('rtsp://admin:Aa91650039%23@192.168.0.4:554/onvif1')
  })

  it('redacts credentials from URLs and camera IDs safely', () => {
    expect(redactCameraUrl('rtsp://admin:secret123@192.168.0.4:554/live')).toBe('rtsp://***@192.168.0.4:554/live')
    expect(redactCameraUrl('ip:rtsp://admin:pass@10.0.0.5/ch0')).toBe('ip:rtsp://***@10.0.0.5/ch0')
    expect(redactCameraUrl('rtsp://192.168.0.4:554/live')).toBe('rtsp://192.168.0.4:554/live')
    expect(redactCameraUrl('webcam:device-123')).toBe('webcam:device-123')
    expect(redactCameraUrl('')).toBe('')
  })
})



