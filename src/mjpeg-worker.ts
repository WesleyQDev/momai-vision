/**
 * MomAI Vision — MJPEG parser worker.
 *
 * Faz o fetch + parse do stream MJPEG (scan de boundaries) e o throttle
 * latest-frame-wins numa THREAD SEPARADA, fora do main thread do renderer
 * principal (que também roda a UI do MomAI). O main thread recebe os frames
 * (transferable — zero cópia no main), decodifica com createImageBitmap e
 * desenha no canvas.
 *
 * O canvas NUNCA é transferido (sem OffscreenCanvas): se este worker falhar
 * ao carregar, o caller cai no parser inline e o preview continua funcionando.
 *
 * Contrato de mensagens:
 *   main → worker:
 *     { type: 'start', url }
 *     { type: 'abort' }
 *     { type: 'get_frame' }                 // pede o frame JPEG mais recente (pump YOLO)
 *   worker → main:
 *     { type: 'frame', buffer }             // transferable — frame do preview (~20fps)
 *     { type: 'get_frame_response', buffer } // transferable — resposta ao get_frame
 *     { type: 'fps', fps }                  // 1x/s
 *     { type: 'error', message }
 */

import { extractJpegFrame, indexOfSeq } from './vision/mjpeg-parse'

type WorkerIncomingMessage =
  | { type: 'start'; url?: string }
  | { type: 'abort' }
  | { type: 'get_frame' }

type WorkerOutgoingMessage =
  | { type: 'frame'; buffer: ArrayBuffer }
  | { type: 'get_frame_response'; buffer: ArrayBuffer | null }
  | { type: 'fps'; fps: number }
  | { type: 'error'; message: string }
  | { type: 'ready' }

/** Escopo mínimo do DedicatedWorkerGlobalScope exposto como `self`. */
interface WorkerScope {
  postMessage(message: WorkerOutgoingMessage, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<WorkerIncomingMessage>) => void) | null
}

const scope = self as unknown as WorkerScope

const MAX_EMIT_INTERVAL = 42 // ~24fps (teto, não piso)
const BOUNDARY = new TextEncoder().encode('--frame\r\n')
const HEADER_END = new TextEncoder().encode('\r\n\r\n')
const DECODER = new TextDecoder('latin1')

let ac: AbortController | null = null
let currentFrame: Uint8Array | null = null // último frame do stream (para get_frame)
let lastFrame: Uint8Array | null = null // frame aguardando emissão (latest-wins)
let emitScheduled = false
let lastEmit = 0
let frameCount = 0
let fpsTs = 0

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function emitLatest(): void {
  emitScheduled = false
  if (!lastFrame) return
  const now = Date.now()
  const wait = lastEmit + MAX_EMIT_INTERVAL - now
  if (wait > 0) {
    emitScheduled = true
    setTimeout(emitLatest, wait)
    return
  }
  lastEmit = now
  const frame = lastFrame
  lastFrame = null
  // Cópia transferable: o buffer interno do concat não pode ser transferido
  // (o main pode estar decodificando um frame anterior do mesmo buffer) — 1
  // cópia por frame na thread do worker, zero cópia no main.
  const copy = frame.slice().buffer
  frameCount++
  const fpsNow = Date.now()
  if (fpsNow - fpsTs >= 1000) {
    scope.postMessage({ type: 'fps', fps: frameCount })
    frameCount = 0
    fpsTs = fpsNow
  }
  scope.postMessage({ type: 'frame', buffer: copy }, [copy])
}

function parse(buf: Uint8Array): Uint8Array {
  let idx = indexOfSeq(buf, BOUNDARY)
  while (idx !== -1) {
    const after = idx + BOUNDARY.length
    // Sem Content-Length o frame termina no próximo boundary (ver
    // vision/mjpeg-parse.ts) — antes emitia frame de 0 bytes e o
    // createImageBitmap quebrava.
    const range = extractJpegFrame(buf, BOUNDARY, HEADER_END, (bytes) => DECODER.decode(bytes), after)
    if (!range) break
    const frame = buf.subarray(range.start, range.end)
    lastFrame = frame
    currentFrame = frame
    if (!emitScheduled) {
      const now = Date.now()
      if (now - lastEmit >= MAX_EMIT_INTERVAL) {
        emitLatest()
      } else {
        emitScheduled = true
        setTimeout(emitLatest, MAX_EMIT_INTERVAL - (now - lastEmit))
      }
    }
    buf = buf.subarray(range.end)
    idx = indexOfSeq(buf, BOUNDARY)
  }
  return buf
}

async function run(url: string): Promise<void> {
  ac = new AbortController()
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { Accept: 'image/jpeg' } })
    if (!res.ok || !res.body) throw new Error(`Mjpeg stream HTTP ${res.status}`)
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let pending: Uint8Array = new Uint8Array(0)
    const flushToU8 = (): Uint8Array => {
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const out = new Uint8Array(total)
      let o = 0
      for (const c of chunks) {
        out.set(c, o)
        o += c.length
      }
      chunks.length = 0
      return out
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
      let joined: Uint8Array
      if (chunks.length === 1 && pending.length === 0) {
        joined = chunks[0]
        chunks.length = 0
      } else {
        joined = pending.length ? concatBytes(pending, flushToU8()) : flushToU8()
      }
      pending = parse(joined)
      if (pending.length > 5 * 1024 * 1024) {
        pending = new Uint8Array(0)
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }
}

scope.onmessage = (e: MessageEvent<WorkerIncomingMessage>) => {
  const msg = e.data
  if (msg.type === 'start') {
    if (ac) ac.abort()
    void run(String(msg.url || ''))
  } else if (msg.type === 'abort') {
    if (ac) ac.abort()
  } else if (msg.type === 'get_frame') {
    if (currentFrame) {
      const copy = currentFrame.slice().buffer
      scope.postMessage({ type: 'get_frame_response', buffer: copy }, [copy])
    } else {
      scope.postMessage({ type: 'get_frame_response', buffer: null })
    }
  }
}

// Ack de carregamento: postado quando o script avalia. O caller usa isto para
// saber que o worker REALMENTE carregou — se este ack não chegar (URL 404 em
// dev, etc.), o caller cai no parser inline automaticamente.
scope.postMessage({ type: 'ready' })
