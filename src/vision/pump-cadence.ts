/**
 * Detection pump cadence policy — pure, testable (no I/O).
 *
 * The card pump fires one `frame_pump` per visible camera. When the CV
 * engine round-trip slows down (CPU shared with FFmpeg, other cameras and
 * the browser), insisting on the base cadence only piles up requests whose
 * results arrive stale. Slowing the cadence down lets each inference finish
 * and keeps the newest frame in play; when the engine frees up, the pump
 * returns to the base cadence.
 */

/** Base cadence — fast enough for live boxes on one camera. */
export const PUMP_MIN_INTERVAL_MS = 1000

/** Upper bound so the boxes never look abandoned. */
export const PUMP_MAX_INTERVAL_MS = 2500

/** Round-trip above this means the engine is contended. */
export const PUMP_SLOW_ROUND_TRIP_MS = 500

/** Round-trip below this means the engine has headroom. */
export const PUMP_FAST_ROUND_TRIP_MS = 250

/** Cadence change per cycle — smooth, no oscillation. */
export const PUMP_INTERVAL_STEP_MS = 250

export function nextPumpIntervalMs(currentMs: number, roundTripMs: number): number {
  const current = Number.isFinite(currentMs)
    ? Math.min(Math.max(Math.round(currentMs), PUMP_MIN_INTERVAL_MS), PUMP_MAX_INTERVAL_MS)
    : PUMP_MIN_INTERVAL_MS
  if (!Number.isFinite(roundTripMs)) return current
  if (roundTripMs > PUMP_SLOW_ROUND_TRIP_MS) {
    return Math.min(PUMP_MAX_INTERVAL_MS, current + PUMP_INTERVAL_STEP_MS)
  }
  if (roundTripMs < PUMP_FAST_ROUND_TRIP_MS) {
    return Math.max(PUMP_MIN_INTERVAL_MS, current - PUMP_INTERVAL_STEP_MS)
  }
  return current
}
