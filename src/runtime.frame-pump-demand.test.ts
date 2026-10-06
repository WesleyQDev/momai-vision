import { describe, expect, it } from 'vitest'
import { resolveFramePumpDemand } from './runtime'

describe('resolveFramePumpDemand — a frame_pump only becomes demand with a frame', () => {
  it('answers idle without boxes and without a detection monitor', () => {
    expect(
      resolveFramePumpDemand({ jpegBase64: undefined, boxesRequested: false, hasDetectionMonitor: false })
    ).toEqual({ action: 'idle' })
  })

  it('stops at no-frame while the stream has not delivered a frame yet', () => {
    expect(
      resolveFramePumpDemand({ jpegBase64: undefined, boxesRequested: true, hasDetectionMonitor: false })
    ).toEqual({ action: 'no-frame' })
    expect(
      resolveFramePumpDemand({ jpegBase64: undefined, boxesRequested: false, hasDetectionMonitor: true })
    ).toEqual({ action: 'no-frame' })
  })

  it('carries the frame when it counts as a live consumer', () => {
    expect(
      resolveFramePumpDemand({ jpegBase64: 'frame-a', boxesRequested: true, hasDetectionMonitor: false })
    ).toEqual({ action: 'active', jpegBase64: 'frame-a' })
    expect(
      resolveFramePumpDemand({ jpegBase64: 'frame-b', boxesRequested: false, hasDetectionMonitor: true })
    ).toEqual({ action: 'active', jpegBase64: 'frame-b' })
  })

  it('never reports active without a frame (boot warmup regression)', () => {
    for (const boxesRequested of [false, true]) {
      for (const hasDetectionMonitor of [false, true]) {
        const decision = resolveFramePumpDemand({
          jpegBase64: undefined,
          boxesRequested,
          hasDetectionMonitor
        })
        expect(decision.action).not.toBe('active')
      }
    }
  })
})
