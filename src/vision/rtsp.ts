/**
 * RTSP connection policy — pure, testable helpers (no I/O).
 *
 * The user picks the RTSP transport (UDP or TCP) per camera. The runtime
 * never flips between transports on its own: every retry reuses the
 * configured transport.
 *
 * The policy here is:
 *
 *   1. Use the user-configured transport, falling back to TCP for legacy
 *      cameras without one.
 *   2. Never hammer the camera on auth failures: back off instead.
 *   3. Mid-stream drops restart fast on the same transport.
 */

export type RtspTransport = 'tcp' | 'udp'

/** First transport to try for a camera with no learned preference. */
export const RTSP_PREFERRED_TRANSPORT_DEFAULT: RtspTransport = 'tcp'

/**
 * Per-attempt network timeout, in microseconds (ffmpeg `-timeout`).
 * Cameras commonly hold the first UDP RTP packet until the next IDR
 * (~2.5-3.2s observed on LAN): a 3s budget turned healthy cameras into a
 * coin flip of "Invalid data found when processing input". The first-frame
 * watchdog still bounds a truly dead camera below.
 */
export const RTSP_CONNECT_TIMEOUT_US = '8000000'

/** Stream probe caps — small enough for a fast first frame on LAN. */
export const RTSP_PROBESIZE = '64k'
export const RTSP_ANALYZE_DURATION_US = '500000'

/** Delay before restarting a dropped mid-stream session (same transport). */
export const RTSP_RESTART_DELAY_MS = 800

/**
 * Delay before retrying an early failure on the same transport.
 * "Handshake accepted, no RTP arrived" is a transient condition on this
 * camera class and usually succeeds on the next attempt — so the first
 * failures retry fast instead of freezing the preview behind a long backoff.
 */
export const RTSP_EARLY_RETRY_DELAY_MS = 1500

/** Base delay once repeated early failures become a real streak. */
export const RTSP_RETRY_BASE_DELAY_MS = 3000

/** Cap for the progressive retry backoff (15s keeps a live preview usable). */
export const RTSP_RETRY_MAX_DELAY_MS = 15000

/** Failures that still use the fast retry before the streak is considered real. */
const RTSP_EARLY_RETRY_ATTEMPTS = 3

/**
 * Delay for consecutive never-connected failures: 1.5s (first attempts),
 * then 3s, 6s, 12s, capped at 15s. Fast early retries recover transient
 * "no RTP" stalls; the progressive tail still stops a wrong pinned
 * transport (or a camera stuck offline) from hammering the camera and
 * spamming the log.
 */
