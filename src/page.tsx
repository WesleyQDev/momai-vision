/**
 * MomAI Vision — dashboard page.
 *
 * Camera grid with live preview (webcam getUserMedia + IP/MJPEG), bounding
 * boxes drawn on a transparent canvas over each video, alerts feed, print
 * gallery and settings. Detection data comes from the worker through the
 * extension command routes and SSE events.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getSDK } from 'momai:sdk'
import { ptLabel, PT_CLASS } from './vision/labels'
import { AlertCanvasOverlay } from './panel'

const sdk = getSDK()
const EXT_ID = 'momai-vision'

interface CameraInfo {
  id: string
  name: string
  source: 'webcam' | 'ip'
  online: boolean
  monitors: number
}

interface MonitorInfo {
  id: string
  cameraId: string
  cameraName?: string
  triggers: Array<{ type: string }>
  schedule?: { days?: number[]; start?: string; end?: string }
  label?: string
  createdAt?: number
  lastAlertTs?: number
}

interface Alert {
  cameraId?: string
  cameraName?: string
  monitorId?: string
  triggeredBy?: string
  className?: string
  confidence?: number
  boxes?: Detection[]
  snapshotId?: string
  ts?: number
  description?: string
  imageDataUri?: string
}

interface Detection {
  className: string
  confidence: number
  x1: number
  y1: number
  x2: number
  y2: number
}

interface Snapshot {
  id: string
  cameraId: string
  ts: number
  trigger?: string
  description?: string
  imageDataUri?: string
}

interface VisionConfig {
  retentionDays?: number
  maxSnapshots?: number
  trackingMode?: 'fluid' | 'balanced' | 'economy'
  selectedCameras?: string[]
}

const CLASS_COLORS = [
  '#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899',
  '#14b8a6', '#f97316', '#84cc16', '#06b6d4'
]

export function VisionIcon({ className = 'w-6 h-6' }: { className?: string }): JSX.Element {
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

function classColor(className: string): string {
  let hash = 0
  for (const ch of className) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return CLASS_COLORS[hash % CLASS_COLORS.length]
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const dateStr = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const timeStr = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return `${dateStr} ${timeStr}`
}

async function command<T = unknown>(toolName: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await sdk.api.post<{ ok: boolean; error?: string } & T>(
    `/extensions/${EXT_ID}/command`,
    { toolName, args }
  )
  if (!res.ok || res.data?.ok === false) {
    throw new Error(res.error || res.data?.error || `command failed: ${toolName}`)
  }
  return res.data as T
}

const PUMP_INTERVALS: Record<string, number> = { fluid: 500, balanced: 1000, economy: 2000 }

interface CustomSelectOption<T extends string = string> {
  value: T
  label: string
  icon?: React.ReactNode
  disabled?: boolean
  badge?: string
}

function CustomSelect<T extends string = string>({
  value,
  onChange,
  options,
  placeholder = 'Selecione...',
  className = '',
  size = 'md',
  direction = 'down'
}: {
  value: T
  onChange: (val: T) => void
  options: CustomSelectOption<T>[]
  placeholder?: string
  className?: string
  size?: 'sm' | 'md'
  direction?: 'up' | 'down'
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('keydown', handleKeyDown)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  const selectedOption = options.find((o) => o.value === value)

  const popoverPositionClass = direction === 'up'
    ? 'bottom-full mb-1.5'
    : 'top-full mt-1.5'

  return (
    <div className={`relative inline-block text-left ${open ? 'z-40' : 'z-10'} ${className}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-zinc-900/90 text-gray-200 hover:bg-white/10 hover:border-white/20 transition-all font-medium select-none shadow-md backdrop-blur-md active:scale-[0.99] ${
          size === 'sm' ? 'px-2.5 py-1.5 text-[11px]' : 'px-3.5 py-2.5 text-xs'
        }`}
      >
        <span className="flex items-center gap-2 truncate">
          {selectedOption?.icon}
          <span className="truncate">{selectedOption?.label || placeholder}</span>
        </span>
        <svg
          className={`w-3.5 h-3.5 text-gray-400 shrink-0 transition-transform duration-200 ${open ? 'rotate-180 text-emerald-400' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className={`absolute left-0 right-0 z-50 rounded-xl border border-white/15 bg-zinc-900/95 backdrop-blur-xl shadow-2xl overflow-hidden py-1 animate-fadeIn max-h-56 overflow-y-auto ${popoverPositionClass}`}>
          {options.map((opt) => {
            const isSelected = opt.value === value
            const isDisabled = !!opt.disabled
            return (
              <button
                key={opt.value}
                type="button"
                disabled={isDisabled}
                onClick={() => {
                  if (isDisabled) return
                  onChange(opt.value)
                  setOpen(false)
                }}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors ${
                  isDisabled
                    ? 'opacity-40 cursor-not-allowed text-gray-500 bg-transparent'
                    : isSelected
                    ? 'bg-emerald-500/20 text-emerald-300 font-semibold'
                    : 'text-gray-300 hover:bg-white/10 hover:text-white'
                }`}
              >
                <span className="flex items-center gap-2 truncate">
                  {opt.icon}
                  <span className="truncate">{opt.label}</span>
                </span>
                <span className="flex items-center gap-1.5 shrink-0">
                  {opt.badge && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/5 border border-white/10 text-gray-400 font-normal">
                      {opt.badge}
                    </span>
                  )}
                  {isSelected && (
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Camera Card with Live Preview & Top Header Bar (Name, Expand & Close)
// ---------------------------------------------------------------------------

function CameraCard({
  camera,
  detections,
  onSnapshot,
  onRemove,
  onExpand,
  onReload,
  refreshKey = 0,
  isActive = true,
  index,
  isDragging = false,
  isDragOver = false,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd
}: {
  camera: CameraInfo
  detections: Record<string, Detection[]>
  onSnapshot: (cameraId: string) => Promise<void> | void
  onRemove?: (cameraId: string) => void
  onExpand?: (camera: CameraInfo) => void
  onReload?: (cameraId: string) => void
  refreshKey?: number
  isActive?: boolean
  index: number
  isDragging?: boolean
  isDragOver?: boolean
  onDragStart?: (e: React.DragEvent, index: number) => void
  onDragOver?: (e: React.DragEvent, index: number) => void
  onDragLeave?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent, index: number) => void
  onDragEnd?: (e: React.DragEvent) => void
}): JSX.Element {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flashing, setFlashing] = useState(false)
  const [printStatus, setPrintStatus] = useState<'idle' | 'capturing' | 'success'>('idle')
  const [reloading, setReloading] = useState(false)
  const [ipBase64, setIpBase64] = useState<string | null>(null)
  const mode = 'fluid'
  const ipBase64Ref = useRef<string | null>(null)

  useEffect(() => {
    ipBase64Ref.current = ipBase64
  }, [ipBase64])

  const drawBoxes = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.clientWidth || canvas.offsetWidth
    const h = canvas.clientHeight || canvas.offsetHeight
    if (!w || !h) return
    canvas.width = w
    canvas.height = h
    ctx.clearRect(0, 0, w, h)
    const boxes = detections[camera.id] || []
    for (const box of boxes) {
      const color = classColor(box.className)
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.strokeRect(box.x1 * w, box.y1 * h, (box.x2 - box.x1) * w, (box.y2 - box.y1) * h)
      ctx.fillStyle = color
      ctx.fillRect(box.x1 * w, Math.max(0, box.y1 * h - 18), Math.min(w, (box.x2 - box.x1) * w), 16)
      ctx.fillStyle = '#0a0a0a'
      ctx.font = '11px sans-serif'
      ctx.fillText(`${ptLabel(box.className)} ${Math.round(box.confidence * 100)}%`, box.x1 * w + 4, Math.max(0, box.y1 * h - 6))
    }
  }, [camera.id, detections])

  const fetchingRef = useRef(false)
  const pumpingRef = useRef(false)

  const isCardVisible = useCallback(() => {
    if (!isActive) return false
    const el = cardRef.current
    if (!el) return true
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility()
    }
    return el.offsetParent !== null
  }, [isActive])

  useEffect(() => {
    setError(null)
  }, [refreshKey])

  // Live frame polling via the worker. Webcam frames come from the host camera
  // window (start-watch), IP frames from the MJPEG stream — a single stream
  // owner so cameras keep running even after leaving this page.
  useEffect(() => {
    let cancelled = false
    let timer: number | null = null

    const fetchFrame = async () => {
      if (cancelled) return
      let nextInterval = 33 // Up to 30 FPS max fluid capability
      if (!document.hidden && isCardVisible()) {
        if (!fetchingRef.current) {
          fetchingRef.current = true
          const startTs = Date.now()
          try {
            const res = await command<{ jpegBase64?: string }>('get_frame', { cameraId: camera.id })
            if (!cancelled && res.jpegBase64) {
              setIpBase64(res.jpegBase64)
              setReady(true)
              setError(null)
            } else {
              setReady(true)
              nextInterval = 300
            }
          } catch {
            nextInterval = 500
          } finally {
            fetchingRef.current = false
            const elapsed = Date.now() - startTs
            nextInterval = Math.max(0, 33 - elapsed)
          }
        }
      } else {
        nextInterval = 400
      }
      if (!cancelled) {
        timer = window.setTimeout(fetchFrame, nextInterval)
      }
    }

    void fetchFrame()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [camera.id, refreshKey, isCardVisible])

  useEffect(() => {
    drawBoxes()
  }, [detections, drawBoxes])

  // YOLO detection frame pump — send the latest frame to the worker for boxes.
  useEffect(() => {
    const interval = PUMP_INTERVALS[mode] || 1000
    const run = async () => {
      if (document.hidden || !isCardVisible() || pumpingRef.current) return
      const jpegBase64 = ipBase64Ref.current
      if (!jpegBase64) return
      pumpingRef.current = true
      try {
        await command<{ detections?: Detection[] }>('frame_pump', { cameraId: camera.id, jpegBase64 })
      } catch {
        // transient — keep pumping
      } finally {
        pumpingRef.current = false
      }
    }
    void run()
    const timer = window.setInterval(() => void run(), interval)
    return () => {
      clearInterval(timer)
    }
  }, [camera.id, mode, isCardVisible])

  const handleTakeSnapshot = async () => {
    setFlashing(true)
    setTimeout(() => setFlashing(false), 200)
    setPrintStatus('capturing')
    try {
      await onSnapshot(camera.id)
      setPrintStatus('success')
      setTimeout(() => setPrintStatus('idle'), 1800)
    } catch {
      setPrintStatus('idle')
    }
  }

  const handleReloadCamera = async () => {
    setReloading(true)
    setError(null)
    try {
      const res = await command<{ jpegBase64?: string; cameraId?: string }>('reload_camera', {
        cameraId: camera.id,
        cameraName: camera.name
      })
      if (res.jpegBase64) {
        setIpBase64(res.jpegBase64)
        setReady(true)
        setError(null)
      }
      // A replug can change the deviceId while keeping the same name — sync the
      // card with the resolved id so polling stops hitting the stale one.
      if (res.cameraId && res.cameraId !== camera.id) {
        onReload?.(res.cameraId)
      }
    } catch {
      // Friendly status instead of a raw backend error (e.g. a stale device id
      // right after a replug). The live polling keeps retrying and clears it
      // as soon as a frame arrives; the poll below re-syncs the camera list so
      // the card picks up a changed deviceId sooner.
      setError('Conectando à sua câmera...')
      onReload?.(camera.id)
    } finally {
      setReloading(false)
    }
  }

  return (
    <div
      ref={cardRef}
      draggable
      onDragStart={(e) => onDragStart?.(e, index)}
      onDragOver={(e) => onDragOver?.(e, index)}
      onDragLeave={(e) => onDragLeave?.(e)}
      onDrop={(e) => onDrop?.(e, index)}
      onDragEnd={(e) => onDragEnd?.(e)}
      className={`flex flex-col h-full rounded-2xl bg-zinc-900/80 border overflow-hidden shadow-xl transition-all ${
        isDragging
          ? 'opacity-40 scale-95 border-emerald-500/50'
          : isDragOver
          ? 'border-2 border-emerald-400 bg-emerald-500/10 shadow-emerald-500/20 scale-[1.02]'
          : 'border-white/10 hover:border-white/20'
      }`}
    >
      <div className="relative w-full aspect-video bg-black rounded-t-2xl overflow-hidden shrink-0" style={{ aspectRatio: '16 / 9' }}>
        {ready && ipBase64 ? (
          <img
            src={`data:image/jpeg;base64,${ipBase64}`}
            alt={camera.name}
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 w-full h-full flex flex-col items-center justify-center text-xs text-gray-400 bg-black p-4 text-center">
            <VisionIcon className="w-6 h-6 text-gray-400 mb-2 animate-pulse" />
            <span>{reloading ? 'Conectando à sua câmera...' : camera.online ? 'Iniciando câmera...' : 'Sem sinal'}</span>
          </div>
        )}
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />

        {/* Shutter Flash Animation Effect */}
        {flashing ? (
          <div className="absolute inset-0 bg-white/80 z-30 transition-opacity duration-200 pointer-events-none" />
        ) : null}

        {error ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-red-400 bg-black/70 z-20 p-4 text-center">
            {error}
          </div>
        ) : null}

        {/* Top Header Bar Inside Card: Drag Handle, Name & Controls */}
        <div className="absolute top-0 inset-x-0 p-2.5 z-20 flex items-center justify-between bg-gradient-to-b from-black/80 via-black/40 to-transparent backdrop-blur-[2px]">
          {/* Left: Drag Grip Handle + Camera Name + Monitors count */}
          <div className="flex items-center gap-2 max-w-[65%] truncate">
            <span
              className="text-gray-400 hover:text-white cursor-grab active:cursor-grabbing p-0.5 rounded transition-colors shrink-0"
              title="Clique e arraste para reordenar esta câmera"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="9" cy="5" r="1.5" />
                <circle cx="15" cy="5" r="1.5" />
                <circle cx="9" cy="12" r="1.5" />
                <circle cx="15" cy="12" r="1.5" />
                <circle cx="9" cy="19" r="1.5" />
                <circle cx="15" cy="19" r="1.5" />
              </svg>
            </span>
            <span className="text-xs font-semibold text-white drop-shadow truncate">
              {camera.name}
            </span>
            {camera.monitors > 0 ? (
              <span className="text-[10px] font-medium text-gray-300 bg-white/10 rounded-full px-2 py-0.5 backdrop-blur-sm shrink-0">
                {camera.monitors} mon
              </span>
            ) : null}
          </div>

          {/* Right: Expand & Close/Remove Buttons */}
          <div className="flex items-center gap-1.5 shrink-0">
            {onExpand ? (
              <button
                onClick={() => onExpand(camera)}
                className="w-7 h-7 bg-black/50 hover:bg-zinc-800 text-white rounded-full flex items-center justify-center transition-all shadow backdrop-blur-sm hover:scale-105 active:scale-95"
                title="Ampliar imagem"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                </svg>
              </button>
            ) : null}
            {onRemove ? (
              <button
                onClick={() => onRemove(camera.id)}
                className="w-7 h-7 bg-black/50 hover:bg-red-600/90 text-white rounded-full flex items-center justify-center transition-all shadow backdrop-blur-sm hover:scale-105 active:scale-95"
                title="Fechar / Remover câmera da exibição"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between px-3 py-2 bg-zinc-900/80 shrink-0 border-t border-white/5">
        <span className="text-[11px] text-gray-400 font-medium px-1 flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${camera.online ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
          {camera.source === 'webcam' ? 'Webcam' : 'MJPEG / IP'}
        </span>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Reload: rebuild the camera source when the feed is stuck */}
          <button
            disabled={reloading}
            onClick={() => void handleReloadCamera()}
            className="w-7 h-7 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white transition-all flex items-center justify-center shadow-md active:scale-95 disabled:opacity-70 disabled:hover:bg-zinc-800"
            title="Recarregar câmera"
            aria-label="Recarregar câmera"
          >
            <svg
              className={`w-3.5 h-3.5 ${reloading ? 'animate-spin' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>

        {/* Interactive Print Button with Depth & State Feedback */}
        <button
          disabled={printStatus === 'capturing'}
          onClick={handleTakeSnapshot}
          className={`text-[11px] font-medium rounded-lg px-3 py-1.5 transition-all flex items-center gap-1.5 shadow-md active:scale-95 ${
            printStatus === 'success'
              ? 'bg-zinc-700 text-white'
              : printStatus === 'capturing'
              ? 'bg-zinc-800 text-white opacity-80'
              : 'bg-zinc-800 hover:bg-zinc-700 text-white'
          }`}
        >
          {printStatus === 'success' ? (
            <>
              <svg className="w-3.5 h-3.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <path d="M20 6L9 17l-5-5" />
              </svg>
              Print salvo!
            </>
          ) : printStatus === 'capturing' ? (
            <>
              <svg className="w-3.5 h-3.5 animate-spin text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" />
              </svg>
              Capturando...
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                <circle cx="12" cy="13" r="4"/>
              </svg>
              Tirar print
            </>
          )}
        </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Add Camera Card (Striped border button) & Selection Modal
// ---------------------------------------------------------------------------

function AddCameraCard({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      type="button"
      className="relative group rounded-2xl bg-zinc-900/40 hover:bg-zinc-900/80 transition-all duration-200 flex flex-col items-center justify-center p-4 text-center overflow-hidden focus:outline-none focus:ring-1 focus:ring-white/20 h-full min-h-[160px] cursor-pointer min-w-0"
    >
      <div className="w-10 h-10 rounded-full bg-white/5 group-hover:scale-110 group-hover:bg-white/10 text-gray-300 flex items-center justify-center mb-2 transition-all duration-200 shadow-md">
        <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </div>
      <span className="text-xs font-semibold text-gray-200 group-hover:text-white transition-colors">
        Adicionar Câmera
      </span>
      <span className="text-[11px] text-gray-400 mt-0.5">
        Selecionar webcam ou adicionar IP
      </span>
    </button>
  )
}

function AddCameraModal({
  isOpen,
  onClose,
  allCameras,
  selectedCameraIds,
  onConfirm
}: {
  isOpen: boolean
  onClose: () => void
  allCameras: CameraInfo[]
  selectedCameraIds: string[]
  onConfirm: (webcamIds: string[], ipDrafts: Array<{ name: string; url: string }>) => Promise<void>
}): JSX.Element | null {
  const [activeTab, setActiveTab] = useState<'webcam' | 'ip'>('webcam')
  const [selectedWebcamId, setSelectedWebcamId] = useState<string>('')
  const [pendingWebcamIds, setPendingWebcamIds] = useState<string[]>([])
  const [pendingIpDrafts, setPendingIpDrafts] = useState<Array<{ name: string; url: string }>>([])
  const [ipUrl, setIpUrl] = useState('')
  const [ipName, setIpName] = useState('')
  const [modalError, setModalError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmUnsaved, setConfirmUnsaved] = useState(false)

  const webcamCameras = allCameras.filter((c) => c.source === 'webcam')
  const ipCameras = allCameras.filter((c) => c.source === 'ip')

  // Reset the pending selection every time the modal (re)opens, so a
  // cancelled session never leaks cameras into the next one.
  useEffect(() => {
    if (!isOpen) return
    setSelectedWebcamId('')
    setPendingWebcamIds([])
    setPendingIpDrafts([])
    setIpUrl('')
    setIpName('')
    setModalError(null)
    setSubmitting(false)
    setConfirmUnsaved(false)
  }, [isOpen])

  if (!isOpen) return null

  const removePendingWebcam = (id: string) => {
    setPendingWebcamIds((prev) => prev.filter((x) => x !== id))
  }

  const removePendingIp = (index: number) => {
    setPendingIpDrafts((prev) => prev.filter((_, i) => i !== index))
  }

  // Selecting a webcam only stages it — nothing is persisted until confirm.
  const handleSelectWebcam = (val: string) => {
    if (!val) return
    setPendingWebcamIds((prev) => (prev.includes(val) ? prev : [...prev, val]))
    setSelectedWebcamId('')
  }

  const handleStageIp = () => {
    const url = ipUrl.trim()
    if (!url) return
    const id = `ip:${url}`
    if (ipCameras.some((c) => c.id === id)) {
      setModalError('Esta câmera IP já está cadastrada.')
      return
    }
    if (pendingIpDrafts.some((d) => `ip:${d.url}` === id)) {
      setModalError('Esta câmera IP já está na lista de seleção.')
      return
    }
    setPendingIpDrafts((prev) => [...prev, { name: ipName.trim(), url }])
    setIpUrl('')
    setIpName('')
    setModalError(null)
  }

  const pendingCount = pendingWebcamIds.length + pendingIpDrafts.length
  const hasUnsavedIpInput = ipUrl.trim() !== '' || ipName.trim() !== ''

  const doConfirm = async () => {
    if (pendingCount === 0) return
    setConfirmUnsaved(false)
    setSubmitting(true)
    setModalError(null)
    try {
      await onConfirm(pendingWebcamIds, pendingIpDrafts)
    } catch (err) {
      setModalError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleConfirm = async () => {
    if (pendingCount === 0) return
    // Warn when the user typed IP fields but never staged that camera, so the
    // confirm action never silently discards what is on the screen.
    if (hasUnsavedIpInput) {
      setConfirmUnsaved(true)
      return
    }
    await doConfirm()
  }

  const webcamOptions: CustomSelectOption[] = webcamCameras
    .filter((cam) => !selectedCameraIds.includes(cam.id) && !pendingWebcamIds.includes(cam.id))
    .map((cam) => ({ value: cam.id, label: cam.name, badge: 'Disponível' }))

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/80 backdrop-blur-md animate-fadeIn">
      <div className="min-h-full flex items-start sm:items-center [@media(max-height:720px)]:items-start justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="vision-camera-dialog-title"
          className="w-full max-w-2xl max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border border-white/10 bg-zinc-900 shadow-2xl relative"
        >
        {/* Modal Header */}
        <div className="sticky top-0 z-20 flex items-start justify-between gap-4 px-6 pt-6 pb-5 bg-zinc-900/95 backdrop-blur-sm">
          <div>
            <div className="flex items-center gap-2.5">
              <VisionIcon className="w-5 h-5 text-emerald-400" />
              <h2 id="vision-camera-dialog-title" className="text-base font-bold text-white">
                Adicionar Câmeras
              </h2>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Fechar"
            className="text-gray-500 hover:text-white rounded-lg p-1.5 -mr-1 hover:bg-white/5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Segmented Control / Tab Switcher */}
        <div role="tablist" className="mx-6 grid grid-cols-2 gap-1 p-1 rounded-lg border border-white/10 bg-black/20 text-xs font-medium">
          <button
            type="button"
            role="tab"
            onClick={() => setActiveTab('webcam')}
            aria-selected={activeTab === 'webcam'}
            className={`py-2.5 px-3 rounded-md flex items-center justify-center gap-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${
              activeTab === 'webcam'
                ? 'bg-zinc-800 text-white'
                : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
            Webcam USB ({webcamCameras.length})
          </button>
          <button
            type="button"
            role="tab"
            onClick={() => setActiveTab('ip')}
            aria-selected={activeTab === 'ip'}
            className={`py-2.5 px-3 rounded-md flex items-center justify-center gap-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${
              activeTab === 'ip'
                ? 'bg-zinc-800 text-white'
                : 'text-gray-400 hover:text-gray-200 hover:bg-white/5'
            }`}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
            Câmeras IP ({ipCameras.length})
          </button>
        </div>

        <div className={`grid grid-cols-1 gap-5 px-6 pt-5 ${pendingCount > 0 ? 'md:grid-cols-[minmax(0,1fr)_15rem]' : ''}`}>
          <div className="min-w-0">
            <div className="min-w-0">
          {/* Tab 1: Webcams USB */}
          {activeTab === 'webcam' && (
            <div className="animate-fadeIn overflow-visible">
              <label className="text-[11px] font-medium text-gray-300 block mb-2">
                Webcam disponível
              </label>

              {webcamCameras.length === 0 ? (
                <div className="text-xs text-gray-400 border border-dashed border-white/10 rounded-lg px-3 py-4 text-center">
                  Nenhuma webcam USB detectada no sistema.
                </div>
              ) : webcamOptions.length === 0 ? (
                <div className="text-xs text-gray-400 border border-dashed border-white/10 rounded-lg px-3 py-4 text-center">
                  Todas as webcams já estão selecionadas ou na lista de seleção.
                </div>
              ) : (
                <div className="space-y-3 relative overflow-visible z-30">
                  <CustomSelect
                    value={selectedWebcamId}
                    onChange={handleSelectWebcam}
                    options={webcamOptions}
                    placeholder="Selecione uma webcam..."
                    size="md"
                    direction="down"
                    className="w-full"
                  />
                </div>
              )}
            </div>
          )}

          {/* Tab 2: Câmeras IP */}
          {activeTab === 'ip' && (
            <div className="animate-fadeIn">
              {/* Form to stage a new IP camera into the pending selection */}
              <div>
                <h3 className="text-[11px] font-semibold text-gray-300">
                  Nova câmera IP / MJPEG
                </h3>
                <div className="mt-3 space-y-3">
                  <div>
                    <label htmlFor="vision-ip-name" className="block text-[11px] font-medium text-gray-400 mb-1.5">
                      Nome <span className="text-gray-600">(opcional)</span>
                    </label>
                    <input
                      id="vision-ip-name"
                      value={ipName}
                      onChange={(e) => setIpName(e.target.value)}
                      placeholder="Nome da câmera (ex.: Garagem, Entrada)"
                      className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-emerald-500/70 focus-visible:ring-2 focus-visible:ring-emerald-500/10 transition-colors"
                    />
                  </div>
                  <div>
                    <label htmlFor="vision-ip-url" className="block text-[11px] font-medium text-gray-400 mb-1.5">
                      URL da câmera
                    </label>
                    <input
                      id="vision-ip-url"
                      value={ipUrl}
                      onChange={(e) => setIpUrl(e.target.value)}
                      placeholder="URL (http://ip:porta/video ou rtsp://user:pass@ip)"
                      className="w-full bg-black/20 border border-white/10 rounded-lg px-3 py-2.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-emerald-500/70 focus-visible:ring-2 focus-visible:ring-emerald-500/10 transition-colors"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={!ipUrl.trim()}
                    onClick={handleStageIp}
                    className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600 text-xs font-semibold py-2.5 text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                  >
                    Adicionar à seleção
                  </button>
                </div>
              </div>
            </div>
          )}
            </div>
          </div>

        {pendingCount > 0 && (
          <aside className="min-w-0 self-start md:border-l md:border-white/10 md:pl-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-400/80 mb-2">
              Revisão
            </p>
            <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] overflow-hidden">
              <ul className="divide-y divide-emerald-500/15">
                {pendingWebcamIds.map((id) => {
                  const cam = webcamCameras.find((c) => c.id === id)
                  return (
                    <li
                      key={id}
                      className="flex items-center justify-between gap-2 px-2.5 py-1.5"
                    >
                      <span className="text-[11px] text-gray-200 truncate flex items-center gap-1.5 min-w-0">
                        <svg className="w-3 h-3 text-emerald-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                          <circle cx="12" cy="13" r="4" />
                        </svg>
                        <span className="truncate">{cam?.name || id}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => removePendingWebcam(id)}
                        aria-label={`Remover ${cam?.name || id} da seleção`}
                        className="text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded p-0.5 shrink-0 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40"
                      >
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                          <path d="M18 6L6 18M6 6l12 12" />
                        </svg>
                      </button>
                    </li>
                  )
                })}
                {pendingIpDrafts.map((draft, i) => (
                  <li
                    key={`ip-${draft.url}-${i}`}
                    className="flex items-center justify-between gap-2 px-2.5 py-1.5"
                  >
                    <span className="text-[11px] text-gray-200 truncate flex items-center gap-1.5 min-w-0">
                      <svg className="w-3 h-3 text-emerald-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="2" y1="12" x2="22" y2="12" />
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                      </svg>
                      <span className="truncate">{draft.name || draft.url}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => removePendingIp(i)}
                      aria-label={`Remover ${draft.name || draft.url} da seleção`}
                      className="text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded p-0.5 shrink-0 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-[11px] leading-relaxed text-gray-600 mt-2">
              A seleção será aplicada de uma vez ao confirmar.
            </p>
          </aside>
        )}
        </div>

        {/* Modal Footer */}
        <div className="sticky bottom-0 z-20 mx-6 mt-5 mb-0 pt-4 pb-6 border-t border-white/10 bg-zinc-900/95 backdrop-blur-sm flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          {modalError ? (
            <p className="w-full sm:max-w-[60%] text-xs text-red-400 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2 sm:mr-auto text-left">
              {modalError}
            </p>
          ) : confirmUnsaved ? (
            <p className="w-full sm:max-w-[60%] text-xs text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2 sm:mr-auto text-left">
              Você preencheu os campos de uma câmera IP sem adicioná-la à lista de seleção. Confirmar mesmo assim?
            </p>
          ) : null}
          {confirmUnsaved ? (
            <>
              <button
                type="button"
                onClick={() => setConfirmUnsaved(false)}
                className="w-full sm:w-auto rounded-xl bg-white/5 hover:bg-white/10 text-gray-300 px-4 py-2 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void doConfirm()}
                className="w-full sm:w-auto rounded-xl bg-amber-500 hover:bg-amber-400 text-black px-5 py-2 text-xs font-semibold transition-colors shadow-md active:scale-95 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70"
              >
                {submitting ? 'Adicionando...' : 'Sim, adicionar mesmo assim'}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="w-full sm:w-auto rounded-xl bg-white/5 hover:bg-white/10 text-gray-300 px-4 py-2 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={submitting || pendingCount === 0}
                onClick={() => void handleConfirm()}
                className={`w-full sm:w-auto rounded-xl text-white px-5 py-2 text-xs font-semibold transition-colors shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 ${
                  pendingCount === 0
                    ? 'bg-zinc-800 text-gray-500 cursor-not-allowed'
                    : 'bg-emerald-600 hover:bg-emerald-500 active:scale-95'
                }`}
              >
                {submitting
                  ? 'Adicionando...'
                  : pendingCount === 0
                  ? 'Nenhuma câmera selecionada'
                  : `Adicionar ${pendingCount} ${pendingCount === 1 ? 'câmera' : 'câmeras'}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Expanded Live Camera Modal (Responsive Full Screen Stream Preview)
// ---------------------------------------------------------------------------

function ExpandedCameraModal({
  camera,
  detections,
  onClose,
  onSnapshot
}: {
  camera: CameraInfo | null
  detections: Record<string, Detection[]>
  onClose: () => void
  onSnapshot: (cameraId: string) => Promise<void> | void
}): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const frameBoxRef = useRef<HTMLDivElement | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flashing, setFlashing] = useState(false)
  const [printStatus, setPrintStatus] = useState<'idle' | 'capturing' | 'success'>('idle')
  const [ipBase64, setIpBase64] = useState<string | null>(null)

  // Boxes are normalized to the video frame. With object-contain the image is
  // centered inside the box, so map each box to the displayed image rect.
  const drawBoxes = useCallback(() => {
    const canvas = canvasRef.current
    const boxEl = frameBoxRef.current
    const imgEl = imgRef.current
    if (!canvas || !boxEl || !camera) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const cw = boxEl.clientWidth || boxEl.offsetWidth
    const ch = boxEl.clientHeight || boxEl.offsetHeight
    if (!cw || !ch) return
    canvas.width = cw
    canvas.height = ch
    ctx.clearRect(0, 0, cw, ch)
    const iw = imgEl?.naturalWidth || 0
    const ih = imgEl?.naturalHeight || 0
    let ox = 0
    let oy = 0
    let dw = cw
    let dh = ch
    if (iw && ih) {
      const scale = Math.min(cw / iw, ch / ih)
      dw = iw * scale
      dh = ih * scale
      ox = (cw - dw) / 2
      oy = (ch - dh) / 2
    }
    const boxes = detections[camera.id] || []
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
      ctx.fillRect(x1, Math.max(0, y1 - 20), Math.min(cw, x2 - x1), 18)
      ctx.fillStyle = '#0a0a0a'
      ctx.font = 'bold 12px sans-serif'
      ctx.fillText(`${ptLabel(box.className)} ${Math.round(box.confidence * 100)}%`, x1 + 4, Math.max(0, y1 - 6))
    }
  }, [camera, detections])

  useEffect(() => {
    if (!camera) return
    let cancelled = false
    let timer: number | null = null

    const fetchFrame = async () => {
      if (cancelled) return
      let nextInterval = 42 // 24 FPS (1000ms / 24 = ~41.67ms)
      try {
        const res = await command<{ jpegBase64?: string }>('get_frame', { cameraId: camera.id })
        if (cancelled) return
        if (res.jpegBase64) {
          setIpBase64(res.jpegBase64)
          setReady(true)
          setError(null)
        } else {
          nextInterval = 300
        }
      } catch {
        nextInterval = 1000
      }
      if (!cancelled) {
        timer = window.setTimeout(fetchFrame, nextInterval)
      }
    }

    void fetchFrame()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [camera])

  useEffect(() => {
    drawBoxes()
  }, [detections, drawBoxes])

  if (!camera) return null

  const handleTakeSnapshot = async () => {
    setFlashing(true)
    setTimeout(() => setFlashing(false), 200)
    setPrintStatus('capturing')
    try {
      await onSnapshot(camera.id)
      setPrintStatus('success')
      setTimeout(() => setPrintStatus('idle'), 1800)
    } catch {
      setPrintStatus('idle')
    }
  }

  return (
    <div className="absolute inset-0 z-50 bg-black/90 backdrop-blur-md animate-fadeIn">
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 bg-black/40 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${camera.online ? 'bg-emerald-400' : 'bg-red-500'}`} />
            <h2 className="text-base font-bold text-white truncate">{camera.name}</h2>
            <span className="text-xs text-gray-400 shrink-0">({camera.source === 'webcam' ? 'Webcam' : 'IP MJPEG'})</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              disabled={printStatus === 'capturing'}
              onClick={handleTakeSnapshot}
              className={`text-xs font-medium rounded-lg px-3 py-1.5 transition-all flex items-center gap-1.5 shadow-md active:scale-95 ${
                printStatus === 'success'
                  ? 'bg-emerald-500 text-white'
                  : printStatus === 'capturing'
                  ? 'bg-emerald-700 text-white opacity-80'
                  : 'bg-emerald-600 hover:bg-emerald-500 text-white'
              }`}
            >
              {printStatus === 'success' ? (
                <>
                  <svg className="w-3.5 h-3.5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                  Print salvo!
                </>
              ) : printStatus === 'capturing' ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                    <path d="M12 2a10 10 0 0 1 10 10" />
                  </svg>
                  Capturando...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                    <circle cx="12" cy="13" r="4"/>
                  </svg>
                  Tirar print
                </>
              )}
            </button>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white rounded-lg p-1.5 hover:bg-white/10 transition-colors"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div ref={frameBoxRef} className="flex-1 min-h-0 relative bg-black overflow-hidden">
          {ipBase64 ? (
            <img
              ref={imgRef}
              src={`data:image/jpeg;base64,${ipBase64}`}
              alt={camera.name}
              className="absolute inset-0 w-full h-full object-contain"
              onLoad={() => drawBoxes()}
            />
          ) : (
            <div className="absolute inset-0 w-full h-full flex flex-col items-center justify-center text-sm text-gray-400 bg-black p-4 text-center">
              <VisionIcon className="w-8 h-8 text-emerald-500/70 mb-2 animate-pulse" />
              <span>Iniciando câmera...</span>
            </div>
          )}
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />

          {/* Shutter Flash Effect */}
          {flashing ? (
            <div className="absolute inset-0 bg-white/80 z-30 transition-opacity duration-200 pointer-events-none" />
          ) : null}

          {error ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-red-400 bg-black/70 p-4 text-center">
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Expanded Print Lightbox Modal
// ---------------------------------------------------------------------------

function ExpandedPrintModal({
  snap,
  onClose,
  onDescribe,
  onDelete,
  busy
}: {
  snap: Snapshot | null
  onClose: () => void
  onDescribe: (snapId: string) => Promise<void>
  onDelete: (snapId: string) => Promise<void>
  busy: boolean
}): JSX.Element | null {
  if (!snap) return null

  const imgSrc =
    snap.imageDataUri ||
    `${window.api?.getApiBaseUrl?.() || ''}/extensions/${EXT_ID}/storage/snapshots/${snap.id}.jpg`

  return (
    <div className="absolute inset-0 z-50 bg-black/90 backdrop-blur-md animate-fadeIn">
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 bg-black/40 shrink-0">
          <div>
            <h2 className="text-sm font-bold text-white">Print da Câmera</h2>
            <p className="text-xs text-gray-400">{formatTime(snap.ts)}</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white rounded-lg p-1.5 hover:bg-white/10 transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 min-h-0 relative bg-black flex items-center justify-center p-4">
          <img src={imgSrc} alt={snap.description || 'Print'} className="max-w-full max-h-full object-contain" />
        </div>

        <div className="px-4 py-3 bg-zinc-900 border-t border-white/10 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <p className="text-xs text-gray-300 max-w-xl">{snap.description || 'Sem descrição.'}</p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              disabled={busy}
              onClick={() => void onDescribe(snap.id)}
              className="text-xs font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white px-3 py-1.5 transition-colors shrink-0"
            >
              Descrever de novo
            </button>
            <button
              disabled={busy}
              onClick={() => void onDelete(snap.id)}
              className="text-xs font-medium rounded-lg bg-red-600/80 hover:bg-red-500 disabled:opacity-50 text-white px-3 py-1.5 transition-colors shrink-0 flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
              Excluir
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Expanded Alert Modal
// ---------------------------------------------------------------------------

function ExpandedAlertModal({
  alert,
  onClose
}: {
  alert: Alert | null
  onClose: () => void
}): JSX.Element | null {
  if (!alert) return null

  const imgSrc =
    alert.imageDataUri ||
    (alert.snapshotId
      ? `${window.api?.getApiBaseUrl?.() || ''}/extensions/${EXT_ID}/storage/snapshots/${alert.snapshotId}.jpg`
      : '')

  return (
    <div className="absolute inset-0 z-50 bg-black/90 backdrop-blur-md animate-fadeIn flex flex-col">
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 bg-black/40 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0 animate-pulse" />
          <h2 className="text-sm font-bold text-white truncate">
            {alert.cameraName || 'Câmera'}
            {alert.className ? ` · ${ptLabel(alert.className)}` : ''}
            {alert.confidence ? ` ${Math.round(alert.confidence * 100)}%` : ''}
          </h2>
          <span className="text-xs text-gray-400 shrink-0">({formatTime(alert.ts)})</span>
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-white rounded-lg p-1.5 hover:bg-white/10 transition-colors"
          title="Fechar"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="flex-1 min-h-0 relative bg-black flex items-center justify-center p-4">
        {imgSrc ? (
          <AlertCanvasOverlay
            imageDataUri={imgSrc}
            boxes={alert.boxes}
            objectFit="object-contain"
          />
        ) : (
          <p className="text-sm text-gray-400">Sem imagem de alerta disponível.</p>
        )}
      </div>

      {alert.description ? (
        <div className="px-5 py-3 bg-zinc-900 border-t border-white/10 shrink-0 flex items-center justify-between gap-4">
          <p className="text-xs text-gray-300">{alert.description}</p>
          {alert.triggeredBy ? (
            <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20 font-mono shrink-0">
              {alert.triggeredBy}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const TRIGGER_TYPES = [
  { value: 'motion', label: 'Movimento (Detecção de Mudança na Câmera)' },
  { value: 'object', label: 'Detecção de Objetos' },
  { value: 'person', label: 'Pessoas' },
  { value: 'animal', label: 'Animais' },
  { value: 'presence', label: 'Presença Cumulativa / Permanência' },
  { value: 'absence', label: 'Ausência / Desaparecimento da Cena' }
]

const SENSITIVITY_OPTIONS = [
  { value: 'med', label: 'Média (Recomendado)' },
  { value: 'low', label: 'Baixa (Apenas movimentos grandes)' },
  { value: 'high', label: 'Alta (Qualquer movimento)' }
]

const ANIMAL_KEYS = ['dog', 'cat', 'bird', 'horse', 'sheep', 'cow', 'bear', 'elephant', 'zebra', 'giraffe']

const ANIMAL_OBJECT_OPTIONS = ANIMAL_KEYS.map((key) => ({
  value: key,
  label: `${PT_CLASS[key] ? PT_CLASS[key].charAt(0).toUpperCase() + PT_CLASS[key].slice(1) : key} (${key})`
}))

const INANIMATE_OBJECT_OPTIONS = Object.entries(PT_CLASS)
  .filter(([key]) => key !== 'person' && !ANIMAL_KEYS.includes(key))
  .map(([key, label]) => ({
    value: key,
    label: `${label.charAt(0).toUpperCase() + label.slice(1)} (${key})`
  }))

const ALL_OBJECT_OPTIONS = Object.entries(PT_CLASS).map(([key, label]) => ({
  value: key,
  label: `${label.charAt(0).toUpperCase() + label.slice(1)} (${key})`
}))

const COOLDOWN_OPTIONS = [
  { value: '30', label: '30 segundos' },
  { value: '60', label: '1 minuto' },
  { value: '300', label: '5 minutos (Padrão)' },
  { value: '600', label: '10 minutos' },
  { value: '1800', label: '30 minutos' },
  { value: 'custom', label: 'Outro' }
]

function formatTriggerPortuguese(t: Trigger): string {
  switch (t.type) {
    case 'motion':
      return `Movimento (${t.sensitivity === 'high' ? 'Alta sensibilidade' : t.sensitivity === 'low' ? 'Baixa sensibilidade' : 'Sensibilidade média'})`
    case 'object':
      if (t.className === 'person') {
        return `Pessoas (${t.present === false ? 'Ausente' : 'Detectar presença'})`
      }
      if (ANIMAL_KEYS.includes(t.className || '')) {
        return `Animal: ${ptLabel(t.className)} (${t.present === false ? 'Ausente' : 'Presente'})`
      }
      return `Objeto: ${ptLabel(t.className || 'objeto')} (${t.present === false ? 'Ausente' : 'Presente'})`
    case 'presence':
      return `Presença: ${ptLabel(t.className || 'pessoa')} (${t.event === 'entered' ? 'Entrou' : t.event === 'left' ? 'Saiu' : 'Permaneceu'}${t.windowSec ? `, ${t.windowSec}s` : ''})`
    case 'absence':
      return `Ausência: ${ptLabel(t.className || 'pessoa')}${t.windowSec ? ` (${t.windowSec}s)` : ''}`
    case 'scene':
      return `Pergunta IA: "${t.question}"`
    case 'periodic':
      return `Resumo a cada ${t.everySec || 300}s`
    default:
      return (t as { type: string }).type
  }
}

interface AddEditMonitorModalProps {
  isOpen: boolean
  onClose: () => void
  cameras: CameraInfo[]
  initialMonitor?: MonitorInfo | null
  onSave: () => Promise<void> | void
}

function AddEditMonitorModal({
  isOpen,
  onClose,
  cameras,
  initialMonitor,
  onSave
}: AddEditMonitorModalProps): JSX.Element | null {
  if (!isOpen) return null

  const initCooldown = initialMonitor?.cooldownSec || 300
  const isPreset = ['30', '60', '300', '600', '1800'].includes(String(initCooldown))

  const [cameraId, setCameraId] = useState<string>(
    initialMonitor?.cameraId || cameras[0]?.id || ''
  )
  const [label, setLabel] = useState<string>(initialMonitor?.label || '')
  const [cooldownPreset, setCooldownPreset] = useState<string>(isPreset ? String(initCooldown) : 'custom')
  const [customCooldownValue, setCustomCooldownValue] = useState<number>(
    initCooldown % 60 === 0 ? initCooldown / 60 : initCooldown
  )
  const [customCooldownUnit, setCustomCooldownUnit] = useState<'sec' | 'min'>(
    initCooldown % 60 === 0 && initCooldown >= 60 ? 'min' : 'sec'
  )

  const firstTrigger = initialMonitor?.triggers?.[0]

  const getInitialTriggerType = (): string => {
    if (!firstTrigger) return 'motion'
    if (firstTrigger.type === 'object') {
      if (firstTrigger.className === 'person') return 'person'
      if (ANIMAL_KEYS.includes(firstTrigger.className || '')) return 'animal'
      return 'object'
    }
    return firstTrigger.type || 'motion'
  }

  const [triggerType, setTriggerType] = useState<string>(getInitialTriggerType())

  const [sensitivity, setSensitivity] = useState<string>(firstTrigger?.sensitivity || 'med')
  const [objectClass, setObjectClass] = useState<string>(
    firstTrigger?.className && !ANIMAL_KEYS.includes(firstTrigger.className) && firstTrigger.className !== 'person'
      ? firstTrigger.className
      : 'car'
  )
  const [animalClass, setAnimalClass] = useState<string>(
    firstTrigger?.className && ANIMAL_KEYS.includes(firstTrigger.className) ? firstTrigger.className : 'dog'
  )
  const [presenceTargetClass, setPresenceTargetClass] = useState<string>(firstTrigger?.className || 'person')
  const [objectPresent, setObjectPresent] = useState<boolean>(firstTrigger?.present !== false)
  const [presenceEvent, setPresenceEvent] = useState<string>(firstTrigger?.event || 'entered')
  const [windowSec, setWindowSec] = useState<number>(firstTrigger?.windowSec || 10)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!cameraId) {
      setError('Selecione uma câmera.')
      return
    }

    let finalCooldown = 300
    if (cooldownPreset === 'custom') {
      const val = Math.max(1, Number(customCooldownValue) || 1)
      finalCooldown = customCooldownUnit === 'min' ? val * 60 : val
    } else {
      finalCooldown = Number(cooldownPreset) || 300
    }

    let trigger: any = {}

    if (triggerType === 'motion') {
      trigger = { type: 'motion', sensitivity }
    } else if (triggerType === 'object') {
      trigger = { type: 'object', className: objectClass, present: objectPresent }
    } else if (triggerType === 'person') {
      trigger = { type: 'object', className: 'person', present: objectPresent }
    } else if (triggerType === 'animal') {
      trigger = { type: 'object', className: animalClass, present: objectPresent }
    } else if (triggerType === 'presence') {
      trigger = { type: 'presence', className: presenceTargetClass, event: presenceEvent, windowSec: Number(windowSec) || 10 }
    } else if (triggerType === 'absence') {
      trigger = { type: 'absence', className: presenceTargetClass, event: presenceEvent, windowSec: Number(windowSec) || 10 }
    }

    setSubmitting(true)
    setError(null)
    try {
      if (initialMonitor?.id) {
        await command('update_monitoring', {
          monitorId: initialMonitor.id,
          cameraId,
          triggers: [trigger],
          cooldownSec: finalCooldown,
          label: label.trim() || undefined
        })
      } else {
        await command('start_monitoring', {
          cameraId,
          triggers: [trigger],
          cooldownSec: finalCooldown,
          label: label.trim() || undefined
        })
      }
      await onSave()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
      <div className="w-full max-w-lg bg-zinc-900 border border-white/15 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 bg-zinc-950/60 shrink-0">
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
            {initialMonitor ? 'Editar Monitoramento' : 'Novo Monitoramento'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white rounded-lg p-1.5 hover:bg-white/10 transition-colors"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto custom-scrollbar flex-1">
          {error ? (
            <div className="p-3 text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded-xl">
              {error}
            </div>
          ) : null}

          <div>
            <label className="block text-xs font-semibold text-gray-300 mb-1.5">
              Câmera
            </label>
            <select
              value={cameraId}
              onChange={(e) => setCameraId(e.target.value)}
              className="w-full bg-zinc-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500 font-medium"
            >
              {cameras.map((cam) => (
                <option key={cam.id} value={cam.id}>
                  {cam.name} ({cam.source === 'webcam' ? 'Webcam' : 'IP'})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-300 mb-1.5">
              Nome (Opcional)
            </label>
            <input
              type="text"
              placeholder="ex: Portão da Garagem"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="w-full bg-zinc-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-300 mb-1.5">
              Gatilho de Alerta (Trigger)
            </label>
            <select
              value={triggerType}
              onChange={(e) => setTriggerType(e.target.value)}
              className="w-full bg-zinc-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500 font-medium"
            >
              {TRIGGER_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {triggerType === 'motion' && (
            <div>
              <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                Sensibilidade de Movimento
              </label>
              <select
                value={sensitivity}
                onChange={(e) => setSensitivity(e.target.value)}
                className="w-full bg-zinc-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
              >
                {SENSITIVITY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {triggerType === 'object' && (
            <div className="space-y-4 bg-white/5 p-3.5 rounded-xl border border-white/5">
              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                  Objeto Inanimado a Detectar
                </label>
                <select
                  value={objectClass}
                  onChange={(e) => setObjectClass(e.target.value)}
                  className="w-full bg-zinc-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500 font-medium"
                >
                  {INANIMATE_OBJECT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                  Condição
                </label>
                <select
                  value={objectPresent ? 'true' : 'false'}
                  onChange={(e) => setObjectPresent(e.target.value === 'true')}
                  className="w-full bg-zinc-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
                >
                  <option value="true font-medium">Detectar quando estiver Presente</option>
                  <option value="false">Detectar quando estiver Ausente</option>
                </select>
              </div>
            </div>
          )}

          {triggerType === 'person' && (
            <div className="space-y-4 bg-white/5 p-3.5 rounded-xl border border-white/5">
              <div className="text-xs text-gray-300 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                <span>Detecta a presença de pessoas na cena via Inteligência Artificial.</span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                  Condição
                </label>
                <select
                  value={objectPresent ? 'true' : 'false'}
                  onChange={(e) => setObjectPresent(e.target.value === 'true')}
                  className="w-full bg-zinc-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
                >
                  <option value="true">Detectar quando Pessoa estiver Presente</option>
                  <option value="false">Detectar quando Pessoa estiver Ausente</option>
                </select>
              </div>
            </div>
          )}

          {triggerType === 'animal' && (
            <div className="space-y-4 bg-white/5 p-3.5 rounded-xl border border-white/5">
              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                  Animal a Detectar
                </label>
                <select
                  value={animalClass}
                  onChange={(e) => setAnimalClass(e.target.value)}
                  className="w-full bg-zinc-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500 font-medium"
                >
                  {ANIMAL_OBJECT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                  Condição
                </label>
                <select
                  value={objectPresent ? 'true' : 'false'}
                  onChange={(e) => setObjectPresent(e.target.value === 'true')}
                  className="w-full bg-zinc-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
                >
                  <option value="true">Detectar quando Animal estiver Presente</option>
                  <option value="false">Detectar quando Animal estiver Ausente</option>
                </select>
              </div>
            </div>
          )}

          {(triggerType === 'presence' || triggerType === 'absence') && (
            <div className="space-y-4 bg-white/5 p-3.5 rounded-xl border border-white/5">
              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                  Alvo (Ser Vivo ou Objeto)
                </label>
                <select
                  value={presenceTargetClass}
                  onChange={(e) => setPresenceTargetClass(e.target.value)}
                  className="w-full bg-zinc-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500 font-medium"
                >
                  {ALL_OBJECT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                  Evento
                </label>
                <select
                  value={presenceEvent}
                  onChange={(e) => setPresenceEvent(e.target.value)}
                  className="w-full bg-zinc-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
                >
                  <option value="entered">Entrou / Apareceu na cena</option>
                  <option value="stayed">Permaneceu na cena</option>
                  <option value="left font-medium">Saiu / Desapareceu da cena</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                  Janela de Tempo (Segundos)
                </label>
                <input
                  type="number"
                  min={1}
                  max={3600}
                  value={windowSec}
                  onChange={(e) => setWindowSec(Number(e.target.value) || 10)}
                  className="w-full bg-zinc-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-gray-300 mb-1.5">
              Intervalo mínimo entre Alertas (Cooldown)
            </label>
            <select
              value={cooldownPreset}
              onChange={(e) => setCooldownPreset(e.target.value)}
              className="w-full bg-zinc-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-emerald-500 font-medium"
            >
              {COOLDOWN_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            {cooldownPreset === 'custom' && (
              <div className="flex items-center gap-2 mt-2 bg-white/5 p-3 rounded-xl border border-white/5 animate-fadeIn">
                <input
                  type="number"
                  min={1}
                  max={86400}
                  value={customCooldownValue}
                  onChange={(e) => setCustomCooldownValue(Number(e.target.value) || 1)}
                  className="flex-1 bg-zinc-800 border border-white/10 rounded-xl px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-emerald-500 font-medium text-center"
                />
                <select
                  value={customCooldownUnit}
                  onChange={(e) => setCustomCooldownUnit(e.target.value as 'sec' | 'min')}
                  className="w-32 bg-zinc-800 border border-white/10 rounded-xl px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-emerald-500 font-medium"
                >
                  <option value="sec">Segundos</option>
                  <option value="min">Minutos</option>
                </select>
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="text-xs font-medium text-gray-300 hover:text-white bg-white/5 hover:bg-white/10 px-4 py-2 rounded-xl transition-all"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2 rounded-xl transition-all shadow-md active:scale-95 disabled:opacity-60 flex items-center gap-2"
            >
              {submitting ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                    <path d="M12 2a10 10 0 0 1 10 10" />
                  </svg>
                  Salvando...
                </>
              ) : (
                'Salvar Monitoramento'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Dashboard Page
// ---------------------------------------------------------------------------

export default function VisionPage({ isActive = true }: { isActive?: boolean }): JSX.Element {
  const [cameras, setCameras] = useState<CameraInfo[]>(() => {
    try {
      const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(`${EXT_ID}:cameras`) : null
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })
  const [monitors, setMonitors] = useState<MonitorInfo[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [config, setConfig] = useState<VisionConfig>(() => {
    try {
      const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(`${EXT_ID}:config`) : null
      return saved ? JSON.parse(saved) : {}
    } catch {
      return {}
    }
  })
  const [detections, setDetections] = useState<Record<string, Detection[]>>({})
  const [activeTab, setActiveTab] = useState<'cameras' | 'alerts' | 'gallery' | 'settings'>('cameras')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [isMonitorModalOpen, setIsMonitorModalOpen] = useState(false)
  const [editingMonitor, setEditingMonitor] = useState<MonitorInfo | null>(null)
  const [expandedCamera, setExpandedCamera] = useState<CameraInfo | null>(null)
  const [expandedPrint, setExpandedPrint] = useState<Snapshot | null>(null)
  const [expandedAlert, setExpandedAlert] = useState<Alert | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; snap: Snapshot } | null>(null)
  const [copyToast, setCopyToast] = useState<string | null>(null)

  const handleContextMenu = useCallback((e: React.MouseEvent, snap: Snapshot) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      snap
    })
  }, [])

  const handleCopyPrint = useCallback(async (snap: Snapshot) => {
    setContextMenu(null)
    const imgSrc =
      snap.imageDataUri ||
      `${window.api?.getApiBaseUrl?.() || ''}/extensions/${EXT_ID}/storage/snapshots/${snap.id}.jpg`
    try {
      const res = await fetch(imgSrc)
      const blob = await res.blob()
      if (typeof ClipboardItem !== 'undefined') {
        const type = blob.type.startsWith('image/') ? blob.type : 'image/png'
        const item = new ClipboardItem({ [type]: blob })
        await navigator.clipboard.write([item])
      } else {
        await navigator.clipboard.writeText(imgSrc)
      }
      setCopyToast('Print copiado para a área de transferência!')
      setTimeout(() => setCopyToast(null), 2500)
    } catch {
      await navigator.clipboard.writeText(imgSrc).catch(() => {})
      setCopyToast('URL do print copiada!')
      setTimeout(() => setCopyToast(null), 2500)
    }
  }, [])

  useEffect(() => {
    const handleClick = () => setContextMenu(null)
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null)
    }
    if (contextMenu) {
      window.addEventListener('click', handleClick)
      window.addEventListener('keydown', handleKeyDown)
    }
    return () => {
      window.removeEventListener('click', handleClick)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [contextMenu])

  // Silent poll — only updates camera/monitor data, no card reset or animation
  const poll = useCallback(async () => {
    try {
      const [camRes, statusRes, alertsRes] = await Promise.all([
        command<{ cameras: CameraInfo[]; selectedCameras?: string[] | null }>('list_cameras'),
        command<{ monitors: MonitorInfo[] }>('get_status'),
        command<{ alerts: Alert[] }>('list_alerts').catch(() => ({ alerts: [] }))
      ])
      const fetchedCams = camRes.cameras || []
      setCameras(fetchedCams)
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`${EXT_ID}:cameras`, JSON.stringify(fetchedCams))
      }
      setMonitors(statusRes.monitors || [])
      if (alertsRes.alerts) {
        setAlerts(alertsRes.alerts)
      }
      if (camRes.selectedCameras !== undefined) {
        const sel = camRes.selectedCameras ?? []
        setConfig((prev) => {
          const next = { ...prev, selectedCameras: sel }
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(`${EXT_ID}:config`, JSON.stringify(next))
          }
          return next
        })
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // Manual refresh — resets cards, triggers animation, re-syncs streams
  const refresh = useCallback(async () => {
    setIsRefreshing(true)
    setRefreshKey((k) => k + 1)
    await poll()
    setTimeout(() => setIsRefreshing(false), 500)
  }, [poll])

  const refreshGallery = useCallback(async () => {
    try {
      const res = await command<{ snapshots: Snapshot[] }>('list_snapshots', { limit: 60 })
      setSnapshots(res.snapshots || [])
    } catch {}
  }, [])

  const handleDeletePrint = useCallback(
    async (snapshotId: string) => {
      setBusy(true)
      try {
        await command('delete_snapshot', { snapshotId })
        if (expandedPrint?.id === snapshotId) {
          setExpandedPrint(null)
        }
        await refreshGallery()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [expandedPrint, refreshGallery]
  )

  const handleClearAllPrints = useCallback(async () => {
    if (snapshots.length === 0) return
    if (!window.confirm('Tem certeza que deseja excluir todos os prints da galeria?')) return
    setBusy(true)
    try {
      await command('clear_snapshots', {})
      setExpandedPrint(null)
      await refreshGallery()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [snapshots.length, refreshGallery])

  const handleClearAlerts = useCallback(async () => {
    if (alerts.length === 0) return
    if (!window.confirm('Tem certeza que deseja limpar todo o histórico de alertas?')) return
    setBusy(true)
    try {
      await command('clear_alerts', {})
      setAlerts([])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [alerts.length])

  useEffect(() => {
    if (!isActive) return
    void poll()
    void refreshGallery()
    const timer = setInterval(() => void poll(), 5000)
    return () => clearInterval(timer)
  }, [poll, refreshGallery, isActive])

  useEffect(() => {
    const unsubAlert = sdk.events.subscribe<Alert>('vision_alert', (alert: Alert) => {
      setAlerts((prev) => [alert, ...prev].slice(0, 100))
    })
    const unsubDetections = sdk.events.subscribe<{
      cameraId: string
      detections: Detection[]
    }>('vision_detections', (data: { cameraId: string; detections: Detection[] }) => {
      if (data?.cameraId && Array.isArray(data.detections)) {
        setDetections((prev) => ({ ...prev, [data.cameraId]: data.detections }))
      }
    })
    return () => {
      unsubAlert()
      unsubDetections()
    }
  }, [])

  const takeSnapshot = useCallback(
    async (cameraId: string) => {
      setBusy(true)
      try {
        await command('capture_snapshot', { cameraId })
        await refreshGallery()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [refreshGallery]
  )

  const saveSettings = useCallback(
    async (next: Partial<Record<string, unknown>>) => {
      try {
        await command('configure', next)
        setConfig((prev) => ({ ...prev, ...(next as VisionConfig) }))
        void refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [refresh]
  )

  const toggleCameraSelection = useCallback(
    async (cameraId: string) => {
      const currentSelected = config.selectedCameras ?? []

      const nextSelected = currentSelected.includes(cameraId)
        ? currentSelected.filter((id) => id !== cameraId)
        : [...currentSelected, cameraId]

      // Optimistic state update — card closes instantly in UI (0ms)
      setConfig((prev) => {
        const next = { ...prev, selectedCameras: nextSelected }
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(`${EXT_ID}:config`, JSON.stringify(next))
        }
        return next
      })

      try {
        await command('configure', { selectedCameras: nextSelected })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [config.selectedCameras]
  )

  // Applies the whole pending selection in one configure call: registers new
  // IP cameras and selects webcams/IPs together. Only called on confirm.
  const confirmAddCameras = useCallback(
    async (webcamIds: string[], ipDrafts: Array<{ name: string; url: string }>) => {
      setBusy(true)
      try {
        const configRes = await command<{ config: { ipCameras?: Array<{ id: string; name: string; url: string }> } }>(
          'configure',
          {}
        )
        const current = configRes.config || {}
        const ipCamerasList = Array.isArray(current.ipCameras) ? current.ipCameras : []
        const existingIpIds = new Set(ipCamerasList.map((c) => c.id))

        const newIpCameras: Array<{ id: string; name: string; url: string }> = []
        for (const draft of ipDrafts) {
          const id = `ip:${draft.url}`
          if (existingIpIds.has(id)) continue
          existingIpIds.add(id)
          newIpCameras.push({ id, name: draft.name || 'Câmera IP', url: draft.url })
        }

        const updatedIp = [...ipCamerasList, ...newIpCameras]
        const toAdd = new Set<string>(webcamIds)
        for (const cam of newIpCameras) toAdd.add(cam.id)
        const currentSelected = config.selectedCameras ?? []
        const nextSelected = [...new Set([...currentSelected, ...toAdd])]

        await command('configure', { ipCameras: updatedIp, selectedCameras: nextSelected })
        setConfig((prev) => {
          const next = { ...prev, selectedCameras: nextSelected }
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(`${EXT_ID}:config`, JSON.stringify(next))
          }
          return next
        })
        await refresh()
        setIsModalOpen(false)
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err))
      } finally {
        setBusy(false)
      }
    },
    [config.selectedCameras, refresh]
  )

  const describePrint = useCallback(
    async (snapshotId: string) => {
      setBusy(true)
      try {
        const res = await command<{ description: string }>('describe_snapshot', { snapshotId })
        await refreshGallery()
        if (expandedPrint && expandedPrint.id === snapshotId) {
          setExpandedPrint((prev) => (prev ? { ...prev, description: res.description } : null))
        }
        setError(res.description ? null : 'Descrição indisponível (visão offline)')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [expandedPrint, refreshGallery]
  )

  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const activeSelectedIds = config.selectedCameras ?? []

  // Keep the last known info per camera so a selected camera that temporarily
  // drops out of the enumerated list still renders its card (with its real
  // name) in an offline/reconnecting state instead of disappearing.
  const knownCamerasRef = useRef<Record<string, CameraInfo>>({})
  useEffect(() => {
    for (const c of cameras) {
      knownCamerasRef.current[c.id] = c
    }
  }, [cameras])

  const displayedCameras = useMemo(() => {
    const selectedSet = new Set(activeSelectedIds)
    const ordered: CameraInfo[] = []
    for (const id of activeSelectedIds) {
      const found = cameras.find((c) => c.id === id)
      if (found) {
        ordered.push(found)
      } else {
        const known = knownCamerasRef.current[id]
        ordered.push(
          known
            ? { ...known, online: false }
            : { id, name: 'Câmera', source: 'webcam', online: false, monitors: 0 }
        )
      }
    }
    for (const c of cameras) {
      if (selectedSet.has(c.id) && !ordered.some((item) => item.id === c.id)) {
        ordered.push(c)
      }
    }
    return ordered
  }, [cameras, activeSelectedIds])

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDraggedIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverIndex((prev) => (prev !== index ? index : prev))
  }, [])

  const handleDragLeave = useCallback(() => {}, [])

  const handleDrop = useCallback(
    (e: React.DragEvent, dropIndex: number) => {
      e.preventDefault()
      if (draggedIndex === null || draggedIndex === dropIndex) {
        setDraggedIndex(null)
        setDragOverIndex(null)
        return
      }

      const nextDisplayed = [...displayedCameras]
      const [removed] = nextDisplayed.splice(draggedIndex, 1)
      nextDisplayed.splice(dropIndex, 0, removed)

      const nextSelectedIds = nextDisplayed.map((c) => c.id)

      setConfig((prev) => {
        const next = { ...prev, selectedCameras: nextSelectedIds }
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(`${EXT_ID}:config`, JSON.stringify(next))
        }
        return next
      })

      void command('configure', { selectedCameras: nextSelectedIds })

      setDraggedIndex(null)
      setDragOverIndex(null)
    },
    [draggedIndex, displayedCameras]
  )

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null)
    setDragOverIndex(null)
  }, [])

  const activeCameras = monitors.filter((m) => m.cameraId)
  const cameraIds = new Set(cameras.map((c) => c.id))
  const orphanMonitors = activeCameras.filter((m) => !cameraIds.has(m.cameraId))

  const tabClass = (tab: string) =>
    `px-3.5 py-1.5 text-xs font-medium rounded-full transition-all ${
      activeTab === tab ? 'bg-emerald-600 text-white shadow-md' : 'bg-white/5 text-gray-300 hover:bg-white/10'
    }`

  return (
    <div className="relative w-full h-full min-h-screen max-h-screen overflow-y-auto p-4 md:p-6 text-gray-100 space-y-5 custom-scrollbar">
      <header className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <span className="text-emerald-400">
              <VisionIcon />
            </span>{' '}
            MomAI Vision
          </h1>
          <p className="text-xs text-gray-400 mt-0.5">
            Visão e monitoramento 100% locais — nada sai da sua máquina.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">
            {monitors.length} monitor{monitors.length !== 1 ? 'es' : ''} ativo{monitors.length !== 1 ? 's' : ''}
          </span>
          <button
            disabled={isRefreshing}
            onClick={() => void refresh()}
            className="text-xs rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 transition-all flex items-center gap-1.5 active:scale-95 disabled:opacity-60"
            title="Atualizar lista e conexão das câmeras"
          >
            <svg
              className={`w-3.5 h-3.5 text-emerald-400 transition-transform ${isRefreshing ? 'animate-spin' : ''}`}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21.5 2v6h-6M2.5 22v-6h6" />
              <path d="M2 11.5a10 10 0 0 1 18.8-4.3L21.5 8M2.5 16l1.2 0.8A10 10 0 0 0 22 12.5" />
            </svg>
            <span>{isRefreshing ? 'Atualizando...' : 'Atualizar'}</span>
          </button>
        </div>
      </header>

      <nav className="flex gap-2 mb-5">
        <button className={tabClass('cameras')} onClick={() => setActiveTab('cameras')}>
          Câmeras
        </button>
        <button className={tabClass('alerts')} onClick={() => setActiveTab('alerts')}>
          Alertas {alerts.length > 0 ? `(${alerts.length})` : ''}
        </button>
        <button className={tabClass('gallery')} onClick={() => setActiveTab('gallery')}>
          Prints
        </button>
        <button className={tabClass('settings')} onClick={() => setActiveTab('settings')}>
          Configurações
        </button>
      </nav>

      {error ? (
        <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300 flex items-center justify-between">
          <span>{error}</span>
          <button className="text-xs underline text-red-400 hover:text-red-200" onClick={() => setError(null)}>
            dispensar
          </button>
        </div>
      ) : null}

      {/* Tab: Cameras Grid */}
      {activeTab === 'cameras' ? (
        <section>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5 md:gap-6 items-stretch">
            {displayedCameras.map((camera, idx) => (
              <CameraCard
                key={camera.id}
                camera={camera}
                detections={detections}
                onSnapshot={takeSnapshot}
                onRemove={(id) => void toggleCameraSelection(id)}
                onExpand={(cam) => setExpandedCamera(cam)}
                onReload={() => void poll()}
                refreshKey={refreshKey}
                isActive={isActive}
                index={idx}
                isDragging={draggedIndex === idx}
                isDragOver={dragOverIndex === idx}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
              />
            ))}
            <AddCameraCard onClick={() => setIsModalOpen(true)} />
          </div>

          <div className="mt-6 rounded-2xl border border-white/10 bg-zinc-900/60 p-4 shadow-lg">
            <div className="flex items-center justify-between mb-3.5">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                Monitoramento Ativo
              </h3>
              <button
                onClick={() => {
                  setEditingMonitor(null)
                  setIsMonitorModalOpen(true)
                }}
                className="text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg px-3 py-1.5 transition-all shadow-md flex items-center gap-1.5 active:scale-95 cursor-pointer"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>Adicionar Monitoramento</span>
              </button>
            </div>
            {activeCameras.length === 0 ? (
              <p className="text-xs text-gray-400">
                Nenhum monitor ativo. Clique no botão verde acima para criar um monitoramento ou peça à MomAI no chat.
              </p>
            ) : (
              <ul className="space-y-2.5">
                {[...activeCameras, ...orphanMonitors].map((m) => (
                  <li key={m.id} className="flex items-center justify-between rounded-xl bg-white/5 p-3 border border-white/5 hover:border-white/10 transition-all">
                    <div>
                      <p className="text-sm font-semibold text-white flex items-center gap-2">
                        <span>{m.label || m.cameraName || m.cameraId}</span>
                        {m.cameraName && m.label ? (
                          <span className="text-[10px] text-gray-400 font-normal bg-white/5 px-2 py-0.5 rounded-full border border-white/5">
                            {m.cameraName}
                          </span>
                        ) : null}
                      </p>
                      <p className="text-xs text-gray-400 mt-0.5">
                        {m.triggers.map(formatTriggerPortuguese).join(' · ')}
                        {m.cooldownSec ? ` · Cooldown: ${m.cooldownSec}s` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setEditingMonitor(m)
                          setIsMonitorModalOpen(true)
                        }}
                        className="text-xs rounded-lg border border-white/15 hover:bg-white/10 px-2.5 py-1 text-gray-300 transition-colors"
                      >
                        Editar
                      </button>
                      <button
                        onClick={async () => {
                          await command('stop_monitoring', { monitorId: m.id })
                          void refresh()
                        }}
                        className="text-xs rounded-lg border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 text-red-300 px-2.5 py-1 transition-colors"
                      >
                        Parar
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : null}

      {/* Tab: Alerts Feed */}
      {activeTab === 'alerts' ? (
        <section className="space-y-3">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-semibold text-white">Histórico de Alertas</h3>
            {alerts.length > 0 ? (
              <button
                onClick={() => void handleClearAlerts()}
                className="text-xs text-red-400/80 hover:text-red-300 transition-colors flex items-center gap-1"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                limpar alertas
              </button>
            ) : null}
          </div>
          {alerts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/15 p-8 text-center text-sm text-gray-400">
              Nenhum alerta ainda. Os alertas aparecem aqui, no chat e no overlay flutuante.
            </div>
          ) : (
            alerts.map((alert: Alert, index: number) => {
              const imgSrc =
                alert.imageDataUri ||
                (alert.snapshotId
                  ? `${window.api?.getApiBaseUrl?.() || ''}/extensions/${EXT_ID}/storage/snapshots/${alert.snapshotId}.jpg`
                  : '')
              return (
                <div
                  key={`${alert.ts}-${index}`}
                  className="flex gap-3.5 items-center justify-between rounded-2xl border border-white/10 bg-zinc-900/70 p-3.5 hover:border-white/20 transition-all shadow-md"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-white truncate max-w-[70%]">
                        {alert.cameraName || 'Câmera'}
                        {alert.className ? ` · ${ptLabel(alert.className)}` : ''}
                        {alert.confidence ? ` ${Math.round(alert.confidence * 100)}%` : ''}
                      </p>
                      {alert.ts ? (
                        <span className="text-[11px] text-gray-400 font-medium shrink-0 bg-white/5 px-2 py-0.5 rounded-md border border-white/5">
                          {formatTime(alert.ts)}
                        </span>
                      ) : null}
                    </div>
                    {alert.description ? (
                      <p className="text-xs text-gray-300 mt-1">{alert.description}</p>
                    ) : null}
                    {alert.triggeredBy ? (
                      <span className="inline-block mt-1.5 text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20 font-mono">
                        {alert.triggeredBy}
                      </span>
                    ) : null}
                  </div>
                  {imgSrc ? (
                    <div
                      className="group relative w-32 h-20 rounded-xl bg-black shrink-0 overflow-hidden cursor-pointer border border-white/10 hover:border-emerald-500/60 transition-all shadow-sm"
                      onClick={() => setExpandedAlert(alert)}
                      title="Clique para ampliar em tela cheia"
                    >
                      <AlertCanvasOverlay
                        imageDataUri={imgSrc}
                        boxes={alert.boxes}
                        objectFit="object-cover"
                      />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center z-20">
                        <div className="w-8 h-8 rounded-full bg-black/70 text-white flex items-center justify-center backdrop-blur-sm shadow border border-white/20 group-hover:scale-110 transition-transform">
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                          </svg>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
        </section>
      ) : null}

      {/* Tab: Prints Gallery */}
      {activeTab === 'gallery' ? (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-white">Prints da Câmera</h3>
            <div className="flex items-center gap-3">
              <button onClick={() => void refreshGallery()} className="text-xs text-gray-400 hover:text-gray-200 transition-colors">
                atualizar
              </button>
              {snapshots.length > 0 ? (
                <button
                  onClick={() => void handleClearAllPrints()}
                  className="text-xs text-red-400/80 hover:text-red-300 transition-colors flex items-center gap-1"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  excluir todos
                </button>
              ) : null}
            </div>
          </div>
          {snapshots.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/15 p-8 text-center text-sm text-gray-400">
              Galeria de prints vazia. Print por print, a MomAI monta seu histórico visual.
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 auto-rows-fr">
              {snapshots.map((snap: Snapshot) => (
                <figure
                  key={snap.id}
                  onClick={() => setExpandedPrint(snap)}
                  onContextMenu={(e) => handleContextMenu(e, snap)}
                  className="group rounded-xl overflow-hidden border border-white/10 bg-zinc-900/60 cursor-pointer hover:border-emerald-500/50 transition-all shadow-md flex flex-col h-full"
                >
                  <div className="relative w-full aspect-video bg-black overflow-hidden shrink-0" style={{ aspectRatio: '16 / 9' }}>
                    <img
                      src={
                        snap.imageDataUri ||
                        `${window.api?.getApiBaseUrl?.() || ''}/extensions/${EXT_ID}/storage/snapshots/${snap.id}.jpg`
                      }
                      alt={snap.description || 'Print'}
                      loading="lazy"
                      className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    />
                    <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <span className="text-xs font-medium text-white bg-black/60 px-2 py-1 rounded-md backdrop-blur-sm">
                        Ampliar print
                      </span>
                    </div>
                  </div>
                  <figcaption className="px-2.5 py-2 flex-1 flex flex-col justify-between">
                    <p className="text-[11px] text-gray-300 font-medium truncate">{snap.description || formatTime(snap.ts)}</p>
                    <div className="flex items-center justify-between mt-1 pt-1 border-t border-white/5">
                      <span className="text-[10px] text-gray-500">{formatTime(snap.ts)}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleDeletePrint(snap.id)
                        }}
                        title="Excluir print"
                        className="p-1 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    </div>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {/* Tab: Settings (Centered & Glassmorphic) */}
      {activeTab === 'settings' ? (
        <section className="space-y-6 max-w-2xl mx-auto pb-12 animate-fadeIn">
          <div className="text-center mb-6">
            <h2 className="text-lg font-bold text-white flex items-center justify-center gap-2">
              <svg className="w-5 h-5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
              Configurações do Vision
            </h2>
            <p className="text-xs text-gray-400 mt-1">
              Ajuste suas preferências de câmeras, retenção de prints e modos de rastreamento local.
            </p>
          </div>



          <div className="rounded-2xl border border-white/10 bg-zinc-900/70 backdrop-blur-md p-6 shadow-xl space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                Retenção de Prints
              </h3>
              <p className="text-xs text-gray-400 mt-0.5">
                Defina o limite de armazenamento local para galeria de prints e histórico.
              </p>
            </div>
            <div className="space-y-3">
              <label className="flex items-center justify-between text-xs text-gray-300 bg-white/5 p-3 rounded-xl border border-white/5">
                <span>Dias de armazenamento (padrão: 7)</span>
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={config.retentionDays ?? 7}
                  onChange={(e) => void saveSettings({ retentionDays: Number(e.target.value) || 7 })}
                  className="w-20 bg-black/40 border border-white/10 rounded-lg px-2.5 py-1.5 text-sm text-right text-gray-100 focus:outline-none focus:border-emerald-500"
                />
              </label>
              <label className="flex items-center justify-between text-xs text-gray-300 bg-white/5 p-3 rounded-xl border border-white/5">
                <span>Máximo de arquivos armazenados (padrão: 200)</span>
                <input
                  type="number"
                  min={20}
                  max={1000}
                  value={config.maxSnapshots ?? 200}
                  onChange={(e) => void saveSettings({ maxSnapshots: Number(e.target.value) || 200 })}
                  className="w-20 bg-black/40 border border-white/10 rounded-lg px-2.5 py-1.5 text-sm text-right text-gray-100 focus:outline-none focus:border-emerald-500"
                />
              </label>
            </div>
            <p className="text-[11px] text-gray-500">
              Prints ficam guardados localmente no seu computador. Frames ao vivo em vídeo nunca são gravados em disco.
            </p>
          </div>
        </section>
      ) : null}

      {/* Modals */}
      <AddEditMonitorModal
        key={isMonitorModalOpen ? (editingMonitor?.id || 'new') : 'closed'}
        isOpen={isMonitorModalOpen}
        onClose={() => {
          setIsMonitorModalOpen(false)
          setEditingMonitor(null)
        }}
        cameras={cameras}
        initialMonitor={editingMonitor}
        onSave={() => void poll()}
      />

      <AddCameraModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        allCameras={cameras}
        selectedCameraIds={activeSelectedIds}
        onConfirm={confirmAddCameras}
      />

      <ExpandedCameraModal
        camera={expandedCamera}
        detections={detections}
        onClose={() => setExpandedCamera(null)}
        onSnapshot={takeSnapshot}
      />

      <ExpandedPrintModal
        snap={expandedPrint}
        onClose={() => setExpandedPrint(null)}
        onDescribe={describePrint}
        onDelete={handleDeletePrint}
        busy={busy}
      />

      {/* Right Click Context Menu */}
      {contextMenu ? (
        <div
          className="fixed z-50 min-w-[140px] py-1 bg-zinc-900/95 border border-white/15 rounded-xl shadow-2xl backdrop-blur-md animate-fadeIn text-xs text-gray-200 overflow-hidden"
          style={{
            top: Math.min(contextMenu.y, window.innerHeight - 100),
            left: Math.min(contextMenu.x, window.innerWidth - 150)
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => void handleCopyPrint(contextMenu.snap)}
            className="w-full px-3 py-2 text-left hover:bg-white/10 flex items-center gap-2 transition-colors text-gray-200"
          >
            <svg className="w-3.5 h-3.5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
            Copiar
          </button>
          <button
            onClick={() => {
              const snapId = contextMenu.snap.id
              setContextMenu(null)
              void handleDeletePrint(snapId)
            }}
            className="w-full px-3 py-2 text-left hover:bg-red-500/20 text-red-400 flex items-center gap-2 transition-colors"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            Excluir
          </button>
        </div>
      ) : null}

      {/* Expanded Alert Lightbox Modal */}
      {expandedAlert ? (
        <ExpandedAlertModal
          alert={expandedAlert}
          onClose={() => setExpandedAlert(null)}
        />
      ) : null}

      {/* Copy Toast Notification */}
      {copyToast ? (
        <div className="fixed bottom-5 right-5 z-50 bg-emerald-600 text-white text-xs px-3 py-2 rounded-xl shadow-xl animate-fadeIn flex items-center gap-1.5 font-medium">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M20 6L9 17l-5-5" />
          </svg>
          {copyToast}
        </div>
      ) : null}
    </div>
  )
}
