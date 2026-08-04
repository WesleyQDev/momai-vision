/**
 * MomAI Vision — dashboard page.
 *
 * Camera grid with live preview (webcam getUserMedia + IP/MJPEG), bounding
 * boxes drawn on a transparent canvas over each video, alerts feed, snapshot
 * gallery and settings. Detection data comes from the worker through the
 * extension command routes and SSE events.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getSDK } from 'momai:sdk'

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
}

interface VisionConfig {
  defaultCamera?: string | null
  retentionDays?: number
  maxSnapshots?: number
  trackingMode?: 'fluid' | 'balanced' | 'economy'
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
  return new Date(ts).toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

async function command<T = unknown>(toolName: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await sdk.api.post<{ ok: boolean; error?: string } & T>(
    `/extensions/${EXT_ID}/command`,
    { toolName, args }
  )
  if (!res.ok || res.data?.ok === false) {
    throw new Error(res.data?.error || `command failed: ${toolName}`)
  }
  return res.data as T
}

const PUMP_INTERVALS: Record<string, number> = { fluid: 500, balanced: 1000, economy: 2000 }

// ---------------------------------------------------------------------------
// Camera card with live preview + bounding boxes
// ---------------------------------------------------------------------------

function CameraCard({
  camera,
  detections,
  onSnapshot
}: {
  camera: CameraInfo
  detections: Record<string, Detection[]>
  onSnapshot: (cameraId: string) => void
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<string>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(`${EXT_ID}:mode`) : null
    return saved || 'balanced'
  })
  const pumpTimer = useRef<number | null>(null)

  const drawBoxes = useCallback(() => {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = video.clientWidth || canvas.clientWidth
    const h = video.clientHeight || canvas.clientHeight
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
      ctx.fillText(`${box.className} ${Math.round(box.confidence * 100)}%`, box.x1 * w + 4, Math.max(0, box.y1 * h - 6))
    }
  }, [camera.id, detections])

  useEffect(() => {
    if (!videoRef.current) return
    let cancelled = false

    if (camera.source === 'webcam' && camera.id.startsWith('webcam:')) {
      const deviceId = camera.id.slice('webcam:'.length)
      navigator.mediaDevices
        .getUserMedia({
          audio: false,
          video: { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
        })
        .then((stream) => {
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop())
            return
          }
          streamRef.current = stream
          const video = videoRef.current!
          video.srcObject = stream
          setReady(true)
          setError(null)
        })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    } else {
      setReady(true)
    }

    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [camera.id, camera.source])

  useEffect(() => {
    drawBoxes()
  }, [detections, drawBoxes])

  useEffect(() => {
    const video = videoRef.current
    if (!video || camera.source !== 'webcam') return
    const interval = PUMP_INTERVALS[mode] || 1000
    const canvas = document.createElement('canvas')
    const run = async () => {
      if (document.hidden) return
      if (!video.videoWidth) return
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(video, 0, 0)
      const jpegBase64 = canvas.toDataURL('image/jpeg', 0.7).split(',')[1]
      try {
        await command<{ detections?: Detection[] }>('frame_pump', { jpegBase64 })
      } catch {
        // transient — keep pumping
      }
    }
    void run()
    pumpTimer.current = window.setInterval(() => void run(), interval)
    return () => {
      if (pumpTimer.current) clearInterval(pumpTimer.current)
    }
  }, [camera.id, camera.source, mode])

  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/60 overflow-hidden">
      <div className="relative aspect-video bg-black">
        {camera.source === 'ip' ? (
          <img
            src={camera.id.slice('ip:'.length)}
            alt={camera.name}
            className="w-full h-full object-contain"
            onError={() => setError('Não foi possível conectar')}
          />
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-contain"
          />
        )}
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-red-400 bg-black/60">
            {error}
          </div>
        ) : null}
        {!ready && camera.source === 'webcam' && !error ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400">
            Iniciando câmera...
          </div>
        ) : null}
        <div className="absolute top-2 left-2 flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${camera.online ? 'bg-emerald-400' : 'bg-red-500'}`} />
          <span className="text-[11px] font-medium text-white drop-shadow bg-black/40 rounded px-1.5 py-0.5">
            {camera.name}
          </span>
        </div>
        {camera.monitors > 0 ? (
          <span className="absolute top-2 right-2 text-[11px] font-medium text-emerald-300 bg-emerald-500/20 border border-emerald-500/40 rounded-full px-2 py-0.5">
            {camera.monitors} monitor{camera.monitors > 1 ? 'es' : ''}
          </span>
        ) : null}
      </div>
      <div className="flex items-center justify-between px-3 py-2">
        {camera.source === 'webcam' ? (
          <select
            value={mode}
            onChange={(e) => {
              setMode(e.target.value)
              localStorage.setItem(`${EXT_ID}:mode`, e.target.value)
            }}
            className="text-[11px] bg-white/5 border border-white/10 rounded px-1.5 py-1 text-gray-300"
            title="Modo de rastreamento"
          >
            <option value="fluid">Fluido</option>
            <option value="balanced">Equilibrado</option>
            <option value="economy">Economia</option>
          </select>
        ) : (
          <span className="text-[11px] text-gray-500">MJPEG/IP</span>
        )}
        <button
          onClick={() => onSnapshot(camera.id)}
          className="text-[11px] font-medium rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-2.5 py-1 transition-colors"
        >
          Tirar snapshot
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function VisionPage(): JSX.Element {
  const [cameras, setCameras] = useState<CameraInfo[]>([])
  const [monitors, setMonitors] = useState<MonitorInfo[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [config, setConfig] = useState<VisionConfig>({})
  const [detections, setDetections] = useState<Record<string, Detection[]>>({})
  const [activeTab, setActiveTab] = useState<'cameras' | 'alerts' | 'gallery' | 'settings'>('cameras')
  const [ipUrl, setIpUrl] = useState('')
  const [ipName, setIpName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [camRes, statusRes] = await Promise.all([
        command<{ cameras: CameraInfo[] }>('list_cameras'),
        command<{ monitors: MonitorInfo[] }>('get_status')
      ])
      setCameras(camRes.cameras || [])
      setMonitors(statusRes.monitors || [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const refreshGallery = useCallback(async () => {
    try {
      const res = await command<{ snapshots: Snapshot[] }>('list_snapshots', { limit: 60 })
      setSnapshots(res.snapshots || [])
    } catch {}
  }, [])

  useEffect(() => {
    void refresh()
    void refreshGallery()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [refresh, refreshGallery])

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

  const addIpCamera = useCallback(async () => {
    if (!ipUrl) return
    setBusy(true)
    setError(null)
    try {
      const configRes = await command<{ config: { ipCameras?: Array<{ id: string; name: string; url: string }> } }>(
        'configure',
        {}
      )
      const current = configRes.config || {}
      const ipCameras = Array.isArray(current.ipCameras) ? current.ipCameras : []
      const id = `ip:${ipUrl}`
      if (ipCameras.some((c) => c.id === id)) {
        setError('Esta câmera já foi adicionada.')
        return
      }
      const updated = [...ipCameras, { id, name: ipName || 'Câmera IP', url: ipUrl }]
      await command('configure', { ipCameras: updated })
      setIpUrl('')
      setIpName('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [ipUrl, ipName, refresh])

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

  const activeCameras = monitors.filter((m) => m.cameraId)
  const cameraIds = new Set(cameras.map((c) => c.id))
  const orphanMonitors = activeCameras.filter((m) => !cameraIds.has(m.cameraId))

  const tabClass = (tab: string) =>
    `px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
      activeTab === tab ? 'bg-emerald-600 text-white' : 'bg-white/5 text-gray-300 hover:bg-white/10'
    }`

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-6 text-gray-100">
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
            onClick={() => void refresh()}
            className="text-xs rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 px-3 py-1.5 transition-colors"
          >
            Atualizar
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
          Galeria
        </button>
        <button className={tabClass('settings')} onClick={() => setActiveTab('settings')}>
          Configurações
        </button>
      </nav>

      {error ? (
        <div className="mb-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>
            dispensar
          </button>
        </div>
      ) : null}

      {activeTab === 'cameras' ? (
        <section>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {cameras.map((camera) => (
              <CameraCard
                key={camera.id}
                camera={camera}
                detections={detections}
                onSnapshot={takeSnapshot}
              />
            ))}
            {cameras.length === 0 ? (
              <div className="col-span-full flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/15 p-10 text-center">
                <VisionIcon className="w-10 h-10 text-gray-500 mb-3" />
                <p className="text-sm text-gray-300 font-medium">Nenhuma câmera configurada</p>
                <p className="text-xs text-gray-500 mt-1 max-w-sm">
                  Adicione uma câmera IP (URL MJPEG) ou conecte uma webcam para começar a ver e
                  monitorar.
                </p>
                <button
                  onClick={() => setActiveTab('settings')}
                  className="mt-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium px-5 py-2.5 transition-colors"
                >
                  Adicionar câmeras
                </button>
              </div>
            ) : null}
          </div>

          <div className="mt-6 rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
            <h3 className="text-sm font-semibold mb-3">Monitoramento ativo</h3>
            {activeCameras.length === 0 ? (
              <p className="text-xs text-gray-400">
                Nenhum monitor ativo. Peça à MomAI no chat: “me avise quando alguém chegar em casa”.
              </p>
            ) : (
              <ul className="space-y-2">
                {[...activeCameras, ...orphanMonitors].map((m) => (
                  <li key={m.id} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
                    <div>
                      <p className="text-sm font-medium">{m.cameraName || m.cameraId}</p>
                      <p className="text-xs text-gray-400">
                        {m.triggers.map((t) => t.type).join(' · ')}
                        {m.schedule?.start ? ` · ${m.schedule.start}-${m.schedule.end}` : ''}
                        {m.label ? ` · ${m.label}` : ''}
                      </p>
                    </div>
                    <button
                      onClick={async () => {
                        await command('stop_monitoring', { monitorId: m.id })
                        void refresh()
                      }}
                      className="text-xs rounded-lg border border-white/15 hover:bg-white/10 px-2.5 py-1 transition-colors"
                    >
                      Parar
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : null}

      {activeTab === 'alerts' ? (
        <section className="space-y-3">
          {alerts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/15 p-8 text-center text-sm text-gray-400">
              Nenhum alerta ainda. Os alertas aparecem aqui, no chat e no overlay flutuante.
            </div>
          ) : (
            alerts.map((alert: Alert, index: number) => (
              <div
                key={`${alert.ts}-${index}`}
                className="flex gap-3 rounded-2xl border border-white/10 bg-zinc-900/60 p-3"
              >
                {alert.imageDataUri ? (
                  <img
                    src={alert.imageDataUri}
                    alt=""
                    className="w-28 h-20 object-cover rounded-lg bg-black shrink-0 cursor-pointer"
                    onClick={() => window.open(alert.imageDataUri!)}
                  />
                ) : null}
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {alert.cameraName || 'Câmera'}
                    {alert.className ? ` · ${alert.className}` : ''}
                    {alert.confidence ? ` ${Math.round(alert.confidence * 100)}%` : ''}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">{alert.description}</p>
                  <p className="text-[11px] text-gray-500 mt-1">{formatTime(alert.ts)}</p>
                </div>
              </div>
            ))
          )}
        </section>
      ) : null}

      {activeTab === 'gallery' ? (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold">Snapshots</h3>
            <button onClick={() => void refreshGallery()} className="text-xs text-gray-400 hover:text-gray-200">
              atualizar
            </button>
          </div>
          {snapshots.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/15 p-8 text-center text-sm text-gray-400">
              Galeria vazia. Snapshot por snapshot, a MomAI monta o histórico.
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {snapshots.map((snap: Snapshot) => (
                <figure key={snap.id} className="rounded-xl overflow-hidden border border-white/10 bg-zinc-900/60">
                  <img
                    src={`${window.api?.getApiBaseUrl?.() || ''}/extensions/${EXT_ID}/storage/snapshots/${snap.id}.jpg`}
                    alt={snap.description || 'Snapshot'}
                    loading="lazy"
                    className="w-full aspect-video object-cover bg-black"
                  />
                  <figcaption className="px-2 py-1.5">
                    <p className="text-[11px] text-gray-400 truncate">{snap.description || formatTime(snap.ts)}</p>
                    <p className="text-[10px] text-gray-500">{formatTime(snap.ts)}</p>
                    <button
                      onClick={async () => {
                        try {
                          const res = await command<{ description: string }>('describe_snapshot', {
                            snapshotId: snap.id
                          })
                          void refreshGallery()
                          setError(res.description ? null : 'Descrição indisponível (visão offline)')
                        } catch (err) {
                          setError(err instanceof Error ? err.message : String(err))
                        }
                      }}
                      className="mt-1 text-[11px] font-medium text-emerald-400 hover:text-emerald-300"
                    >
                      Descrever de novo
                    </button>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {activeTab === 'settings' ? (
        <section className="space-y-5 max-w-xl">
          <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
            <h3 className="text-sm font-semibold mb-3">Câmera padrão</h3>
            <select
              value={config.defaultCamera || ''}
              onChange={(e) => void saveSettings({ defaultCamera: e.target.value || null })}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200"
            >
              <option value="">— perguntar sempre —</option>
              {cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
            <h3 className="text-sm font-semibold mb-3">Adicionar câmera IP/MJPEG</h3>
            <div className="space-y-2">
              <input
                value={ipName}
                onChange={(e) => setIpName(e.target.value)}
                placeholder="Nome (ex.: Garagem)"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
              />
              <input
                value={ipUrl}
                onChange={(e) => setIpUrl(e.target.value)}
                placeholder="URL MJPEG (http://camera:port/video)"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
              />
              <button
                disabled={busy || !ipUrl}
                onClick={() => void addIpCamera()}
                className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-sm font-medium py-2 transition-colors"
              >
                Adicionar
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4">
            <h3 className="text-sm font-semibold mb-3">Retenção de snapshots</h3>
            <label className="flex items-center justify-between text-xs text-gray-300 mb-2">
              <span>Dias (padrão: 7)</span>
              <input
                type="number"
                min={1}
                max={90}
                value={config.retentionDays ?? 7}
                onChange={(e) => void saveSettings({ retentionDays: Number(e.target.value) || 7 })}
                className="w-20 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-right"
              />
            </label>
            <label className="flex items-center justify-between text-xs text-gray-300">
              <span>Máximo de arquivos (padrão: 200)</span>
              <input
                type="number"
                min={20}
                max={1000}
                value={config.maxSnapshots ?? 200}
                onChange={(e) => void saveSettings({ maxSnapshots: Number(e.target.value) || 200 })}
                className="w-20 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-right"
              />
            </label>
            <p className="text-[11px] text-gray-500 mt-3">
              Snapshots ficam no diretório local da extensão. Frames ao vivo nunca são gravados.
            </p>
          </div>
        </section>
      ) : null}
    </div>
  )
}
