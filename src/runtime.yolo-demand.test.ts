import { describe, expect, it } from 'vitest'
import { BOXES_LIVE_TTL_MS, computeYoloDemand, resetShowBoxesToHidden } from './runtime'

describe('computeYoloDemand — YOLO on demand', () => {
  it('stays off without monitors and without boxes', () => {
    expect(computeYoloDemand(false, false, undefined, 1000)).toBe(false)
  })

  it('stays on with an object/presence/absence monitor even when boxes are hidden', () => {
    expect(computeYoloDemand(true, false, undefined, 1000)).toBe(true)
  })

  it('does not treat boxes flag alone as demand without a live pump', () => {
    expect(computeYoloDemand(false, true, undefined, 1000)).toBe(false)
  })

  it('turns on when boxes are visible and the pump was seen recently', () => {
    expect(computeYoloDemand(false, true, 1000, 1000 + BOXES_LIVE_TTL_MS - 1)).toBe(true)
  })

  it('turns off when the pump heartbeat expired', () => {
    expect(computeYoloDemand(false, true, 1000, 1000 + BOXES_LIVE_TTL_MS + 1)).toBe(false)
  })
})

describe('resetShowBoxesToHidden — boxes off on startup', () => {
  it('writes explicit false for every known camera', () => {
    expect(resetShowBoxesToHidden({}, ['a', 'b'])).toEqual({ a: false, b: false })
  })

  it('turns forgotten-on boxes off while keeping unrelated keys', () => {
    expect(resetShowBoxesToHidden({ a: true } as Record<string, boolean>, ['a', 'b'])).toEqual({
      a: false,
      b: false
    })
  })

  it('keeps an already clean state clean', () => {
    expect(resetShowBoxesToHidden({ a: false }, ['a'])).toEqual({ a: false })
  })
})