export function nextReconnectDelayMs(consecutiveFailures: number): number {
  const failures = Math.max(1, Math.floor(consecutiveFailures) || 1)
  if (failures <= RTSP_EARLY_RETRY_ATTEMPTS) return RTSP_EARLY_RETRY_DELAY_MS
  const step = Math.min(failures - RTSP_EARLY_RETRY_ATTEMPTS - 1, 3)
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

/**
 * Resolve the transport for a new RTSP session. Always the user-configured
 * transport; legacy cameras without one fall back to the TCP default.
 * The second parameter is kept for call-site compatibility and ignored.
 */
export function resolveInitialTransport(
  configured?: RtspTransport,
  _learned?: RtspTransport
): RtspTransport {
  return configured ?? RTSP_PREFERRED_TRANSPORT_DEFAULT
}

/** Preview widths (px) allowed for the MJPEG transcode. */
export const PREVIEW_WIDTH_OPTIONS = [640, 960, 1280] as const

/** Today's behavior: a light preview that leaves CPU for the YOLO engine. */
export const PREVIEW_WIDTH_DEFAULT = 640

/**
 * Resolve the persisted preview width. Only the curated set is accepted;
 * legacy cameras and junk values keep the 640 default.
 */
export function resolvePreviewWidth(value: unknown): number {
  return typeof value === 'number' && (PREVIEW_WIDTH_OPTIONS as readonly number[]).includes(value)
    ? value
    : PREVIEW_WIDTH_DEFAULT
}

/** Supported RTSP camera video stream codecs. */
export type RtspCodec = 'h264' | 'h265'

/** Allowed codec options for RTSP cameras. */
export const RTSP_CODEC_OPTIONS = ['h264', 'h265'] as const

/** Default codec for highest compatibility and stability. */
export const RTSP_CODEC_DEFAULT: RtspCodec = 'h264'

/**
 * Resolve the persisted RTSP codec. Defaults to 'h264' for maximum stability.
 */
export function resolveRtspCodec(value: unknown): RtspCodec {
  return value === 'h265' ? 'h265' : RTSP_CODEC_DEFAULT
}

/** FFmpeg arguments for low-latency RTSP transcoding. */
export function buildRtspFfmpegArgs(
  url: string,
  transport: RtspTransport,
  previewWidth: number = PREVIEW_WIDTH_DEFAULT,
  codec: RtspCodec = RTSP_CODEC_DEFAULT
): string[] {
  const args = [
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
    'low_delay'
  ]

  // For H.265 (HEVC), drop reorder queue size to zero to prevent mid-stream stalls on RTP packets.
  if (codec === 'h265') {
    args.push('-reorder_queue_size', '0')
  }

  args.push(
    '-i',
    url,
    // Preview cadence follows the camera (passthrough). Forcing `fps=25`
    // duplicated frames when the source is slower (typical 10-15fps substream),
    // paying JPEG encode + HTTP push for images that add nothing.
    // min(width, iw) caps without upscaling: a 640-wide substream stays at
    // 640 even when the user picks a larger preview, so no bandwidth is spent
    // on interpolated pixels.
    '-vf',
    `scale=w='min(${previewWidth},iw)':h=-2`,
    '-fps_mode',
    'passthrough',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    // q5 keeps the preview and the 640x640 YOLO letterbox sharp while cutting
    // frame size ~35% versus q3 (~110KB → ~70KB at 640x360 in LAN tests).
    '-q:v',
    '5',
    'pipe:1'
  )

  return args
}

/** True when stderr (lowercased) indicates wrong credentials. */
export function isRtspAuthFailure(stderrLower: string): boolean {
  return stderrLower.includes('401') || stderrLower.includes('unauthorized')
}

/**
 * True when an FFmpeg stderr chunk is benign muxer noise that must not
 * pollute the log. Duplicate timestamps from the RTSP source surface as
 * "Application provided invalid, non monotonically increasing dts to muxer"
 * on the image2pipe output while frames keep flowing, so the chunk stays
 * in the exit-hint buffer but never reaches the live log.
 */
export function isBenignRtspStderr(msg: string): boolean {
  if (!msg) return false
  const lower = msg.toLowerCase()
  if (lower.includes('non monotonically increasing dts')) return true
  return lower.includes('application provided invalid') && lower.includes('muxer')
}

export type RtspReconnectDecision =
  | { action: 'retry-same-transport'; delayMs: number }
  | { action: 'backoff-auth'; delayMs: number }

/**
 * Decide what to do when an FFmpeg RTSP session exits unexpectedly.
 *
 * - Mid-stream drops retry the same transport with a short delay.
 * - Early failures (no frame yet) retry the same transport — the user
 *   owns the UDP/TCP choice, so the runtime never flips transports.
 * - Auth failures back off with a long delay instead of hammering the
 *   camera (which can lock the account).
 */
export function decideRtspReconnect(opts: {
  failedTransport: RtspTransport
  stderrLower: string
  hadFirstFrame: boolean
}): RtspReconnectDecision {
  if (opts.hadFirstFrame) {
    return { action: 'retry-same-transport', delayMs: RTSP_RESTART_DELAY_MS }
  }
  if (isRtspAuthFailure(opts.stderrLower)) {
    return { action: 'backoff-auth', delayMs: RTSP_AUTH_RETRY_DELAY_MS }
  }
  return { action: 'retry-same-transport', delayMs: RTSP_EARLY_RETRY_DELAY_MS }
}
