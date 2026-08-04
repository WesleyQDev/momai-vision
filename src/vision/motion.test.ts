import { describe, it, expect } from 'vitest'
import { MotionGate } from './motion'

function makeFrame(width: number, height: number, fill: number): Uint8Array {
  const rgb = new Uint8Array(width * height * 3)
  rgb.fill(fill)
  return rgb
}

describe('MotionGate', () => {
  it('returns false on the first frame (baseline)', () => {
    const gate = new MotionGate()
    const frame = makeFrame(640, 480, 100)
    expect(gate.check(frame, 640, 480, { sensitivity: 'med' })).toBe(false)
  })

  it('returns true when a region changes significantly', () => {
    const gate = new MotionGate()
    const width = 640
    const height = 480
    gate.check(makeFrame(width, height, 100), width, height, { sensitivity: 'med' })
    const changed = makeFrame(width, height, 100)
    // Paint a large region with a different luminance.
    for (let y = 100; y < 300; y++) {
      for (let x = 100; x < 400; x++) {
        const i = (y * width + x) * 3
        changed[i] = 200
        changed[i + 1] = 200
        changed[i + 2] = 200
      }
    }
    expect(gate.check(changed, width, height, { sensitivity: 'med' })).toBe(true)
  })

  it('returns false for tiny changes below sensitivity', () => {
    const gate = new MotionGate()
    const width = 640
    const height = 480
    gate.check(makeFrame(width, height, 100), width, height, { sensitivity: 'high' })
    const changed = makeFrame(width, height, 100)
    changed[0] = 101 // single pixel
    expect(gate.check(changed, width, height, { sensitivity: 'high' })).toBe(false)
  })

  it('reset() clears the baseline', () => {
    const gate = new MotionGate()
    const frame = makeFrame(640, 480, 100)
    gate.check(frame, 640, 480)
    gate.reset()
    expect(gate.check(frame, 640, 480)).toBe(false)
  })
})
