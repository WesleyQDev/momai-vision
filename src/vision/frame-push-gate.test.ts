import { describe, expect, it } from 'vitest'
import {
  ACTIVE_PUSH_MIN_INTERVAL_MS,
  IDLE_PUSH_INTERVAL_MS,
  framePushIntervalMs,
  shouldPushFrame
} from './frame-push-gate'

describe('frame push gate (subscriber-aware cadence)', () => {
  it('pushes while the subscriber count is unknown so the response can teach it', () => {
    expect(shouldPushFrame({ lastPushAt: 0, now: 1_000, subscribers: null })).toBe(true)
    expect(shouldPushFrame({ lastPushAt: 1_000, now: 1_001, subscribers: null })).toBe(true)
    expect(framePushIntervalMs(null)).toBe(0)
  })

  it('drops to a heartbeat when nobody is subscribed', () => {
    const opts = { subscribers: 0 }
    expect(shouldPushFrame({ ...opts, lastPushAt: 0, now: 1_000 })).toBe(true)
    expect(shouldPushFrame({ ...opts, lastPushAt: 1_000, now: 1_200 })).toBe(false)
    expect(
      shouldPushFrame({ ...opts, lastPushAt: 1_000, now: 1_000 + IDLE_PUSH_INTERVAL_MS })
    ).toBe(true)
  })

  it('caps the push rate when a preview is subscribed', () => {
    const opts = { subscribers: 1 }
    expect(shouldPushFrame({ ...opts, lastPushAt: 0, now: 1_000 })).toBe(true)
    expect(shouldPushFrame({ ...opts, lastPushAt: 1_000, now: 1_000 + 10 })).toBe(false)
    expect(
      shouldPushFrame({ ...opts, lastPushAt: 1_000, now: 1_000 + ACTIVE_PUSH_MIN_INTERVAL_MS })
    ).toBe(true)
    expect(framePushIntervalMs(1)).toBe(ACTIVE_PUSH_MIN_INTERVAL_MS)
    expect(IDLE_PUSH_INTERVAL_MS).toBeGreaterThan(ACTIVE_PUSH_MIN_INTERVAL_MS)
  })
})
