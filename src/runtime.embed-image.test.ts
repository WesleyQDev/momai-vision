import { describe, it, expect } from 'vitest'
import { encode, decode } from 'jpeg-js'
import { readJpegWidth, resizeJpegBase64 } from './runtime'

function makeJpeg(width: number, height: number): string {
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = (x * 7) % 255
      data[i + 1] = (y * 5) % 255
      data[i + 2] = 60
      data[i + 3] = 255
    }
  }
  return Buffer.from(encode({ data, width, height }, 85).data).toString('base64')
}

describe('readJpegWidth', () => {
  it('reads the width from the SOF marker', () => {
    expect(readJpegWidth(makeJpeg(1920, 1080))).toBe(1920)
    expect(readJpegWidth(makeJpeg(640, 480))).toBe(640)
  })

  it('returns null for invalid input', () => {
    expect(readJpegWidth('not-a-jpeg')).toBeNull()
  })
})

describe('resizeJpegBase64', () => {
  it('returns the original string untouched when the frame is already small', () => {
    const small = makeJpeg(640, 480)
    expect(resizeJpegBase64(small)).toBe(small)
  })

  it('downscales larger frames to 640 wide', () => {
    const big = makeJpeg(1920, 1080)
    const resized = resizeJpegBase64(big)
    expect(resized).toBeTruthy()
    expect(resized).not.toBe(big)

    const buffer = Buffer.from(resized as string, 'base64')
    const raw = decode(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength), {
      useTArray: true
    })
    expect(raw.width).toBe(640)
    expect(raw.height).toBe(360)
  })

  it('returns null for invalid input instead of embedding the raw frame', () => {
    expect(resizeJpegBase64('not-a-jpeg')).toBeNull()
  })
})
