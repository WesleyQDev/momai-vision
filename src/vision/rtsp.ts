/**
 * RTSP connection policy — pure, testable helpers (no I/O).
 *
 * Most consumer IP cameras only serve RTP over RTSP/TCP (interleaved), while
 * a minority require UDP. Starting with UDP and failing over only on one
 * specific stderr message left generic failures (timeouts, refused
 * connections) looping on the wrong transport — the main cause of slow or
 * never-connecting IP cameras. The policy here is:
 *
 *   1. Default to TCP (works for the vast majority of cameras).
 *   2. On ANY early exit without a first frame, try the other transport
 *      once, immediately — don't pattern-match stderr for one message.
 *   3. Never hammer the camera on auth failures: back off instead.
 *   4. Mid-stream drops restart fast on the proven transport.
 */

export type RtspTransport = 'tcp' | 'udp'

/** First transport to try for a camera with no learned preference. */
export const RTSP_PREFERRED_TRANSPORT_DEFAULT: RtspTransport = 'tcp'

/** Per-attempt network timeout, in microseconds (ffmpeg `-timeout`). */
export const RTSP_CONNECT_TIMEOUT_US = '3000000'

/** Stream probe caps — small enough for a fast first frame on LAN. */
export const RTSP_PROBESIZE = '64k'
export const RTSP_ANALYZE_DURATION_US = '500000'

/** Delay before trying the other transport after an early failure. */
export const RTSP_TRANSPORT_FAILOVER_DELAY_MS = 150

/** Delay before restarting a dropped mid-stream session (same transport). */
export const RTSP_RESTART_DELAY_MS = 800

/** Delay before retrying after both transports failed in one cycle. */
export const RTSP_EXHAUSTED_RETRY_DELAY_MS = 3000

/** Base delay for repeated never-connected retries (progressive). */
export const RTSP_RETRY_BASE_DELAY_MS = 3000

/** Cap for the progressive retry backoff. */
export const RTSP_RETRY_MAX_DELAY_MS = 60000

/**
 * Progressive delay for consecutive never-connected failures: 3s, 6s, 12s,
 * 24s, 48s, then capped at 60s. Stops a wrong pinned transport (or a camera
 * stuck offline) from hammering the camera and spamming the log every 3s.
 */
export function nextReconnectDelayMs(consecutiveFailures: number): number {
  const step = Math.max(0, Math.min(consecutiveFailures - 1, 5))
  return Math.min(RTSP_RETRY_MAX_DELAY_MS, RTSP_RETRY_BASE_DELAY_MS * 2 ** step)
}

/**
 * Log the first attempts of a failing streak, then only every 10th — the
 * streak state stays visible in get_status (lastError/failures) without
 * flooding the log while nobody can act on it.
 */
export function shouldLogRetry(consecutiveFailures: number): boolean {
  return consecutiveFailures <= 2 || consecutiveFailures % 10 === 0
}

/** Delay before retrying after an auth failure (avoids account lockouts). */
export const RTSP_AUTH_RETRY_DELAY_MS = 10000

/**
 * First-frame watchdog: a hung UDP session produces no data, no EOF and no
 * exit (silent RTP stall) — FFmpeg would sit forever. Kill it after this
 * long without a frame; the exit handler applies the reconnect policy.
 */
export const RTSP_FIRST_FRAME_WATCHDOG_MS = 12000

/** Grace period where the stale sweeper must not kill a fresh attempt. */
export const RTSP_FRESH_ATTEMPT_GRACE_MS = 10000

/**
 * Mid-stream stall threshold: a UDP session that delivered frames and then
 * goes silent keeps FFmpeg alive with no data, no EOF and no exit, so the
 * preview freezes on the last image. Restart when no frame arrived for this
 * long; the exit handler reuses the proven transport for a fast recovery.
 */
export const RTSP_MID_STREAM_STALL_MS = 10000

/** How often the mid-stream watchdog checks for a silent session. */
export const RTSP_MID_STREAM_CHECK_MS = 2500

