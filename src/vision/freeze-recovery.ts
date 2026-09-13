/**
 * Frozen IP camera recovery policy — pure, testable helpers (no I/O).
 *
 * Light restarts (stop + start on the same user-configured transport)
 * fix most stalls. When frames never come back, escalate to a hard reset
 * that reuses the "clear cache and connections" steps scoped to one
 * camera: stop the stream, clear health state, kill only that host's
 * orphan FFmpeg, short quiet window, then reconnect.
 */

export const FROZEN_STALE_MS = 15_000
export const FROZEN_HARD_RESET_AFTER_LIGHT_ATTEMPTS = 2
export const FROZEN_HARD_RESET_MIN_MS = 120_000
export const FROZEN_HARD_COOLDOWN_MS = 6_000

export function shouldHardResetFrozen(opts: {
  lastFrameTs: number
  lightAttempts: number
  lastHardResetTs: number
  now?: number
}): boolean {
  const now = opts.now ?? Date.now()
  if (!opts.lastFrameTs || opts.lastFrameTs <= 0) return false
  if (now - opts.lastFrameTs < FROZEN_STALE_MS) return false
  if (opts.lightAttempts < FROZEN_HARD_RESET_AFTER_LIGHT_ATTEMPTS) return false
  if (opts.lastHardResetTs > 0 && now - opts.lastHardResetTs < FROZEN_HARD_RESET_MIN_MS) {
    return false
  }
  return true
}

export function extractRtspHost(rawUrl: string): string {
  if (!rawUrl) return ''
  const source = rawUrl.startsWith('ip:') ? rawUrl.slice(3) : rawUrl
  const atMatch = source.match(/@([^:/]+)/)
  if (atMatch) return atMatch[1]
  const protoMatch = source.match(/:\/\/([^:/]+)/)
  if (protoMatch) return protoMatch[1]
  return ''
}
