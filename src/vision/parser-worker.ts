/**
 * MJPEG parser worker client.
 *
 * The worker (src/mjpeg-worker.ts, built to dist/mjpeg-worker.js) does the
 * fetch + boundary parse + decode on a separate thread; frames reach the main
 * thread via postMessage transferable. The canvas is never transferred: if the
 * worker script fails to load (URL not resolved in dev, etc.) `createParserWorker`
 * returns null and the caller falls back to the inline reader — no burned canvas
 * and no endless "starting camera".
 */

export interface ParserWorker {
  start(url: string): void
  stop(): void
  reset?(): void
  getFrame(): Promise<Uint8Array | null>
  dispose(): void
  /** true quando o script do worker carregou (ack 'ready' recebido). */
  isReady(): boolean
}

export function createParserWorker(opts: {
  onBitmap?: (bitmap: ImageBitmap, origW: number, origH: number) => void
  onFrame?: (frame: Uint8Array) => void
  onError?: () => void
  onFps?: (fps: number) => void
  onKbs?: (kbs: number) => void
}): ParserWorker | null {
  if (typeof Worker === 'undefined') return null
  let worker: Worker
  try {
    // Em prod o worker está em dist/mjpeg-worker.js; em dev (symlink) o
    // electron.vite.config.ts agora serve o raw de src/mjpeg-worker.ts para
    // este path, garantindo que o parse e o decode saiam do main thread.
    worker = new Worker(new URL('./mjpeg-worker.js', import.meta.url), { type: 'module' })
  } catch {
    return null
  }

  let disposed = false
  let ready = false
  let pendingFrame: { resolve: (v: Uint8Array | null) => void; timer: ReturnType<typeof setTimeout> } | null = null

  worker.onmessage = (e: MessageEvent) => {
    if (disposed) return
    const msg = e.data
    switch (msg?.type) {
      case 'ready':
        // Ack de carregamento: o script avaliou e o worker está vivo.
        ready = true
        break
      case 'bitmap':
        if (msg.bitmap) opts.onBitmap?.(msg.bitmap, Number(msg.origW) || 0, Number(msg.origH) || 0)
        break
      case 'frame':
        if (msg.buffer) opts.onFrame?.(new Uint8Array(msg.buffer))
        break
      case 'get_frame_response':
        if (pendingFrame) {
          clearTimeout(pendingFrame.timer)
          const p = pendingFrame
          pendingFrame = null
          p.resolve(msg.buffer ? new Uint8Array(msg.buffer) : null)
        }
        break
      case 'fps':
        opts.onFps?.(Number(msg.fps) || 0)
        if (typeof msg.kbs === 'number') {
          opts.onKbs?.(msg.kbs)
        }
        break
      case 'error':
        opts.onError?.()
        break
    }
  }

  // O `new Worker` não lança quando a URL não resolve (ex.: mjpeg-worker.js
  // não servido pelo Vite em dev): o erro é assíncrono. Sinalizamos que o
  // worker NÃO está pronto para o caller cair no parser inline.
  worker.onerror = () => {
    ready = false
  }

  return {
    start: (url: string) => {
      if (!disposed) worker.postMessage({ type: 'start', url })
    },
    stop: () => {
      if (!disposed) {
        try {
          worker.postMessage({ type: 'abort' })
        } catch {}
      }
    },
    reset: () => {
      if (!disposed) {
        try {
          worker.postMessage({ type: 'reset' })
        } catch {}
      }
    },
    getFrame: () =>
      new Promise<Uint8Array | null>((resolve) => {
        if (disposed || pendingFrame || !ready) {
          resolve(null)
          return
        }
        const timer = setTimeout(() => {
          if (pendingFrame) {
            pendingFrame.resolve(null)
            pendingFrame = null
          }
        }, 2000)
        pendingFrame = { resolve, timer }
        worker.postMessage({ type: 'get_frame' })
      }),
    isReady: () => ready && !disposed,
    dispose: () => {
      disposed = true
      try {
        worker.postMessage({ type: 'abort' })
      } catch {}
      worker.terminate()
      if (pendingFrame) {
        clearTimeout(pendingFrame.timer)
        pendingFrame.resolve(null)
        pendingFrame = null
      }
    }
  }
}
