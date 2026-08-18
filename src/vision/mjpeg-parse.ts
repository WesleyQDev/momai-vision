/**
 * Parser MJPEG multipart — extração de frames (pura e testável).
 *
 * Compartilhado entre o Web Worker (`src/mjpeg-worker.ts`) e o parser inline
 * da página (`src/page.tsx`). Antes cada um tinha a própria cópia da lógica;
 * o bug comum: quando o header da parte NÃO traz `Content-Length`, o parser
 * emitia um frame de 0 bytes (length = 0) que quebrava o `createImageBitmap`.
 * Aqui, sem `Content-Length`, o frame termina no próximo boundary.
 */

/** Busca binária de uma sequência (primeiro byte via indexOf nativo). */
export function indexOfSeq(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from
  const first = needle[0]
  const last = hay.length - needle.length
  let i = from
  while (i <= last) {
    const hit = hay.indexOf(first, i)
    if (hit === -1 || hit > last) return -1
    let j = 1
    while (j < needle.length && hay[hit + j] === needle[j]) j++
    if (j === needle.length) return hit
    i = hit + 1
  }
  return -1
}

export interface JpegFrameRange {
  /** Início do payload JPEG (depois do fim dos headers). */
  start: number
  /** Fim exclusivo do payload JPEG. */
  end: number
}

/**
 * Extrai um frame JPEG completo do buffer, a partir de `from` (a posição logo
 * após um boundary). Retorna null enquanto o frame estiver incompleto.
 *
 * Com `Content-Length: N` o payload é exatamente `[dataStart, dataStart+N)`.
 * Sem `Content-Length` (ou com N inválido), o payload termina no próximo
 * boundary — CRLF de fim de linha do boundary é removido do payload.
 */
export function extractJpegFrame(
  buf: Uint8Array,
  boundary: Uint8Array,
  headerEnd: Uint8Array,
  decodeHeader: (bytes: Uint8Array) => string,
  from = 0
): JpegFrameRange | null {
  const hEnd = indexOfSeq(buf, headerEnd, from)
  if (hEnd === -1) return null
  const header = decodeHeader(buf.subarray(from, hEnd))
  const dataStart = hEnd + headerEnd.length

  const clMatch = /content-length:\s*(\d+)/i.exec(header)
  if (clMatch && Number(clMatch[1]) > 0) {
    const length = Number(clMatch[1])
    if (buf.length < dataStart + length) return null
    return { start: dataStart, end: dataStart + length }
  }

  // Sem Content-Length: o frame vai até o próximo boundary.
  const nextBoundary = indexOfSeq(buf, boundary, dataStart)
  if (nextBoundary === -1) return null
  let end = nextBoundary
  while (end > dataStart && (buf[end - 1] === 0x0d || buf[end - 1] === 0x0a)) end--
  return { start: dataStart, end }
}