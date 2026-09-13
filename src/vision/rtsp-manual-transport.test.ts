import { describe, expect, it } from 'vitest'
import { decideRtspReconnect, resolveInitialTransport } from './rtsp'

describe('manual transport lock (no auto UDP/TCP flip)', () => {
  it('never flips transports on early failure — retries the same manual choice', () => {
    const decision = decideRtspReconnect({
      failedTransport: 'udp',
      stderrLower: 'operation timed out',
      hadFirstFrame: false
    })
    expect(decision).toEqual({ action: 'retry-same-transport', delayMs: 3000 })
  })

  it('ignores learned transport and sticks to the user choice', () => {
    expect(resolveInitialTransport('udp', 'tcp')).toBe('udp')
    expect(resolveInitialTransport('tcp', 'udp')).toBe('tcp')
  })
})
