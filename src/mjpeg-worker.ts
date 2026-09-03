/**
 * MomAI Vision — MJPEG parser & decoder worker.
 *
 * Faz o fetch + parse do stream MJPEG (scan de boundaries) e a decodificação
 * JPEG (`createImageBitmap`) numa THREAD SEPARADA (Web Worker), fora da UI thread.
 *
 * O `ImageBitmap` decodificado é transferido com zero-cópia para o thread principal,
 * onde o canvas apenas executa um blit instantâneo (<0.1ms).
 */

import { extractJpegFrame, indexOfSeq } from './vision/mjpeg-parse'

type WorkerIncomingMessage =
  | { type: 'start'; url?: string }
  | { type: 'abort' }
  | { type: 'get_frame' }

type WorkerOutgoingMessage =
  | { type: 'bitmap'; bitmap: ImageBitmap; origW: number; origH: number }
  | { type: 'frame'; buffer: ArrayBuffer }
  | { type: 'get_frame_response'; buffer: ArrayBuffer | null }
  | { type: 'fps'; fps: number }
  | { type: 'error'; message: string }
  | { type: 'ready' }

interface WorkerScope {
  postMessage(message: WorkerOutgoingMessage, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<WorkerIncomingMessage>) => void) | null
}

const scope = self as unknown as WorkerScope

const MAX_EMIT_INTERVAL = 33 // ~30fps estável (cadência VSync contra rajadas de rede)
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
let isDecoding = false

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

async function emitLatest(): Promise<void> {
  emitScheduled = false
  if (!lastFrame) return
  const now = Date.now()
  const wait = lastEmit + MAX_EMIT_INTERVAL - now
  if (wait > 0) {
    emitScheduled = true
    setTimeout(() => void emitLatest(), wait)
    return
  }
  lastEmit = now
  const frame = lastFrame
  lastFrame = null

  frameCount++
  const fpsNow = Date.now()
  if (fpsNow - fpsTs >= 1000) {
    const elapsedSec = Math.max(0.5, (fpsNow - fpsTs) / 1000)
    const measuredFps = Math.min(30, Math.round(frameCount / elapsedSec))
    scope.postMessage({ type: 'fps', fps: measuredFps })
    frameCount = 0
    fpsTs = fpsNow
  }

  if (typeof createImageBitmap === 'function') {
    isDecoding = true
    try {
      const blob = new Blob([frame as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
      const bitmap = await createImageBitmap(blob)
      const origW = bitmap.width
      const origH = bitmap.height
      scope.postMessage({ type: 'bitmap', bitmap, origW, origH }, [bitmap])
      return
    } catch {
      // fallback para buffer transferable
    } finally {
      isDecoding = false
    }
  }

  const copy = frame.slice().buffer
  scope.postMessage({ type: 'frame', buffer: copy }, [copy])
}

function parse(buf: Uint8Array): Uint8Array {
  let idx = indexOfSeq(buf, BOUNDARY)
  while (idx !== -1) {
    const after = idx + BOUNDARY.length
    const range = extractJpegFrame(buf, BOUNDARY, HEADER_END, (bytes) => DECODER.decode(bytes), after)
    if (!range) break
    const frame = buf.subarray(range.start, range.end)
    lastFrame = frame
    currentFrame = frame
    if (!emitScheduled && !isDecoding) {
      const now = Date.now()
      if (now - lastEmit >= MAX_EMIT_INTERVAL) {
        void emitLatest()
      } else {
        emitScheduled = true
        setTimeout(() => void emitLatest(), MAX_EMIT_INTERVAL - (now - lastEmit))
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

scope.postMessage({ type: 'ready' })