export function isRtspMidStreamStalled(lastFrameAt: number, now: number = Date.now()): boolean {
  if (!lastFrameAt || lastFrameAt <= 0) return false
  return now - lastFrameAt >= RTSP_MID_STREAM_STALL_MS
}

export function otherTransport(transport: RtspTransport): RtspTransport {
  return transport === 'tcp' ? 'udp' : 'tcp'
}

/**
 * Resolve the transport for a new RTSP session. An explicit per-camera
 * choice (set by the user when adding the camera) wins; otherwise reuse
 * the learned transport, falling back to the TCP-first default.
 */
export function resolveInitialTransport(
  configured?: RtspTransport,
  learned?: RtspTransport
): RtspTransport {
  return configured ?? learned ?? RTSP_PREFERRED_TRANSPORT_DEFAULT
}

/**
 * Honor a user-pinned transport: when the camera has an explicit choice,
 * never fail over to the other transport — retry the chosen one instead,
 * since the user already knows which one their camera speaks.
 */
export function applyPinnedTransport(
  decision: RtspReconnectDecision,
  pinned?: RtspTransport
): RtspReconnectDecision {
  if (pinned && decision.action === 'retry-other-transport') {
    return { action: 'retry-same-transport', delayMs: RTSP_EXHAUSTED_RETRY_DELAY_MS }
  }
  return decision
}

/** FFmpeg arguments for low-latency RTSP → MJPEG transcoding. */
export function buildRtspFfmpegArgs(url: string, transport: RtspTransport): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-rtsp_transport',
    transport,
    '-buffer_size',
    '2097152',
    '-max_delay',
    '500000',
    '-err_detect',
    'ignore_err',
    '-allowed_media_types',
    'video',
    '-timeout',
    RTSP_CONNECT_TIMEOUT_US,
    '-probesize',
    RTSP_PROBESIZE,
    '-analyzeduration',
    RTSP_ANALYZE_DURATION_US,
    '-fflags',
    '+nobuffer+discardcorrupt',
    '-flags',
    'low_delay',
    '-i',
    url,
    '-vf',
    'fps=25,scale=640:-2',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    '-q:v',
    '3',
    'pipe:1'
  ]
}

/** True when stderr (lowercased) indicates wrong credentials. */
export function isRtspAuthFailure(stderrLower: string): boolean {
  return stderrLower.includes('401') || stderrLower.includes('unauthorized')
}

export type RtspReconnectDecision =
  | { action: 'retry-other-transport'; delayMs: number }
  | { action: 'retry-same-transport'; delayMs: number }
  | { action: 'backoff-auth'; delayMs: number }

/**
 * Decide what to do when an FFmpeg RTSP session exits unexpectedly.
 *
 * - Mid-stream drops reuse the proven transport with a short delay.
 * - Early failures (no frame yet) fail over to the other transport once,
 *   whatever the stderr message says — transport mismatch is only one of
 *   many ways the wrong transport fails (timeouts, refused, 404, ...).
 * - Auth failures back off with a long delay instead of hammering the
 *   camera (which can lock the account).
 */
export function decideRtspReconnect(opts: {
  failedTransport: RtspTransport
  stderrLower: string
  hadFirstFrame: boolean
  transportsTried: number
}): RtspReconnectDecision {
  if (opts.hadFirstFrame) {
    return { action: 'retry-same-transport', delayMs: RTSP_RESTART_DELAY_MS }
  }
  if (isRtspAuthFailure(opts.stderrLower)) {
    return { action: 'backoff-auth', delayMs: RTSP_AUTH_RETRY_DELAY_MS }
  }
  if (opts.transportsTried < 2) {
    return { action: 'retry-other-transport', delayMs: RTSP_TRANSPORT_FAILOVER_DELAY_MS }
  }
  return { action: 'retry-same-transport', delayMs: RTSP_EXHAUSTED_RETRY_DELAY_MS }
}
