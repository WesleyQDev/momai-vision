/**
 * MomAI Vision — panel (compact status + floating overlay alert card).
 *
 * The same `vision_alert` renderer serves two contexts: the floating
 * overlay window (open_overlay) and chat cards (structuredResponse).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getSDK } from 'momai:sdk'
import { ptLabel, triggerLabel } from './vision/labels'

const sdk = getSDK()
const EXT_ID = 'momai-vision'

interface Detection {
  className: string
  confidence: number
  x1: number
  y1: number
  x2: number
  y2: number
}

interface AlertData {
  cameraId?: string
  cameraName?: string
  monitorId?: string
  monitorLabel?: string
  triggeredBy?: string
  className?: string
  confidence?: number
  boxes?: Detection[]
  snapshotId?: string
  ts?: number
  description?: string
  imageDataUri?: string
  onClose?: () => void
}

const CLASS_COLORS = [
  '#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899',
  '#14b8a6', '#f97316', '#84cc16', '#06b6d4'
]

function classColor(className: string): string {
  let hash = 0
  for (const ch of className) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return CLASS_COLORS[hash % CLASS_COLORS.length]
}

export function AlertCanvasOverlay({
  imageDataUri,
  boxes,
  objectFit = 'object-cover',
  className = ''
}: {
  imageDataUri?: string
  boxes?: Detection[]
  objectFit?: 'object-cover' | 'object-contain'
  className?: string
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  const draw = useCallback(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!container || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const cw = container.clientWidth || container.offsetWidth
    const ch = container.clientHeight || container.offsetHeight
    if (!cw || !ch) return

    canvas.width = cw
    canvas.height = ch
    ctx.clearRect(0, 0, cw, ch)

    if (!boxes || boxes.length === 0) return

    const iw = img?.naturalWidth || 0
    const ih = img?.naturalHeight || 0

    let ox = 0
    let oy = 0
    let dw = cw
    let dh = ch

    if (iw && ih) {
      if (objectFit === 'object-contain') {
        const scale = Math.min(cw / iw, ch / ih)
        dw = iw * scale
        dh = ih * scale
        ox = (cw - dw) / 2
        oy = (ch - dh) / 2
      } else {
        const scale = Math.max(cw / iw, ch / ih)
        dw = iw * scale
        dh = ih * scale
        ox = (cw - dw) / 2
        oy = (ch - dh) / 2
      }
    }

    for (const box of boxes) {
      const x1 = ox + box.x1 * dw
      const y1 = oy + box.y1 * dh
      const x2 = ox + box.x2 * dw
      const y2 = oy + box.y2 * dh
      const color = classColor(box.className)
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1)
      ctx.fillStyle = color
      ctx.fillRect(x1, Math.max(0, y1 - 20), Math.min(cw - x1, x2 - x1), 18)
      ctx.fillStyle = '#0a0a0a'
      ctx.font = 'bold 12px sans-serif'
      ctx.fillText(
        `${ptLabel(box.className)} ${Math.round(box.confidence * 100)}%`,
        x1 + 4,
        Math.max(0, y1 - 6)
      )
    }
  }, [boxes, objectFit])

  useEffect(() => {
    draw()
    const handleResize = () => draw()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [draw])

  return (
    <div ref={containerRef} className={`relative w-full h-full bg-black overflow-hidden ${className}`}>
      {imageDataUri ? (
        <img
          ref={imgRef}
          src={imageDataUri}
          alt="Snapshot"
          onLoad={draw}
          className={`absolute inset-0 w-full h-full ${objectFit}`}
        />
      ) : null}
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none z-10" />
    </div>
  )
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const dateStr = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const timeStr = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return `${dateStr} ${timeStr}`
}

function VisionIcon({ className = 'w-5 h-5' }: { className?: string }): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 12c2.1-4.3 5.6-6.5 9.5-6.5s7.4 2.2 9.5 6.5c-2.1 4.3-5.6 6.5-9.5 6.5S4.6 16.3 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
      <path d="M17.6 4.9v3.2M16 6.5h3.2" />
    </svg>
  )
}

async function pauseMonitor(monitorId: string | undefined, onClose?: () => void): Promise<void> {
  if (!monitorId) return
  // Fechar o overlay DESTRÓI a janela do overlay (Electron), o que abortaria um
  // fetch comum ainda em andamento e a pausa nunca chegaria ao servidor.
  // keepalive mantém o request vivo mesmo com a janela fechando em seguida.
  const baseUrl = (window as any).api?.getApiBaseUrl?.() || 'http://127.0.0.1:8000'
  const token = (window as any).api?.getSessionToken?.() || ''
  void fetch(`${baseUrl}/extensions/${EXT_ID}/command`, {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-Session-Token': token },
    body: JSON.stringify({ toolName: 'pause_monitoring', args: { monitorId } })
  }).catch(() => {})
  // Fecha o overlay imediatamente; a pausa continua em segundo plano.
  onClose?.()
}

function VisionAlertCard({ data }: { data?: AlertData }): JSX.Element {
  const [stopping, setStopping] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const isOverlay = typeof data?.onClose === 'function'
  const isSnapshot = data?.triggeredBy === 'snapshot'

  // In the floating overlay, "ampliar" re-opens the window sized to the
  // photo's real aspect ratio (measured from the frame) so the image fills the
  // whole window edge-to-edge — no black bars. In chat it just enlarges the card.
  const toggleExpand = () => {
    const next = !expanded
    setExpanded(next)
    if (!isOverlay || typeof (window as any).api?.openOverlay !== 'function') return
    const { onClose: _ignored, ...cleanData } = (data || {}) as AlertData
    const resize = (aspect: number) => {
      const maxW = 1280
      const maxH = 720
      const screenW = window.screen?.availWidth || maxW
      const screenH = window.screen?.availHeight || maxH
      let w = Math.min(maxW, screenW - 40)
      let h = Math.round(w / aspect)
      if (h > Math.min(maxH, screenH - 80)) {
        h = Math.max(240, Math.min(maxH, screenH - 80))
        w = Math.round(h * aspect)
      }
      ;(window as any).api.openOverlay({
        skillId: EXT_ID,
        panel: 'dist/panel.js',
        panelType: 'extension-panel',
        overlaySize: { width: w, height: h },
        strategy: 'replace',
        structuredResponse: { type: 'vision_alert', data: cleanData }
      })
    }
    if (!next) {
      ;(window as any).api.openOverlay({
        skillId: EXT_ID,
        panel: 'dist/panel.js',
        panelType: 'extension-panel',
        overlaySize: { width: 480, height: 560 },
        strategy: 'replace',
        structuredResponse: { type: 'vision_alert', data: cleanData }
      })
      return
    }
    // Measure the actual frame aspect so the window matches it (no bars/crop).
    if (data?.imageDataUri) {
      const img = new Image()
      img.onload = () => {
        const aspect =
          img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 16 / 9
        resize(aspect)
      }
      img.onerror = () => resize(16 / 9)
      img.src = data.imageDataUri
    } else {
      resize(16 / 9)
    }
  }

  if (expanded && isOverlay) {
    return (
      <div
        className="fixed inset-0 z-50 bg-black select-none"
        style={{ WebkitAppRegion: 'drag' } as any}
      >
        {data?.imageDataUri ? (
          <AlertCanvasOverlay
            imageDataUri={data.imageDataUri}
            boxes={data.boxes}
            objectFit="object-contain"
          />
        ) : (
          <p className="text-sm text-gray-400">Sem imagem.</p>
        )}
        <button
          onClick={toggleExpand}
          className="absolute top-3 right-3 rounded-full bg-black/60 hover:bg-black/80 text-gray-300 p-2 z-20"
          style={{ WebkitAppRegion: 'no-drag' } as any}
          aria-label="Reduzir print"
          title="Reduzir print"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
          </svg>
        </button>
      </div>
    )
  }

  if (isSnapshot && !expanded) {
    return (
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-zinc-900/95 text-gray-100 shadow-lg overflow-hidden">
        <div className="relative w-full aspect-video bg-black overflow-hidden shrink-0" style={{ aspectRatio: '16 / 9' }}>
          <AlertCanvasOverlay
            imageDataUri={data.imageDataUri}
            boxes={data.boxes}
            objectFit="object-cover"
          />
        </div>
      </div>
    )
  }

  const title = data?.cameraName || 'MomAI Vision'
  const subtitle = data?.className
    ? `${data.cameraName || 'Câmera'} · ${ptLabel(data.className)}${data.confidence ? ` ${Math.round(data.confidence * 100)}%` : ''}`
    : isSnapshot
      ? 'Snapshot'
      : data?.cameraName || ''

  return (
    <div
      className={`w-full ${expanded && isOverlay ? '' : 'max-w-md'} rounded-xl border border-white/10 bg-zinc-900/95 text-gray-100 shadow-lg overflow-hidden`}
      style={isOverlay ? ({ WebkitAppRegion: 'no-drag' } as any) : undefined}
    >
      {/* Header doubles as the drag handle in the floating overlay window. */}
      <div
        className="flex items-center justify-between px-4 py-2.5 bg-zinc-800/70"
        style={isOverlay ? ({ WebkitAppRegion: 'drag' } as any) : undefined}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-gray-400">
            <VisionIcon className="w-5 h-5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{title}</p>
            <p className="text-xs text-gray-400 truncate">{subtitle || formatTime(data?.ts)}</p>
          </div>
        </div>
        <div
          className="flex items-center gap-1 shrink-0"
          style={isOverlay ? ({ WebkitAppRegion: 'no-drag' } as any) : undefined}
        >
          {data?.imageDataUri ? (
            <button
              onClick={toggleExpand}
              className="rounded-full p-1.5 text-gray-400 hover:bg-white/10 hover:text-white transition-colors"
              title={expanded ? 'Reduzir print' : 'Ampliar print'}
              aria-label={expanded ? 'Reduzir print' : 'Ampliar print'}
            >
              {expanded ? (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
                </svg>
              ) : (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                </svg>
              )}
            </button>
          ) : null}
          {isOverlay ? (
            <button
              onClick={data?.onClose}
              className="rounded-full p-1.5 text-gray-400 hover:bg-white/10 hover:text-white transition-colors"
              aria-label="Fechar"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      {data?.imageDataUri ? (
        <div
          className="relative w-full bg-black overflow-hidden shrink-0 cursor-pointer"
          style={
            expanded
              ? isOverlay
                ? { aspectRatio: '16 / 9', width: '100%', maxHeight: 'calc(100vh - 170px)', ...(isOverlay ? { WebkitAppRegion: 'no-drag' } : {}) }
                : { height: '58vh' }
              : { aspectRatio: '16 / 9', ...(isOverlay ? { WebkitAppRegion: 'no-drag' } : {}) }
          }
          onClick={toggleExpand}
          title={expanded ? 'Reduzir print' : 'Ampliar print'}
        >
          <AlertCanvasOverlay
            imageDataUri={data.imageDataUri}
            boxes={data.boxes}
            objectFit={expanded ? 'object-contain' : 'object-cover'}
          />
        </div>
      ) : null}

      <div
        className="px-4 py-3"
        style={isOverlay ? ({ WebkitAppRegion: 'no-drag' } as any) : undefined}
      >
        <p className="text-sm text-gray-300">
          {data?.description || (isSnapshot ? 'Snapshot capturado' : 'Alerta da câmera')}
        </p>
        {data?.triggeredBy && !isSnapshot ? (
          <p className="mt-1 text-xs text-gray-500">{formatTime(data.ts)} · {triggerLabel(data)}</p>
        ) : null}
        <div
          className="mt-3 flex gap-2"
          style={isOverlay ? ({ WebkitAppRegion: 'no-drag' } as any) : undefined}
        >
          <button
            onClick={() => {
              const api = (window as any).api || (window as any).momaiAPI
              if (typeof api?.focus === 'function') {
                api.focus()
              } else if (typeof api?.send === 'function') {
                api.send('window-focus')
              }
              data?.onClose?.()
            }}
            className="flex-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white text-xs font-medium py-2 transition-colors cursor-pointer"
            style={isOverlay ? ({ WebkitAppRegion: 'no-drag' } as any) : undefined}
          >
            Abrir MomAI
          </button>
          {data?.monitorId ? (
            <button
              disabled={stopping}
              onClick={() => {
                setStopping(true)
                void pauseMonitor(data.monitorId, data.onClose).catch(() => setStopping(false))
              }}
              className="flex-1 rounded-lg border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 hover:border-amber-400 text-xs font-medium py-2 transition-colors disabled:opacity-50 cursor-pointer flex items-center justify-center gap-1.5"
              style={isOverlay ? ({ WebkitAppRegion: 'no-drag' } as any) : undefined}
            >
              <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
              </svg>
              {stopping ? 'Pausando...' : 'Pausar monitoramento'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

sdk.registry.registerRenderer('vision_alert', VisionAlertCard)

export { VisionAlertCard }

interface Status {
  monitors?: Array<{ id: string; cameraName?: string; triggers?: Array<{ type: string }>; createdAt?: number }>
  cameras?: Record<string, { online: boolean; monitors: number }>
}

export default function VisionPanel(props: { data?: unknown }): JSX.Element {
  const [status, setStatus] = useState<Status | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = () =>
      sdk.api
        .post<Status>(`/extensions/${EXT_ID}/command`, { toolName: 'get_status', args: {} })
        .then((res) => {
          if (!cancelled && res.ok && res.data) setStatus(res.data)
        })
    void load()
    const interval = setInterval(() => void load(), 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const monitors = status?.monitors || []
  const cameras = status?.cameras || {}
  const onlineCount = Object.values(cameras).filter((c) => c.online).length

  return (
    <div className="w-full rounded-2xl border border-white/10 bg-zinc-900/95 text-gray-100 p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-emerald-400">
          <VisionIcon />
        </span>
        <h3 className="text-sm font-semibold">MomAI Vision</h3>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="rounded-xl bg-white/5 p-3">
          <p className="text-lg font-bold text-emerald-400">{Object.keys(cameras).length}</p>
          <p className="text-xs text-gray-400">câmeras ({onlineCount} online)</p>
        </div>
        <div className="rounded-xl bg-white/5 p-3">
          <p className="text-lg font-bold text-emerald-400">{monitors.length}</p>
          <p className="text-xs text-gray-400">monitors ativos</p>
        </div>
      </div>
      {monitors.length > 0 ? (
        <ul className="space-y-1.5">
          {monitors.map((m) => (
            <li key={m.id} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium truncate">{m.cameraName || m.id}</p>
                <p className="text-[11px] text-gray-400">
                  {m.triggers?.map((t) => t.type).join(', ') || '—'}
                </p>
              </div>
              <span className="ml-2 shrink-0 w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-gray-400">Nenhum monitor ativo.</p>
      )}
    </div>
  )
}
