import { describe, expect, it } from 'vitest'
import {
  RTSP_AUTH_RETRY_DELAY_MS,
  RTSP_CONNECT_TIMEOUT_US,
  RTSP_EARLY_RETRY_DELAY_MS,
  RTSP_FIRST_FRAME_WATCHDOG_MS,
  RTSP_MID_STREAM_STALL_MS,
  RTSP_PREFERRED_TRANSPORT_DEFAULT,
  RTSP_RESTART_DELAY_MS,
  RTSP_RETRY_MAX_DELAY_MS,
  RTSP_SOCKET_LOCK_RETRY_DELAY_MS,
  PREVIEW_WIDTH_DEFAULT,
  PREVIEW_WIDTH_OPTIONS,
  RTSP_CODEC_DEFAULT,
  RTSP_CODEC_OPTIONS,
  buildRtspFfmpegArgs,
  decideRtspReconnect,
  describeRtspIssue,
  isBenignRtspStderr,
  isRtspAuthFailure,
  isRtspMidStreamStalled,
  isRtspSocketLockError,
  nextReconnectDelayMs,
  resolveInitialTransport,
  resolvePreviewWidth,
  resolveRtspCodec,
  shouldLogRetry
} from './rtsp'

describe('rtsp connection policy', () => {
  it('defaults to TCP for legacy cameras without a choice', () => {
    expect(RTSP_PREFERRED_TRANSPORT_DEFAULT).toBe('tcp')
  })

  it('builds low-latency ffmpeg args with the requested transport', () => {
    const url = 'rtsp://admin:pass@192.168.0.4:554/onvif1'
    const args = buildRtspFfmpegArgs(url, 'tcp')
    expect(args).toContain('-rtsp_transport')
    expect(args[args.indexOf('-rtsp_transport') + 1]).toBe('tcp')
    // Fast-fail timeouts so a wrong transport does not stall the connect.
    expect(args).toContain('-timeout')
    expect(args).toContain('-probesize')
    expect(args).toContain('-analyzeduration')
    expect(args).toContain(url)
    // Still transcodes to an MJPEG pipe for the preview pipeline.
    expect(args.slice(-4)).toEqual(['mjpeg', '-q:v', '5', 'pipe:1'])
  })

  it('passes an RTSP URL with encoded credentials to ffmpeg unchanged', () => {
    const url = 'rtsp://admin:Aa91650039%23@192.168.0.4:554/onvif1'
    for (const transport of ['tcp', 'udp'] as const) {
      const args = buildRtspFfmpegArgs(url, transport)
      expect(args[args.indexOf('-i') + 1]).toBe(url)
      expect(args[args.indexOf('-rtsp_transport') + 1]).toBe(transport)
    }
  })

  it('waits long enough for a slow first RTP packet instead of failing at 3s', () => {
    // The camera needs ~2.5-3.2s to deliver the first UDP RTP packet; a 3s
    // budget turned a healthy camera into a coin flip.
    expect(Number(RTSP_CONNECT_TIMEOUT_US)).toBeGreaterThanOrEqual(8_000_000)
    expect(Number(RTSP_CONNECT_TIMEOUT_US)).toBeLessThan(Number(RTSP_FIRST_FRAME_WATCHDOG_MS) * 1000)
  })

  it('keeps the camera cadence instead of duplicating frames to 25fps', () => {
    const args = buildRtspFfmpegArgs('rtsp://admin:pass@192.168.0.4:554/onvif2', 'udp')
    expect(args.join(' ')).not.toContain('fps=25')
    expect(args).toContain('-fps_mode')
    expect(args[args.indexOf('-fps_mode') + 1]).toBe('passthrough')
  })

  it('resolves the preview width to the allowed values with a 640 default', () => {
    expect(PREVIEW_WIDTH_DEFAULT).toBe(640)
    expect(PREVIEW_WIDTH_OPTIONS).toEqual([640, 960, 1280])
    expect(resolvePreviewWidth(640)).toBe(640)
    expect(resolvePreviewWidth(960)).toBe(960)
    expect(resolvePreviewWidth(1280)).toBe(1280)
    // Legacy cameras without a choice and junk values keep the old behavior.
    expect(resolvePreviewWidth(undefined)).toBe(640)
    expect(resolvePreviewWidth(null)).toBe(640)
    expect(resolvePreviewWidth(4096)).toBe(640)
    expect(resolvePreviewWidth('1280')).toBe(640)
  })

  it('caps the preview width without upscaling a smaller source', () => {
    const args = buildRtspFfmpegArgs('rtsp://admin:pass@192.168.0.4:554/onvif2', 'udp', 1280)
    expect(args[args.indexOf('-vf') + 1]).toBe("scale=w='min(1280,iw)':h=-2")
    // Default stays 640 (today's behavior) and never upscales.
    const fallback = buildRtspFfmpegArgs('rtsp://admin:pass@192.168.0.4:554/onvif2', 'udp')
    expect(fallback[fallback.indexOf('-vf') + 1]).toBe("scale=w='min(640,iw)':h=-2")
  })

  it('resolves the codec to allowed values and configures H.265 args', () => {
    expect(RTSP_CODEC_DEFAULT).toBe('h264')
    expect(RTSP_CODEC_OPTIONS).toEqual(['h264', 'h265'])
    expect(resolveRtspCodec('h264')).toBe('h264')
    expect(resolveRtspCodec('h265')).toBe('h265')
    expect(resolveRtspCodec(undefined)).toBe('h264')
    expect(resolveRtspCodec('unknown')).toBe('h264')

    const h264Args = buildRtspFfmpegArgs('rtsp://admin:pass@192.168.0.4:554/onvif1', 'tcp', 640, 'h264')
    expect(h264Args).not.toContain('-reorder_queue_size')

    const h265Args = buildRtspFfmpegArgs('rtsp://admin:pass@192.168.0.4:554/onvif1', 'tcp', 640, 'h265')
    expect(h265Args).toContain('-reorder_queue_size')
    expect(h265Args[h265Args.indexOf('-reorder_queue_size') + 1]).toBe('0')
  })

  it('bounds the first-frame wait so a silent UDP stall cannot hang forever', () => {
    // Below the stale threshold (15s) so the watchdog fires first, above a
    // healthy first frame (~5s on H.265 cameras).
    expect(RTSP_FIRST_FRAME_WATCHDOG_MS).toBeGreaterThan(5000)
    expect(RTSP_FIRST_FRAME_WATCHDOG_MS).toBeLessThan(15000)
  })

  it('detects auth failures from ffmpeg stderr', () => {
    expect(isRtspAuthFailure('server returned 401 unauthorized')).toBe(true)
    expect(isRtspAuthFailure('method setup failed: 404 stream not found')).toBe(false)
    expect(isRtspAuthFailure('')).toBe(false)
  })

  it('marks duplicate timestamp muxer warnings as benign log noise', () => {
    expect(
      isBenignRtspStderr(
        '[image2pipe @ 00000181ae4decc0] Application provided invalid, non monotonically increasing dts to muxer in stream 0: 775 >= 775'
      )
    ).toBe(true)
    expect(isBenignRtspStderr('non monotonically increasing dts to muxer in stream 0')).toBe(true)
    expect(isBenignRtspStderr('    Last message repeated 1 times')).toBe(true)
    expect(isBenignRtspStderr('server returned 401 unauthorized')).toBe(false)
    expect(isBenignRtspStderr('')).toBe(false)
  })

  it('backs off on socket lock, server errors (5xx/500/400) and port timeouts to let camera recover', () => {
    expect(isRtspSocketLockError('connection to tcp://192.168.0.2:554 failed: error number -138 occurred')).toBe(true)
    expect(isRtspSocketLockError('connection refused')).toBe(true)
    expect(isRtspSocketLockError('connection timed out')).toBe(true)
    expect(isRtspSocketLockError('method setup failed: 500 (internal server error)')).toBe(true)
    expect(isRtspSocketLockError('server returned 5xx server error reply')).toBe(true)
    expect(isRtspSocketLockError('server returned 400 bad request')).toBe(true)
    expect(isRtspSocketLockError('method options failed: 405 (method not allowed)')).toBe(true)
    expect(isRtspSocketLockError('nonmatching transport in server reply')).toBe(true)
    expect(isRtspSocketLockError('method setup failed: 404 stream not found')).toBe(false)

    expect(
      decideRtspReconnect({
        failedTransport: 'tcp',
        stderrLower: 'connection to tcp://192.168.0.2:554 failed: error number -138 occurred',
        hadFirstFrame: false
      })
    ).toEqual({ action: 'backoff-socket-lock', delayMs: RTSP_SOCKET_LOCK_RETRY_DELAY_MS })

    expect(
      decideRtspReconnect({
        failedTransport: 'udp',
        stderrLower: 'method setup failed: 500 (internal server error)',
        hadFirstFrame: false
      })
    ).toEqual({ action: 'backoff-socket-lock', delayMs: RTSP_SOCKET_LOCK_RETRY_DELAY_MS })

    expect(
      decideRtspReconnect({
        failedTransport: 'udp',
        stderrLower: 'server returned 400 bad request',
        hadFirstFrame: false
      })
    ).toEqual({ action: 'backoff-socket-lock', delayMs: RTSP_SOCKET_LOCK_RETRY_DELAY_MS })

    expect(
      decideRtspReconnect({
        failedTransport: 'tcp',
        stderrLower: 'connection to tcp refused',
        hadFirstFrame: false
      })
    ).toEqual({ action: 'backoff-socket-lock', delayMs: RTSP_SOCKET_LOCK_RETRY_DELAY_MS })
  })

  it('never flips transports on early failure — retries the same manual choice', () => {
    // Generic early failure without socket lock stays on same transport with early delay
    expect(
      decideRtspReconnect({
        failedTransport: 'udp',
        stderrLower: 'invalid data found when processing input',
        hadFirstFrame: false
      })
    ).toEqual({ action: 'retry-same-transport', delayMs: RTSP_EARLY_RETRY_DELAY_MS })

    expect(
      decideRtspReconnect({
        failedTransport: 'tcp',
        stderrLower: 'method setup failed: 404 stream not found',
        hadFirstFrame: false
      })
    ).toEqual({ action: 'retry-same-transport', delayMs: RTSP_EARLY_RETRY_DELAY_MS })
  })

  it('classifies the connection issue for the card hint', () => {
    expect(describeRtspIssue('auth')).toBe('auth')
    expect(describeRtspIssue('server returned 401 unauthorized')).toBe('auth')
    expect(describeRtspIssue('ffmpeg-missing')).toBe('ffmpeg-missing')
    expect(describeRtspIssue('method setup failed: 404 stream not found')).toBe('not-found')
    expect(describeRtspIssue('connection timed out')).toBe('network')
    expect(describeRtspIssue('connection refused')).toBe('network')
    expect(describeRtspIssue('')).toBe('unknown')
    expect(describeRtspIssue('invalid data found when processing input')).toBe('unknown')
  })

  it('backs off on auth failures instead of hammering the camera', () => {
    expect(
      decideRtspReconnect({
        failedTransport: 'tcp',
        stderrLower: 'rtsp: server returned 401 unauthorized',
        hadFirstFrame: false
      })
    ).toEqual({ action: 'backoff-auth', delayMs: RTSP_AUTH_RETRY_DELAY_MS })
  })

  it('restarts fast on the same transport after a mid-stream drop', () => {
    expect(
      decideRtspReconnect({
        failedTransport: 'tcp',
        stderrLower: 'connection reset by peer',
        hadFirstFrame: true
      })
    ).toEqual({ action: 'retry-same-transport', delayMs: RTSP_RESTART_DELAY_MS })
  })

  it('retries the same transport on generic repeated early failures', () => {
    expect(
      decideRtspReconnect({
        failedTransport: 'udp',
        stderrLower: 'header missing or corrupt',
        hadFirstFrame: false
      })
    ).toEqual({ action: 'retry-same-transport', delayMs: RTSP_EARLY_RETRY_DELAY_MS })
  })

  it('sticks to the user-configured transport', () => {
    expect(resolveInitialTransport('udp', 'tcp')).toBe('udp')
    expect(resolveInitialTransport('tcp', 'udp')).toBe('tcp')
    expect(resolveInitialTransport(undefined, 'udp')).toBe(RTSP_PREFERRED_TRANSPORT_DEFAULT)
    expect(resolveInitialTransport()).toBe(RTSP_PREFERRED_TRANSPORT_DEFAULT)
  })

  it('retries fast at first, then backs off with a short cap', () => {
    // Transient "handshake ok, no RTP" failures are common on this camera
    // class: the first attempts must retry fast instead of freezing the
    // preview for a minute behind the progressive backoff.
    expect(RTSP_EARLY_RETRY_DELAY_MS).toBe(1500)
    expect(nextReconnectDelayMs(0)).toBe(RTSP_EARLY_RETRY_DELAY_MS)
    expect(nextReconnectDelayMs(1)).toBe(RTSP_EARLY_RETRY_DELAY_MS)
    expect(nextReconnectDelayMs(3)).toBe(RTSP_EARLY_RETRY_DELAY_MS)
    // Only after a real failing streak does it slow down...
    expect(nextReconnectDelayMs(4)).toBe(3000)
    expect(nextReconnectDelayMs(5)).toBe(6000)
    expect(nextReconnectDelayMs(6)).toBe(12000)
    // ...and the cap stays short enough for a live preview to recover.
    expect(RTSP_RETRY_MAX_DELAY_MS).toBe(15000)
    expect(nextReconnectDelayMs(7)).toBe(15000)
    expect(nextReconnectDelayMs(100)).toBe(15000)
  })

  it('quiets the log after the first attempts of a failing streak', () => {
    expect(shouldLogRetry(1)).toBe(true)
    expect(shouldLogRetry(2)).toBe(true)
    expect(shouldLogRetry(3)).toBe(false)
    expect(shouldLogRetry(9)).toBe(false)
    expect(shouldLogRetry(10)).toBe(true)
    expect(shouldLogRetry(20)).toBe(true)
  })

  it('detects a mid-stream stall after the first frame (frozen UDP session)', () => {
    expect(RTSP_MID_STREAM_STALL_MS).toBeGreaterThan(5000)
    expect(RTSP_MID_STREAM_STALL_MS).toBeLessThan(15000)
    const now = Date.now()
    expect(isRtspMidStreamStalled(0, now)).toBe(false)
    expect(isRtspMidStreamStalled(now - 2000, now)).toBe(false)
    expect(isRtspMidStreamStalled(now - (RTSP_MID_STREAM_STALL_MS + 1000), now)).toBe(true)
  })
})
