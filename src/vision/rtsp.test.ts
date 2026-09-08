import { describe, expect, it } from 'vitest'
import {
  RTSP_AUTH_RETRY_DELAY_MS,
  RTSP_EXHAUSTED_RETRY_DELAY_MS,
  RTSP_FIRST_FRAME_WATCHDOG_MS,
  RTSP_PREFERRED_TRANSPORT_DEFAULT,
  RTSP_RESTART_DELAY_MS,
  RTSP_TRANSPORT_FAILOVER_DELAY_MS,
  buildRtspFfmpegArgs,
  decideRtspReconnect,
  isRtspAuthFailure,
  otherTransport
} from './rtsp'

describe('rtsp connection policy', () => {
  it('defaults to TCP first (most IP cameras require interleaved RTP)', () => {
    expect(RTSP_PREFERRED_TRANSPORT_DEFAULT).toBe('tcp')
  })

  it('flips transports', () => {
    expect(otherTransport('tcp')).toBe('udp')
    expect(otherTransport('udp')).toBe('tcp')
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
    expect(args.slice(-4)).toEqual(['mjpeg', '-q:v', '3', 'pipe:1'])
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

  it('fails over to the other transport on ANY early failure, not just mismatch strings', () => {
    // UDP first attempt timing out (generic timeout, no "nonmatching transport").
    expect(
      decideRtspReconnect({
        failedTransport: 'udp',
        stderrLower: 'operation timed out',
        hadFirstFrame: false,
        transportsTried: 1
      })
    ).toEqual({ action: 'retry-other-transport', delayMs: RTSP_TRANSPORT_FAILOVER_DELAY_MS })

    // TCP first attempt refused.
    expect(
      decideRtspReconnect({
        failedTransport: 'tcp',
        stderrLower: 'connection to tcp refused',
        hadFirstFrame: false,
        transportsTried: 1
      })
    ).toEqual({ action: 'retry-other-transport', delayMs: RTSP_TRANSPORT_FAILOVER_DELAY_MS })
  })

  it('backs off on auth failures instead of hammering the camera', () => {
    expect(
      decideRtspReconnect({
        failedTransport: 'tcp',
        stderrLower: 'rtsp: server returned 401 unauthorized',
        hadFirstFrame: false,
        transportsTried: 1
      })
    ).toEqual({ action: 'backoff-auth', delayMs: RTSP_AUTH_RETRY_DELAY_MS })
  })

  it('restarts fast on the proven transport after a mid-stream drop', () => {
    expect(
      decideRtspReconnect({
        failedTransport: 'tcp',
        stderrLower: 'connection reset by peer',
        hadFirstFrame: true,
        transportsTried: 1
      })
    ).toEqual({ action: 'retry-same-transport', delayMs: RTSP_RESTART_DELAY_MS })
  })

  it('retries with backoff once both transports failed in the same cycle', () => {
    expect(
      decideRtspReconnect({
        failedTransport: 'udp',
        stderrLower: 'no route to host',
        hadFirstFrame: false,
        transportsTried: 2
      })
    ).toEqual({ action: 'retry-same-transport', delayMs: RTSP_EXHAUSTED_RETRY_DELAY_MS })
  })
})
