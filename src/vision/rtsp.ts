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

/** Stream probe caps — minimal so FFmpeg emits the very first IDR frame immediately. */
export const RTSP_PROBESIZE = '32k'
export const RTSP_ANALYZE_DURATION_US = '100000'

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
 * Delay before retrying after a socket lock / port timeout error (e.g. error -138).
 * Low-cost IP cameras (like Yoosee) drop/ignore new connections until the internal
 * RTSP daemon cleans up hung sessions. A 15s quiet window lets the camera recover.
 */
export const RTSP_SOCKET_LOCK_RETRY_DELAY_MS = 15000

/**
 * First-frame watchdog: a hung UDP session produces no data, no EOF and no
 * exit (silent RTP stall) — FFmpeg would sit forever. Kill it after this
 * long without a frame; the exit handler applies the reconnect policy.
 */
export const RTSP_FIRST_FRAME_WATCHDOG_MS = 10000

/** Grace period where the stale sweeper must not kill a fresh attempt. */
export const RTSP_FRESH_ATTEMPT_GRACE_MS = 10000

/**
 * Mid-stream stall threshold: a UDP session that delivered frames and then
 * goes silent keeps FFmpeg alive with no data, no EOF and no exit, so the
 * preview freezes on the last image. Restart when no frame arrived for this
 * long; the exit handler reuses the proven transport for a fast recovery.
 */
export const RTSP_MID_STREAM_STALL_MS = 6000

/** How often the mid-stream watchdog checks for a silent session. */
export const RTSP_MID_STREAM_CHECK_MS = 1500

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

/** Supported RTSP camera stream profiles based on active demand. */
export type RtspStreamProfile = 'live' | 'monitor' | 'standby'

/** FPS cap when only background monitoring is active (tickCamera runs at 1 FPS). */
export const RTSP_MONITOR_FPS = 2

/** FPS cap when no UI subscriber and no active monitor are running (keeps cache <=1s fresh). */
export const RTSP_STANDBY_FPS = 1

/** Grace period before downgrading from live to monitor/standby after subscribers drop to 0 (3 min). */
export const RTSP_PROFILE_DOWNGRADE_GRACE_MS = 180000

/** Brief pause between killing old FFmpeg and spawning new FFmpeg during a profile switch. */
export const RTSP_PROFILE_SWITCH_DELAY_MS = 400

/** Default Economy Mode state for IP cameras (enabled by default to save background CPU). */
export const RTSP_ECONOMY_MODE_DEFAULT = true

/**
 * Resolve persisted economy mode flag. Enabled by default unless explicitly set to `false`.
 */
export function resolveEconomyMode(value: unknown): boolean {
  return value === false ? false : RTSP_ECONOMY_MODE_DEFAULT
}

/**
 * Resolve desired RTSP stream profile from subscriber count, monitoring state,
 * and camera economy mode:
 * - When `economyMode` is false: always `'live'` (full background stream).
 * - `live`: a UI/widget subscriber is watching (or count is not yet known).
 * - `monitor`: no UI subscriber, but at least one active monitor needs frames.
 * - `standby`: no UI subscriber and no active monitor; keeps cache warm for instant tab open.
 */
export function resolveRtspStreamProfile(opts: {
  subscribers: number | null
  hasActiveMonitor: boolean
  economyMode?: boolean
}): RtspStreamProfile {
  const economy = opts.economyMode === undefined ? RTSP_ECONOMY_MODE_DEFAULT : opts.economyMode
  if (!economy) return 'live'
  if (opts.subscribers === null || opts.subscribers > 0) return 'live'
  if (opts.hasActiveMonitor) return 'monitor'
  return 'standby'
}

/**
 * Decide whether to switch the running FFmpeg profile now or hold during downgrade grace.
 * Promotions to `live` are always immediate; downgrades from `live` wait `graceMs`
 * after `lastLiveAt` (when `lastLiveAt > 0`) so quick tab switches avoid FFmpeg restarts.
 */
export function decideRtspProfileTransition(opts: {
  currentProfile: RtspStreamProfile
  desiredProfile: RtspStreamProfile
  lastLiveAt: number
  now: number
  graceMs?: number
}): { nextProfile: RtspStreamProfile; switchNow: boolean } {
  const { currentProfile, desiredProfile, lastLiveAt, now } = opts
  const graceMs = opts.graceMs ?? RTSP_PROFILE_DOWNGRADE_GRACE_MS
  if (desiredProfile === currentProfile) {
    return { nextProfile: currentProfile, switchNow: false }
  }
  if (desiredProfile === 'live') {
    return { nextProfile: 'live', switchNow: true }
  }
  if (currentProfile === 'live' && lastLiveAt > 0 && now - lastLiveAt < graceMs) {
    return { nextProfile: 'live', switchNow: false }
  }
  return { nextProfile: desiredProfile, switchNow: true }
}

