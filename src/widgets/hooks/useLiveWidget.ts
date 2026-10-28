import { useCallback, useEffect, useRef, useState } from 'react'
import { extractJpegFrame, indexOfSeq } from '../../vision/mjpeg-parse'
import {
  buildWidgetStreamUrl,
  fetchWidgetCameraName,
  fetchWidgetCameraStatus,
  fetchWidgetFrame
} from '../services/widgetStream'

export type LiveStatus = 'idle' | 'connecting' | 'live' | 'polling' | 'error'

export function isNoActiveCameraError(error?: string): boolean {
  if (!error) return false
  return /unknown camera|não está selecionada|nenhuma câmera|no camera/i.test(error)
}

export interface LiveState {
  status: LiveStatus
  error: string
  activeCameraId: string
  cameraName: string
  canvasRef: { current: HTMLCanvasElement | null }
  retry: () => void
  isNoActiveCamera: boolean
}

const DRAW_THROTTLE_MS = 100
const STREAM_WATCHDOG_MS = 4000
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
export function useLiveWidget(requestedCameraId: string, isEditing: boolean): LiveState {
  const [activeCameraId, setActiveCameraId] = useState<string>(requestedCameraId || '')
  const [status, setStatus] = useState<LiveStatus>('idle')
  const [error, setError] = useState('')
  const [cameraName, setCameraName] = useState('')
  const [isNoActive, setIsNoActive] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const retry = useCallback(() => {
    setIsNoActive(false)
    setRetryToken((token) => token + 1)
  }, [])

  const currentCameraId = activeCameraId || requestedCameraId

  const refreshName = useCallback(async () => {
    if (!currentCameraId) return
    try {
      const name = await fetchWidgetCameraName(currentCameraId)
      if (name) setCameraName(name)
    } catch {}
  }, [currentCameraId])

  // Re-check cameras when extension finishes adding a camera, when tab becomes visible, or on focus/navigation
  useEffect(() => {
    if (isEditing) return

    const onRecheck = (e?: Event) => {
      const detail = (e as CustomEvent)?.detail
      if (detail?.name && !detail?.selectedCameras) {
        return
      }
      setIsNoActive(false)
      setRetryToken((t) => t + 1)
    }

    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && !document.hidden) {
        onRecheck()
      }
    }

    window.addEventListener('momai-vision:cameras-updated', onRecheck)
    window.addEventListener('storage', onRecheck)
    window.addEventListener('focus', onRecheck)
    window.addEventListener('momai_navigate', onRecheck)
    window.addEventListener('momai:sidebar-click', onRecheck)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      window.removeEventListener('momai-vision:cameras-updated', onRecheck)
      window.removeEventListener('storage', onRecheck)
      window.removeEventListener('focus', onRecheck)
      window.removeEventListener('momai_navigate', onRecheck)
      window.removeEventListener('momai:sidebar-click', onRecheck)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [isEditing])

  // While in no-active-camera state, poll smoothly to auto-start stream as soon as user adds/activates a camera
  useEffect(() => {
    if (isEditing || !isNoActive) return
    const timer = setInterval(() => {
      void fetchWidgetCameraStatus(requestedCameraId)
        .then((res) => {
          if (res.hasAnyCamera) {
            setIsNoActive(false)
            setRetryToken((t) => t + 1)
          }
        })
        .catch(() => {})
    }, 2500)
    return () => clearInterval(timer)
  }, [isEditing, isNoActive, requestedCameraId])

  useEffect(() => {
    if (!currentCameraId || isEditing) return

    const isTargetCamera = (targetId?: string) => {
      if (!targetId) return false
      const normTarget = targetId.toLowerCase().replace(/^ip:/, '').replace(/\/+$/, '')
      const normCam = currentCameraId.toLowerCase().replace(/^ip:/, '').replace(/\/+$/, '')
      return normTarget === normCam || normTarget.includes(normCam) || normCam.includes(normTarget)
    }

    const onUpdate = (e: Event) => {
      const detail = (e as CustomEvent)?.detail
      if (!detail) {
        void refreshName()
        return
      }
      if (isTargetCamera(detail.cameraId) || isTargetCamera(detail.oldId)) {
        if (detail.name && typeof detail.name === 'string') {
          setCameraName(detail.name.trim())
        } else {
          void refreshName()
        }
      }
    }

    window.addEventListener('momai-vision:cameras-updated', onUpdate)
    window.addEventListener('storage', onUpdate)
    return () => {
      window.removeEventListener('momai-vision:cameras-updated', onUpdate)
      window.removeEventListener('storage', onUpdate)
    }
  }, [currentCameraId, isEditing, refreshName])

  useEffect(() => {
    if (isEditing) {
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
      setIsNoActive(false)

      let targetId = requestedCameraId

      try {
        const camStatus = await fetchWidgetCameraStatus(targetId)
        if (cancelled) return

        if (!camStatus.hasAnyCamera) {
          setIsNoActive(true)
          setActiveCameraId('')
          setError('Nenhuma câmera ativa.')
          setStatus('error')
          return
        }

        if (camStatus.name) {
          setCameraName(camStatus.name)
        }

        // If the requested camera is active, keep it.
        // Otherwise (empty or missing/unknown), fall back to the first active camera.
        if (camStatus.isActive && targetId) {
          setActiveCameraId(targetId)
        } else if (camStatus.firstCameraId) {
          targetId = camStatus.firstCameraId
          setActiveCameraId(targetId)
        }
      } catch {
        if (!targetId) {
          setIsNoActive(true)
          setActiveCameraId('')
          setError('Nenhuma câmera ativa.')
          setStatus('error')
          return
        }
      }

      if (!targetId) {
        setIsNoActive(true)
        setActiveCameraId('')
        setError('Nenhuma câmera ativa.')
        setStatus('error')
        return
      }

      // Warmup validates the camera (selected, not paused) and paints the
      // first frame immediately while the stream connects.
      const maxWarmupTries = 4
      for (let i = 1; i <= maxWarmupTries; i++) {
        if (cancelled) return
        try {
          const first = await fetchWidgetFrame(targetId)
          if (cancelled) return
          await decodeDataUrlToCanvas(canvasRef.current, first.image)
          break
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (
            msg.includes('não está selecionada') ||
            msg.includes('paused') ||
            msg.includes('unknown camera') ||
            msg.includes('Nenhuma câmera') ||
            msg.includes('no camera')
          ) {
            if (!cancelled) {
              if (isNoActiveCameraError(msg)) {
                setIsNoActive(true)
              }
              setError(msg)
              setStatus('error')
            }
            return
          }
          if (i === maxWarmupTries) {
            // If warmup attempts were exhausted but camera is not paused/unselected,
            // don't halt in error — fall through to stream/polling so it connects
            // as soon as hardware/FFmpeg delivers.
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 600))
        }
      }
      if (cancelled) return

      const url = buildWidgetStreamUrl(targetId, Date.now())
      if (!url) {
        startPolling(targetId)
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
        if (!cancelled && !gotFrame) startPolling(targetId)
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
        startPolling(targetId)
      }
    }

    function startPolling(pollTargetId: string): void {
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
          const { image } = await fetchWidgetFrame(pollTargetId)
          if (cancelled) return
          failures = 0
          setError('')
          setStatus('polling')
          await decodeDataUrlToCanvas(canvasRef.current, image)
        } catch (err) {
          failures += 1
          const msg = err instanceof Error ? err.message : 'Capture failed.'
          if (isNoActiveCameraError(msg) || failures >= MAX_POLL_FAILURES) {
            if (!cancelled) {
              if (isNoActiveCameraError(msg)) {
                setIsNoActive(true)
              }
              setError(msg)
              setStatus('error')
            }
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
  }, [requestedCameraId, isEditing, retryToken])

  return {
    status,
    error,
    activeCameraId,
    cameraName,
    canvasRef,
    retry,
    isNoActiveCamera: isNoActive || (!activeCameraId && !requestedCameraId && status === 'error') || isNoActiveCameraError(error)
  }
}
