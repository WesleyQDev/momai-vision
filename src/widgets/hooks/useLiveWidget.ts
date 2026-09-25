import { useCallback, useEffect, useRef, useState } from 'react'
import { extractJpegFrame, indexOfSeq } from '../../vision/mjpeg-parse'
import {
  buildWidgetStreamUrl,
  fetchWidgetCameraName,
  fetchWidgetFrame
} from '../services/widgetStream'

export type LiveStatus = 'idle' | 'connecting' | 'live' | 'polling' | 'error'

interface LiveState {
  status: LiveStatus
  error: string
  cameraName: string
  canvasRef: { current: HTMLCanvasElement | null }
  retry: () => void
}

const DRAW_THROTTLE_MS = 100
const STREAM_WATCHDOG_MS = 12000
const POLL_MS = 1000
const MAX_POLL_FAILURES = 5

function drawToCanvas(
  canvas: HTMLCanvasElement | null,
  source: CanvasImageSource,
  width: number,
  height: number
): void {
  if (!canvas || width <= 0 || height <= 0) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  try {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    ctx.drawImage(source, 0, 0, width, height)
  } catch {}
}

function decodeDataUrlToCanvas(canvas: HTMLCanvasElement | null, dataUrl: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const img = new Image()
      img.onload = () => {
        drawToCanvas(canvas, img, img.naturalWidth || 0, img.naturalHeight || 0)
        resolve()
      }
      img.onerror = () => resolve()
      img.src = dataUrl
    } catch {
      resolve()
    }
  })
}

/**
 * Live MJPEG video for the widget, same stream the tab cards consume.
 * Falls back to get_frame polling when the stream is unreachable, and
 * surfaces backend errors (camera not selected, paused) instead of a
 * silent empty frame.
 */
export function useLiveWidget(cameraId: string, isEditing: boolean): LiveState {
  const [status, setStatus] = useState<LiveStatus>('idle')
  const [error, setError] = useState('')
  const [cameraName, setCameraName] = useState('')
  const [retryToken, setRetryToken] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const retry = useCallback(() => {
    setRetryToken((token) => token + 1)
  }, [])

  useEffect(() => {
    if (!cameraId || isEditing) {
      setStatus('idle')
      return
    }
    let cancelled = false
    const aborters: Array<() => void> = []
    const onCancel = (fn: () => void) => {
      aborters.push(fn)
    }

    async function run(): Promise<void> {
      setStatus('connecting')
      setError('')

      try {
        const name = await fetchWidgetCameraName(cameraId)
        if (!cancelled && name) setCameraName(name)
      } catch {
        if (!cancelled) setCameraName(cameraId)
      }
      if (cancelled) return

      // Warmup validates the camera (selected, not paused) and paints the
      // first frame immediately while the stream connects.
      try {
        const first = await fetchWidgetFrame(cameraId)
        if (cancelled) return
        await decodeDataUrlToCanvas(canvasRef.current, first.image)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Capture failed.')
          setStatus('error')
        }
        return
      }
      if (cancelled) return

      const url = buildWidgetStreamUrl(cameraId, Date.now())
      if (!url) {
        startPolling()
        return
      }

      const aborter = new AbortController()
      onCancel(() => {
        try {
          aborter.abort()
        } catch {}
      })

      const BOUNDARY = new TextEncoder().encode('--frame\r\n')
      const HEADER_END = new TextEncoder().encode('\r\n\r\n')
      const DECODER = new TextDecoder('latin1')
      let pending = new Uint8Array(0)
      let queued: Uint8Array | null = null
      let drawing = false
      let lastDraw = 0
      let gotFrame = false

      const drawQueued = async (): Promise<void> => {
        const next = queued
        queued = null
        if (!next || cancelled) {
          drawing = false
          return
        }
        lastDraw = Date.now()
        try {
          const bitmap = await createImageBitmap(
            new Blob([next as BlobPart], { type: 'image/jpeg' })
          )
          if (!cancelled) {
            gotFrame = true
            setStatus('live')
            drawToCanvas(canvasRef.current, bitmap, bitmap.width, bitmap.height)
          }
          try {
            bitmap.close()
          } catch {}
        } catch {}
        if (cancelled) {
          drawing = false
          return
        }
        if (queued) {
          const wait = DRAW_THROTTLE_MS - (Date.now() - lastDraw)
          setTimeout(() => void drawQueued(), Math.max(0, wait))
        } else {
          drawing = false
        }
      }

      const scheduleDraw = (bytes: Uint8Array) => {
        queued = bytes
        if (drawing) return
        drawing = true
        void drawQueued()
      }

      const watchdog = setTimeout(() => {
        if (!cancelled && !gotFrame) startPolling()
      }, STREAM_WATCHDOG_MS)
      onCancel(() => clearTimeout(watchdog))

      try {
        const res = await fetch(url, { signal: aborter.signal })
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`)
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done || cancelled) break
          const chunk = new Uint8Array(pending.length + value.length)
          chunk.set(pending)
          chunk.set(value, pending.length)
          pending = chunk
          let last: Uint8Array | null = null
          for (;;) {
            const at = indexOfSeq(pending, BOUNDARY)
            if (at === -1) break
            const range = extractJpegFrame(
              pending,
              BOUNDARY,
              HEADER_END,
              (bytes) => DECODER.decode(bytes),
              at + BOUNDARY.length
            )
            if (!range) break
            last = pending.slice(range.start, range.end)
            pending = pending.slice(range.end)
          }
          if (last && !cancelled) scheduleDraw(last)
        }
        throw new Error('stream ended')
      } catch (err) {
        if (cancelled) return
        if ((err as Error)?.name === 'AbortError') return
        startPolling()
      }
    }

    function startPolling(): void {
      if (cancelled) return
      setStatus('polling')
      let failures = 0
      let timer: ReturnType<typeof setTimeout> | null = null
      onCancel(() => {
        if (timer) clearTimeout(timer)
      })
      const poll = async (): Promise<void> => {
        if (cancelled) return
        try {
          const { image } = await fetchWidgetFrame(cameraId)
          if (cancelled) return
          failures = 0
          await decodeDataUrlToCanvas(canvasRef.current, image)
        } catch (err) {
          failures += 1
          if (failures >= MAX_POLL_FAILURES && !cancelled) {
            setError(err instanceof Error ? err.message : 'Capture failed.')
            setStatus('error')
            return
          }
        }
        if (!cancelled) timer = setTimeout(() => void poll(), POLL_MS)
      }
      void poll()
    }

    void run()
    return () => {
      cancelled = true
      for (const fn of aborters) {
        try {
          fn()
        } catch {}
      }
    }
  }, [cameraId, isEditing, retryToken])

  return { status, error, cameraName, canvasRef, retry }
}
