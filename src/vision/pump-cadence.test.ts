import { describe, expect, it } from 'vitest'
import {
  PUMP_FAST_ROUND_TRIP_MS,
  PUMP_INTERVAL_STEP_MS,
  PUMP_MAX_INTERVAL_MS,
  PUMP_MIN_INTERVAL_MS,
  PUMP_SLOW_ROUND_TRIP_MS,
  nextPumpIntervalMs
} from './pump-cadence'

describe('detection pump cadence (adapts to engine load)', () => {
  it('backs off when the inference round-trip is slow', () => {
    expect(nextPumpIntervalMs(PUMP_MIN_INTERVAL_MS, PUMP_SLOW_ROUND_TRIP_MS + 1)).toBe(
      PUMP_MIN_INTERVAL_MS + PUMP_INTERVAL_STEP_MS
    )
    // Never slower than the cap, even under sustained load.
    expect(nextPumpIntervalMs(PUMP_MAX_INTERVAL_MS, 5_000)).toBe(PUMP_MAX_INTERVAL_MS)
  })

  it('speeds back up when the engine is free again', () => {
    expect(nextPumpIntervalMs(PUMP_MAX_INTERVAL_MS, PUMP_FAST_ROUND_TRIP_MS - 1)).toBe(
      PUMP_MAX_INTERVAL_MS - PUMP_INTERVAL_STEP_MS
    )
    // Never faster than the base cadence.
    expect(nextPumpIntervalMs(PUMP_MIN_INTERVAL_MS, 10)).toBe(PUMP_MIN_INTERVAL_MS)
  })

  it('keeps the current cadence while the engine is mid-range', () => {
    const current = PUMP_MIN_INTERVAL_MS + PUMP_INTERVAL_STEP_MS
    expect(nextPumpIntervalMs(current, PUMP_FAST_ROUND_TRIP_MS)).toBe(current)
    expect(nextPumpIntervalMs(current, PUMP_SLOW_ROUND_TRIP_MS)).toBe(current)
  })

  it('clamps unexpected values into the supported range', () => {
    expect(nextPumpIntervalMs(Number.NaN, Number.NaN)).toBe(PUMP_MIN_INTERVAL_MS)
    expect(nextPumpIntervalMs(-100, 0)).toBeGreaterThanOrEqual(PUMP_MIN_INTERVAL_MS)
    expect(nextPumpIntervalMs(99_999, 0)).toBeLessThanOrEqual(PUMP_MAX_INTERVAL_MS)
  })
})
