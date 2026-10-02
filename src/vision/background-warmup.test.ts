import { describe, expect, it } from 'vitest'
import {
  BACKGROUND_POLL_INTERVAL_MS,
  BACKGROUND_WARMUP_INTERVAL_MS,
  FOREGROUND_POLL_INTERVAL_MS,
  pollIntervalMs,
  shouldRunBackgroundWarmup,
  toCacheDataUrl,
  warmupStaggerMs
} from './background-warmup'

describe('background warmup policy (light second plane)', () => {
  it('polls slower in background than foreground', () => {
    expect(pollIntervalMs(true)).toBe(FOREGROUND_POLL_INTERVAL_MS)
    expect(pollIntervalMs(false)).toBe(BACKGROUND_POLL_INTERVAL_MS)
    expect(BACKGROUND_POLL_INTERVAL_MS).toBeGreaterThan(FOREGROUND_POLL_INTERVAL_MS)
  })

  it('runs background warmup only when hidden page is visible to the OS', () => {
    expect(shouldRunBackgroundWarmup({ isActive: true, isPaused: false, hidden: false })).toBe(false)
    expect(shouldRunBackgroundWarmup({ isActive: false, isPaused: false, hidden: false })).toBe(true)
    expect(shouldRunBackgroundWarmup({ isActive: false, isPaused: true, hidden: false })).toBe(false)
    expect(shouldRunBackgroundWarmup({ isActive: false, isPaused: false, hidden: true })).toBe(false)
  })

  it('staggers cameras deterministically inside one interval', () => {
    const a = warmupStaggerMs('ip:cam1', BACKGROUND_WARMUP_INTERVAL_MS)
    const b = warmupStaggerMs('ip:cam2', BACKGROUND_WARMUP_INTERVAL_MS)
    expect(a).toBeGreaterThanOrEqual(0)
    expect(a).toBeLessThan(BACKGROUND_WARMUP_INTERVAL_MS)
    expect(warmupStaggerMs('ip:cam1', BACKGROUND_WARMUP_INTERVAL_MS)).toBe(a)
    expect(a).not.toBe(b)
  })

  it('wraps raw worker base64 into a cacheable data url', () => {
    expect(toCacheDataUrl('AAAA')).toBe('data:image/jpeg;base64,AAAA')
    expect(toCacheDataUrl('data:image/jpeg;base64,AAAA')).toBe('data:image/jpeg;base64,AAAA')
    expect(toCacheDataUrl('')).toBeNull()
  })
})
