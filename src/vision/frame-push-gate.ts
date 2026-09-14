/**
 * Frame push gate — pure, testable cadence policy for pushing IP camera
 * frames to the host (`POST /media/camera/frame/:id`).
 *
 * The host relays pushed frames to MJPEG preview subscribers only. Pushing
 * every transcoded frame while nobody watches wastes ~1.5 MB/s per camera
 * and a POST per frame on the node-core event loop, which also serves the
 * streams (jitter → stutter). The host reports the current subscriber count
 * in the POST response, so the worker can throttle:
 *
 *   - unknown count (bootstrap): push every frame so the response teaches it
 *   - subscribers > 0: cap at the display cadence
 *   - subscribers = 0: heartbeat only, keeping the host frame cache fresh
 *     for late subscribers and one-shot GET consumers
 */

/** Minimum interval between pushes while a preview is subscribed (~15fps). */
export const ACTIVE_PUSH_MIN_INTERVAL_MS = 66

/** Heartbeat interval when nobody is subscribed. */
export const IDLE_PUSH_INTERVAL_MS = 1000

/** 0 means "no throttle" — used while the subscriber count is unknown. */
export function framePushIntervalMs(subscribers: number | null): number {
  if (subscribers === null) return 0
  if (subscribers > 0) return ACTIVE_PUSH_MIN_INTERVAL_MS
  return IDLE_PUSH_INTERVAL_MS
}

export function shouldPushFrame(opts: {
  lastPushAt: number
  now: number
  subscribers: number | null
}): boolean {
  const interval = framePushIntervalMs(opts.subscribers)
  if (interval === 0) return true
  return opts.now - opts.lastPushAt >= interval
}
