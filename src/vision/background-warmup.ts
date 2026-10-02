/**
 * Background warmup policy — pure, testable (no I/O).
 *
 * Middle ground between a cold start and a full background stream: while the
 * Vision page is pre-mounted hidden, each visible card fetches a single frame
 * on a slow interval instead of opening the continuous MJPEG reader. The
 * backend stream stays warm and the last-frame cache stays fresh, so opening
 * the tab shows a recent image instantly and the live preview takes over.
 * No detection pump runs in background; monitors already cover that path.
 */

/** Foreground list poll keeps cards and monitors fresh. */
export const FOREGROUND_POLL_INTERVAL_MS = 5000

/** Background list poll only keeps online status warm. */
export const BACKGROUND_POLL_INTERVAL_MS = 15000

/** One snapshot per card in background — cheap enough for several cameras. */
export const BACKGROUND_WARMUP_INTERVAL_MS = 8000

export function pollIntervalMs(isActive: boolean): number {
  return isActive ? FOREGROUND_POLL_INTERVAL_MS : BACKGROUND_POLL_INTERVAL_MS
}

interface WarmupState {
  isActive: boolean
  isPaused: boolean
  hidden: boolean
}

export function shouldRunBackgroundWarmup(state: WarmupState): boolean {
  if (state.isActive) return false
  if (state.isPaused) return false
  if (state.hidden) return false
  return true
}

function hashCode(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

export function warmupStaggerMs(cameraId: string, intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0
  return hashCode(cameraId) % Math.round(intervalMs)
}

export function toCacheDataUrl(jpegBase64: string | null | undefined): string | null {
  if (!jpegBase64) return null
  if (jpegBase64.startsWith('data:image/')) return jpegBase64
  return `data:image/jpeg;base64,${jpegBase64}`
}
