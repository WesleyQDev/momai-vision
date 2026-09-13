import { describe, expect, it } from 'vitest'
import { extractRtspHost, shouldHardResetFrozen } from './freeze-recovery'

describe('freeze recovery policy', () => {
  it('escalates to hard reset after repeated light restarts without frames', () => {
    const now = Date.now()
    expect(
      shouldHardResetFrozen({
        lastFrameTs: now - 45_000,
        lightAttempts: 2,
        lastHardResetTs: 0,
        now
      })
    ).toBe(true)
  })

  it('does not hard reset when frames are flowing', () => {
    const now = Date.now()
    expect(
      shouldHardResetFrozen({ lastFrameTs: now - 2_000, lightAttempts: 5, lastHardResetTs: 0, now })
    ).toBe(false)
  })

  it('rate-limits hard resets per camera', () => {
    const now = Date.now()
    expect(
      shouldHardResetFrozen({
        lastFrameTs: now - 60_000,
        lightAttempts: 5,
        lastHardResetTs: now - 30_000,
        now
      })
    ).toBe(false)
  })

  it('extracts the RTSP host for a scoped ffmpeg kill', () => {
    expect(extractRtspHost('rtsp://admin:pass@192.168.0.2:554/onvif2')).toBe('192.168.0.2')
    expect(extractRtspHost('ip:rtsp://admin@10.0.0.9:554/live')).toBe('10.0.0.9')
    expect(extractRtspHost('')).toBe('')
  })
})