/** FFmpeg arguments for low-latency RTSP transcoding. */
export function buildRtspFfmpegArgs(
  url: string,
  transport: RtspTransport,
  previewWidth: number = PREVIEW_WIDTH_DEFAULT,
  codec: RtspCodec = RTSP_CODEC_DEFAULT,
  profile: RtspStreamProfile = 'live'
): string[] {
  const isUdp = transport === 'udp'
  const bufferSize = isUdp ? '8388608' : '2097152'
  const maxDelay = isUdp ? '1000000' : '500000'

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-rtsp_transport',
    transport,
    '-buffer_size',
    bufferSize,
    '-max_delay',
    maxDelay,
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

  // Over UDP, keep a modest RTP reorder window so out-of-order packets from
  // Wi-Fi/router jitter are reordered instead of dropped as lost slices.
  // Over TCP (already ordered), H.265 keeps 0 to prevent mid-stream stalls.
  if (isUdp) {
    args.push('-reorder_queue_size', '256')
  } else if (codec === 'h265') {
    args.push('-reorder_queue_size', '0')
  }

  const scaleFilter = `scale=w='min(${previewWidth},iw)':h=-2`
  const vfFilter =
    profile === 'monitor'
      ? `fps=${RTSP_MONITOR_FPS},${scaleFilter}`
      : profile === 'standby'
        ? `fps=${RTSP_STANDBY_FPS},${scaleFilter}`
        : scaleFilter

  args.push(
    '-i',
    url,
    // Preview cadence follows the camera in 'live' mode via vfr (drops
    // duplicate PTS that crash FFmpeg 8+ mjpeg encoder with Invalid argument).
    // In 'monitor' (2fps) and 'standby' (1fps) modes, the fps filter drops
    // frames before scaling and MJPEG encoding so background CPU stays minimal.
    '-vf',
    vfFilter,
    '-fps_mode',
    profile === 'live' ? 'vfr' : 'cfr',
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

/** Card-level cause of an IP connection failure (display only). */
export type RtspIssue = 'auth' | 'not-found' | 'network' | 'ffmpeg-missing' | 'unknown'

/**
 * Classify stored lastError text for the camera card hint. Reuses the
 * reconnect classifiers so the card never disagrees with the retry policy.
 */
export function describeRtspIssue(raw: string | null | undefined): RtspIssue {
  const lower = (raw || '').toLowerCase()
  if (!lower) return 'unknown'
  if (lower === 'ffmpeg-missing') return 'ffmpeg-missing'
  if (lower === 'auth' || isRtspAuthFailure(lower)) return 'auth'
  if (lower.includes('404') || lower.includes('not found')) return 'not-found'
  if (isRtspSocketLockError(lower)) return 'network'
  return 'unknown'
}

/**
 * True when stderr indicates the camera's RTSP port/socket is blocked, timing out,
 * or overloaded (5xx Server Error, 500, 400 Bad Request, nonmatching transport).
 * Low-cost IP cameras (like Yoosee / Xiongmai / HiSilicon) reject connections
 * with these errors when overwhelmed with rapid reconnects or session exhaustion.
 */
export function isRtspSocketLockError(stderrLower: string): boolean {
  if (!stderrLower) return false
  return (
    stderrLower.includes('-138') ||
    stderrLower.includes('timed out') ||
    stderrLower.includes('connection refused') ||
    stderrLower.includes('refused') ||
    stderrLower.includes('no route to host') ||
    stderrLower.includes('host is unreachable') ||
    stderrLower.includes('server returned 5') ||
    stderrLower.includes('500 (internal server error)') ||
    stderrLower.includes('500 internal server error') ||
    stderrLower.includes('server returned 400 bad request') ||
    stderrLower.includes('400 bad request') ||
    stderrLower.includes('405 (method not allowed)') ||
    stderrLower.includes('405 method not allowed') ||
    stderrLower.includes('method options failed: 405') ||
    stderrLower.includes('nonmatching transport')
  )
}

/** Alias for semantic clarity. */
export const isRtspServerBusyError = isRtspSocketLockError

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
  if (lower.includes('last message repeated')) return true
  return lower.includes('application provided invalid') && lower.includes('muxer')
}

/**
 * Bitstream complaints that surface when the video arrives damaged (packet
 * loss, camera firmware or a reconnect landing mid-GOP). They repeat for every
 * lost frame, so the runtime throttles them instead of dropping them: a camera
 * that keeps corrupting frames must stay visible in the log.
 *
 * Classification is structural on purpose: libavcodec keeps inventing new
 * error strings, but every decoder line carries its context tag
 * (`[h264 @ ...]`, `[vist#0:0/h264 @ ...]`, `[dec:h264 @ ...]`).
 */
const DECODER_ERROR_TAG_RE =
  /\[[^\]]*(?:\b(?:h264|hevc|h265|mpeg4|mpeg2video|av1|vp8|vp9)\b|dec:)[^\]]*\s@[^\]]*\]/i

