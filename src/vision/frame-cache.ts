/**
 * Last-frame cache for camera cards.
 *
 * Camera cards unmount on tab switch and on app restart, losing the preview
 * until the live stream reconnects. Persisting the last JPEG lets the card
 * show the previous frame immediately; the card keeps the reload spinner
 * until a live frame arrives.
 *
 * Storage is best-effort: a missing or full localStorage never breaks the
 * preview pipeline.
 */

const KEY_PREFIX = 'momai-vision:lastframe:'

/** Minimum interval between captured frames per camera (the encoder is not cheap). */
export const FRAME_CACHE_THROTTLE_MS = 5000

const lastCaptureAt = new Map<string, number>()

export function frameCacheKey(cameraId: string): string {
  return `${KEY_PREFIX}${cameraId}`
}

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

export function readCachedFrame(cameraId: string): string | null {
  const store = storage()
  if (!store) return null
  try {
    const value = store.getItem(frameCacheKey(cameraId))
    return value && value.startsWith('data:image/') ? value : null
  } catch {
    return null
  }
}

export function clearCachedFrame(cameraId: string): void {
  const store = storage()
  if (!store) return
  try {
    store.removeItem(frameCacheKey(cameraId))
  } catch {
    // best-effort cache
  }
}

/**
 * Marks the capture window for a camera and reports whether this frame should
 * be encoded. Returns true at most once per FRAME_CACHE_THROTTLE_MS.
 */
export function shouldCaptureFrameCache(cameraId: string, now = Date.now()): boolean {
  const last = lastCaptureAt.get(cameraId) || 0
  if (now - last < FRAME_CACHE_THROTTLE_MS) return false
  lastCaptureAt.set(cameraId, now)
  return true
}

export function storeCachedFrame(cameraId: string, dataUrl: string | null): void {
  if (!dataUrl) return
  const store = storage()
  if (!store) return
  try {
    store.setItem(frameCacheKey(cameraId), dataUrl)
  } catch {
    // Quota or private mode: drop the stale entry so a future capture can
    // start clean instead of keeping a growing value around.
    clearCachedFrame(cameraId)
  }
}

/** Test seam: clears the per-camera capture windows. */
export function resetFrameCacheThrottle(): void {
  lastCaptureAt.clear()
}
