import { describe, it, expect } from 'vitest'
import { encode, decode } from 'jpeg-js'
import { annotateJpegWithBoxes } from './runtime'

function makeJpeg(width: number, height: number): string {
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = 40
      data[i + 1] = 40
      data[i + 2] = 40
      data[i + 3] = 255
    }
  }
  return Buffer.from(encode({ data, width, height }, 85).data).toString('base64')
}

function decodePixels(base64: string) {
  const jpeg = Buffer.from(base64, 'base64')
  return decode(new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength), { useTArray: true })
}

describe('annotateJpegWithBoxes (MOM-171 — imagem com boxes sob demanda)', () => {
  it('retorna null sem boxes (snapshot limpo continua limpo)', () => {
    expect(annotateJpegWithBoxes(makeJpeg(320, 240), [])).toBeNull()
  })

  it('retorna null para entrada inválida sem quebrar o alerta', () => {
    expect(
      annotateJpegWithBoxes('not-a-jpeg', [{ className: 'person', confidence: 0.9, x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 }])
    ).toBeNull()
  })

  it('desenha a borda na imagem mantendo as dimensões', () => {
    const clean = makeJpeg(320, 240)
    const boxes = [{ className: 'person', confidence: 0.9, x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 }]
    const annotated = annotateJpegWithBoxes(clean, boxes)
    expect(annotated).toBeTruthy()
    expect(annotated).not.toBe(clean)
    const raw = decodePixels(annotated!)
    expect(raw.width).toBe(320)
    expect(raw.height).toBe(240)
    // Amostra no meio da borda superior do box: deve ter cor (não mais cinza 40).
    const x = Math.round(0.3 * 320)
    const y = Math.round(0.1 * 240)
    const i = (y * raw.width + x) * 4
    const isGray = raw.data[i] === 40 && raw.data[i + 1] === 40 && raw.data[i + 2] === 40
    expect(isGray).toBe(false)
  })

  it('boxes totalmente fora da imagem viram null (nada a desenhar)', () => {
    const clean = makeJpeg(320, 240)
    const out = annotateJpegWithBoxes(clean, [
      { className: 'car', confidence: 0.5, x1: 2, y1: 2, x2: 5, y2: 5 }
    ])
    expect(out).toBeNull()
  })
})