/** Corruption reported by the RTSP depacketizer before decoding starts. */
const RTSP_PACKET_NOISE_PATTERNS = [
  'too short data for',
  'rtp: missed',
  'circular buffer overflow',
  'max delay reached',
  'jitter buffer'
]

export function isRtspBitstreamNoise(msg: string): boolean {
  if (!msg) return false
  if (DECODER_ERROR_TAG_RE.test(msg)) return true
  const lower = msg.toLowerCase()
  return RTSP_PACKET_NOISE_PATTERNS.some((pattern) => lower.includes(pattern))
}

/**
 * Rebuild whole stderr lines from arbitrarily split chunks. FFmpeg can write a
 * message in pieces, and a half line ("Last message repe") dodges the noise
 * filters and reaches the log as an unknown error.
 */
export function splitStderrLines(
  pending: string,
  chunk: string,
  maxPending = 2000
): { lines: string[]; pending: string } {
  let buffer = pending + chunk
  const lines: string[] = []
  let newline = buffer.indexOf('\n')
  while (newline !== -1) {
    const line = buffer.slice(0, newline).replace(/\r$/, '').trim()
    buffer = buffer.slice(newline + 1)
    if (line) lines.push(line)
    newline = buffer.indexOf('\n')
  }
  // A pathological stream without newlines must not grow forever.
  if (buffer.length > maxPending) {
    const line = buffer.trim()
    buffer = ''
    if (line) lines.push(line)
  }
  return { lines, pending: buffer }
}

/** At most one decoder-error line per camera per window. */
export const RTSP_DECODER_LOG_WINDOW_MS = 30_000

export type RtspDecoderLogSlot = { log: boolean; suppressed: number }

/**
 * Throttle for repeated decoder errors. `take()` reports whether the line
 * should be logged and, when it should, how many identical bursts were
 * suppressed since the previous logged line.
 */
export function createRtspDecoderLogThrottle(
  windowMs: number = RTSP_DECODER_LOG_WINDOW_MS
): { take(now?: number): RtspDecoderLogSlot } {
  let lastLoggedAt = 0
  let suppressed = 0
  return {
    take(now: number = Date.now()): RtspDecoderLogSlot {
      if (lastLoggedAt > 0 && now - lastLoggedAt < windowMs) {
        suppressed += 1
        return { log: false, suppressed: 0 }
      }
      const pending = suppressed
      suppressed = 0
      lastLoggedAt = now
      return { log: true, suppressed: pending }
    }
  }
}

export type RtspReconnectDecision =
  | { action: 'retry-same-transport'; delayMs: number }
  | { action: 'backoff-auth'; delayMs: number }
  | { action: 'backoff-socket-lock'; delayMs: number }

/**
 * Decide what to do when an FFmpeg RTSP session exits unexpectedly.
 *
 * - Mid-stream drops retry the same transport with a short delay.
 * - Early failures (no frame yet) retry the same transport — the user
 *   owns the UDP/TCP choice, so the runtime never flips transports.
 * - Auth failures back off with a long delay instead of hammering the
 *   camera (which can lock the account).
 * - Socket lock / timeout errors (error -138) back off with a quiet window
 *   to let the camera's RTSP server release dead connections.
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
  if (isRtspSocketLockError(opts.stderrLower)) {
    return { action: 'backoff-socket-lock', delayMs: RTSP_SOCKET_LOCK_RETRY_DELAY_MS }
  }
  return { action: 'retry-same-transport', delayMs: RTSP_EARLY_RETRY_DELAY_MS }
}
