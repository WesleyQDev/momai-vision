/**
 * Shared RTSP reconnect cooldown.
 *
 * "Clear cache and connections" runs inside a single worker, but the host
 * forks several runtime workers and each one keeps its own reconnect timers.
 * The cooldown is written to the shared extension storage so every worker
 * backs off for the same window — that quiet period is what lets the camera
 * drop its stuck sessions and start answering again.
 */

export const RTSP_CLEAR_COOLDOWN_MS = 60_000

const STORAGE_KEY = 'rtsp_cooldown'

export interface RtspCooldownState {
  /** Epoch ms until which no RTSP connect attempt should run. */
  until: number
  /** Camera ids covered by the cooldown; null means every camera. */
  cameras: string[] | null
}

export interface RtspCooldownStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, opts?: { ttlMs?: number }): Promise<void>
}

function parseState(raw: unknown): RtspCooldownState | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as { until?: unknown; cameras?: unknown }
  if (typeof candidate.until !== 'number' || !Number.isFinite(candidate.until)) return null
  const cameras = Array.isArray(candidate.cameras)
    ? candidate.cameras.filter((id): id is string => typeof id === 'string')
    : null
  return { until: candidate.until, cameras }
}

/**
 * Remaining cooldown for a camera; 0 when none is active. Storage failures
 * degrade to "no cooldown" so a broken store never blocks camera recovery.
 */
export async function rtspCooldownRemaining(
  storage: RtspCooldownStorage,
  cameraId: string,
  now = Date.now()
): Promise<number> {
  let state: RtspCooldownState | null = null
  try {
    state = parseState(await storage.get(STORAGE_KEY))
  } catch {
    return 0
  }
  if (!state || state.until <= now) return 0
  if (state.cameras && state.cameras.length > 0 && !state.cameras.includes(cameraId)) return 0
  return state.until - now
}

/**
 * Starts (or extends) the shared cooldown and returns the epoch ms it ends.
 * A global clear (cameraIds null) covers every camera; a second clear merges
 * with the active window instead of shortening it. Storage failures still
 * return a valid window so the clear itself never fails.
 */
export async function markRtspClearCooldown(
  storage: RtspCooldownStorage,
  cameraIds: string[] | null,
  now = Date.now()
): Promise<number> {
  let state: RtspCooldownState = { until: now + RTSP_CLEAR_COOLDOWN_MS, cameras: cameraIds }
  try {
    const current = parseState(await storage.get(STORAGE_KEY))
    if (current && current.until > now) {
      const cameras =
        current.cameras === null || cameraIds === null
          ? null
          : [...new Set([...current.cameras, ...cameraIds])]
      state = { until: Math.max(current.until, state.until), cameras }
    }
  } catch {
    // No readable state: keep the fresh window for this clear.
  }
  try {
    await storage.set(STORAGE_KEY, state, { ttlMs: state.until - now + 60_000 })
  } catch {
    // Storage failure must not fail the clear itself.
  }
  return state.until
}
