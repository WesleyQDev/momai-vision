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

export function cleanCameraKey(cameraId: string): string {
  if (!cameraId) return ''
  return cameraId.replace(/:\/\/[^@]+@/, '://')
}

export function frameCacheKey(cameraId: string): string {
  const clean = cleanCameraKey(cameraId)
  return `${KEY_PREFIX}${clean}`
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
    const cleanKey = frameCacheKey(cameraId)
    const rawKey = `${KEY_PREFIX}${cameraId}`
    const value = store.getItem(cleanKey) || (cleanKey !== rawKey ? store.getItem(rawKey) : null)
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
    store.removeItem(`${KEY_PREFIX}${cameraId}`)
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

export function isCanvasBlank(canvas: HTMLCanvasElement): boolean {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return true
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return true

    // An untouched HTML5 canvas is 100% transparent (alpha === 0 everywhere).
    // Any real video frame or image drawn has opaque pixels (alpha === 255),
    // even in dark rooms, night mode or black backgrounds.
    const cx = Math.floor(Math.max(0, canvas.width / 2 - 8))
    const cy = Math.floor(Math.max(0, canvas.height / 2 - 8))
    const centerData = ctx.getImageData(cx, cy, Math.min(16, canvas.width - cx), Math.min(16, canvas.height - cy)).data
    for (let i = 3; i < centerData.length; i += 4) {
      if (centerData[i] > 0) return false
    }

    const cornerData = ctx.getImageData(0, 0, Math.min(16, canvas.width), Math.min(16, canvas.height)).data
    for (let i = 3; i < cornerData.length; i += 4) {
      if (cornerData[i] > 0) return false
    }

    return true
  } catch {
    return false
  }
}

export function captureOptimizedSnapshot(
  canvas: HTMLCanvasElement | null,
  maxDim = 800,
  quality = 0.75
): string | null {
  if (!canvas || canvas.width <= 0 || canvas.height <= 0) return null
  try {
    const scale = Math.min(1, maxDim / Math.max(canvas.width, canvas.height))
    const w = Math.max(1, Math.round(canvas.width * scale))
    const h = Math.max(1, Math.round(canvas.height * scale))
    const scaled = document.createElement('canvas')
    scaled.width = w
    scaled.height = h
    const ctx = scaled.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(canvas, 0, 0, w, h)
    const dataUrl = scaled.toDataURL('image/jpeg', quality)
    return dataUrl && dataUrl.startsWith('data:image/jpeg') ? dataUrl : null
  } catch {
    return null
  }
}

export function storeCachedFrame(cameraId: string, dataUrl: string | null): void {
  if (!dataUrl) return
  const store = storage()
  if (!store) return
  const key = frameCacheKey(cameraId)
  const rawKey = `${KEY_PREFIX}${cameraId}`
  try {
    store.setItem(key, dataUrl)
    if (key !== rawKey) {
      try { store.setItem(rawKey, dataUrl) } catch {}
    }
  } catch {
    // Se estourar quota, tenta liberar chaves antigas de outras câmeras antes de desistir
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i)
        if (k && k.startsWith(KEY_PREFIX) && k !== key && k !== rawKey) {
          store.removeItem(k)
          break
        }
      }
      store.setItem(key, dataUrl)
      if (key !== rawKey) {
        try { store.setItem(rawKey, dataUrl) } catch {}
      }
    } catch {
      // Falha silenciosa sem apagar o frame atual
    }
  }
}

/** Test seam: clears the per-camera capture windows. */
export function resetFrameCacheThrottle(): void {
  lastCaptureAt.clear()
}
