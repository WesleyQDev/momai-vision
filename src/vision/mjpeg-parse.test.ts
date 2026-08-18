import { describe, it, expect } from 'vitest'
import { extractJpegFrame, indexOfSeq } from './mjpeg-parse'

const BOUNDARY = new TextEncoder().encode('--frame\r\n')
const HEADER_END = new TextEncoder().encode('\r\n\r\n')
const DECODER = new TextDecoder('latin1')
const decodeHeader = (bytes: Uint8Array) => DECODER.decode(bytes)

const fakeJpeg = (tag: number) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, tag, 0x11, 0x22, 0x33, 0xff, 0xd9])

/** Monta um buffer multipart com uma parte; opcionalmente SEM Content-Length. */
function multipart(jpeg: Uint8Array, withContentLength: boolean): Uint8Array {
  const head = withContentLength
    ? `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`
    : `--frame\r\nContent-Type: image/jpeg\r\n\r\n`
  const headBytes = new TextEncoder().encode(head)
  const tail = new TextEncoder().encode('\r\n--frame\r\n')
  const out = new Uint8Array(headBytes.length + jpeg.length + tail.length)
  out.set(headBytes, 0)
  out.set(jpeg, headBytes.length)
  out.set(tail, headBytes.length + jpeg.length)
  return out
}

describe('indexOfSeq', () => {
  it('encontra uma sequência binária', () => {
    const hay = new Uint8Array([1, 2, 3, 4, 5])
    expect(indexOfSeq(hay, new Uint8Array([3, 4]))).toBe(2)
    expect(indexOfSeq(hay, new Uint8Array([5]))).toBe(4)
    expect(indexOfSeq(hay, new Uint8Array([9]))).toBe(-1)
  })

  it('respeita o offset inicial', () => {
    const hay = new Uint8Array([1, 2, 1, 2])
    expect(indexOfSeq(hay, new Uint8Array([1, 2]), 2)).toBe(2)
    expect(indexOfSeq(hay, new Uint8Array([1, 2]), 3)).toBe(-1)
  })
})

describe('extractJpegFrame', () => {
  it('extrai frame com Content-Length', () => {
    const jpeg = fakeJpeg(0xab)
    const buf = multipart(jpeg, true)
    const range = extractJpegFrame(buf, BOUNDARY, HEADER_END, decodeHeader, BOUNDARY.length)
    expect(range).toBeTruthy()
    const frame = buf.subarray(range!.start, range!.end)
    expect(frame.length).toBe(jpeg.length)
    expect([...frame]).toEqual([...jpeg])
  })

  it('extrai frame SEM Content-Length varrendo até o próximo boundary (não emite frame vazio)', () => {
    const jpeg = fakeJpeg(0xcd)
    const buf = multipart(jpeg, false)
    const range = extractJpegFrame(buf, BOUNDARY, HEADER_END, decodeHeader, BOUNDARY.length)
    expect(range).toBeTruthy()
    const frame = buf.subarray(range!.start, range!.end)
    expect(frame.length).toBe(jpeg.length)
    expect([...frame]).toEqual([...jpeg])
  })

  it('retorna null enquanto o frame (com Content-Length) está incompleto', () => {
    const jpeg = fakeJpeg(0xef)
    const buf = multipart(jpeg, true)
    // Header completo mas payload JPEG parcial (truncado dentro do frame).
    const range = extractJpegFrame(buf, BOUNDARY, HEADER_END, decodeHeader, BOUNDARY.length)
    expect(range).toBeTruthy()
    const truncated = buf.subarray(0, range!.start + 3)
    const partial = extractJpegFrame(truncated, BOUNDARY, HEADER_END, decodeHeader, BOUNDARY.length)
    expect(partial).toBeNull()
  })

  it('retorna null enquanto não há header completo', () => {
    const buf = new TextEncoder().encode('--frame\r\nContent-Type: image/jpeg\r\n\r\n')
    // sem dados/headers completos
    const range = extractJpegFrame(buf, BOUNDARY, HEADER_END, decodeHeader, BOUNDARY.length)
    expect(range).toBeNull()
  })

  it('duas partes consecutivas: extrai ambas', () => {
    const a = fakeJpeg(0x01)
    const b = fakeJpeg(0x02)
    const bufA = multipart(a, true)
    const bufB = multipart(b, false)
    // bufA já termina com o boundary (`\r\n--frame\r\n`) que inicia a parte B;
    // o `--frame\r\n` inicial de bufB é removido.
    const combined = new Uint8Array(bufA.length + bufB.length - BOUNDARY.length)
    combined.set(bufA, 0)
    combined.set(bufB.subarray(BOUNDARY.length), bufA.length)

    const rangeA = extractJpegFrame(combined, BOUNDARY, HEADER_END, decodeHeader, BOUNDARY.length)
    expect(rangeA).toBeTruthy()
    expect([...combined.subarray(rangeA!.start, rangeA!.end)]).toEqual([...a])

    // Segunda parte começa no final da primeira (após o boundary consumido).
    const rangeB = extractJpegFrame(combined, BOUNDARY, HEADER_END, decodeHeader, rangeA!.end)
    expect(rangeB).toBeTruthy()
    expect([...combined.subarray(rangeB!.start, rangeB!.end)]).toEqual([...b])
  })

  it('remove o CRLF de fim de linha do payload quando não há Content-Length', () => {
    // Header sem Content-Length; o payload é seguido por \r\n--frame (simula
    // um servidor que não informa o tamanho).
    const jpeg = fakeJpeg(0x77)
    const head = new TextEncoder().encode('--frame\r\nContent-Type: image/jpeg\r\n\r\n')
    const payload = new Uint8Array([...jpeg, 0x0d, 0x0a])
    const boundary = new TextEncoder().encode('--frame\r\n')
    const buf = new Uint8Array(head.length + payload.length + boundary.length)
    buf.set(head, 0)
    buf.set(payload, head.length)
    buf.set(boundary, head.length + payload.length)

    const range = extractJpegFrame(buf, BOUNDARY, HEADER_END, decodeHeader, BOUNDARY.length)
    expect(range).toBeTruthy()
    expect([...buf.subarray(range!.start, range!.end)]).toEqual([...jpeg])
  })
})