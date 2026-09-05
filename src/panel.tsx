/**
 * MomAI Vision — panel (compact status + floating overlay alert card).
 *
 * The same `vision_alert` renderer serves two contexts: the floating
 * overlay window (open_overlay) and chat cards (structuredResponse).
 */

import { useEffect, useRef, useState } from 'react'
import { getSDK } from 'momai:sdk'
import ContextMenu from './components/ContextMenu'
import { localizedClassLabel, localizedTriggerLabel, ptLabel } from './vision/labels'
import { classColor } from './vision/theme-color'
import { useI18n } from './hooks/useI18n'
import visionIconPng from '../icon.png'

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

/**
 * SVG-based bounding box overlay for alert snapshots.
 * Replaces the old Canvas 2D approach — React handles the redraw
 * automatically when `boxes` changes.
 */
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
  const imgRef = useRef<HTMLImageElement | null>(null)
  const [frameDims, setFrameDims] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const onLoad = () => {
      if (img.naturalWidth && img.naturalHeight) {
        setFrameDims({ w: img.naturalWidth, h: img.naturalHeight })
      }
    }
    if (img.complete && img.naturalWidth) onLoad()
    img.addEventListener('load', onLoad)
    return () => img.removeEventListener('load', onLoad)
  }, [imageDataUri])

  const isContain = objectFit === 'object-contain'
  const validSrc =
    typeof imageDataUri === 'string' &&
    !imageDataUri.includes('{{') &&
    (imageDataUri.startsWith('data:image/') ||
      imageDataUri.startsWith('http://') ||
      imageDataUri.startsWith('https://') ||
      imageDataUri.startsWith('/'))
      ? imageDataUri
      : undefined

  return (
    <div ref={containerRef} className={`relative w-full h-full bg-black overflow-hidden ${className}`}>
      {validSrc ? (
        <img
          ref={imgRef}
          src={validSrc}
          alt="Snapshot"
          className={`absolute inset-0 w-full h-full ${objectFit}`}
          onError={(e) => {
            ;(e.currentTarget as HTMLElement).style.display = 'none'
          }}
        />
      ) : null}
      {boxes && boxes.length > 0 ? (
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none z-10"
          viewBox={isContain && frameDims ? `0 0 ${frameDims.w} ${frameDims.h}` : undefined}
          preserveAspectRatio={isContain ? 'xMidYMid meet' : undefined}
        >
          {boxes.map((box, i) => {
            const color = classColor(box.className)
            const x1 = box.x1 * 100
            const y1 = box.y1 * 100
            const w = (box.x2 - box.x1) * 100
            const h = (box.y2 - box.y1) * 100
            return (
              <g key={`${box.className}-${i}`}>
                <rect
                  x={`${x1}%`} y={`${y1}%`} width={`${w}%`} height={`${h}%`}
                  stroke={color} strokeWidth="2" fill="none"
                />
                <rect
                  x={`${x1}%`} y={`${Math.max(0, y1 - 3)}%`} width={`${w}%`} height="3%"
                  fill={color}
                />
                <text
                  x={`${x1 + 0.5}%`} y={`${Math.max(1.5, y1 - 0.5)}%`}
                  fill="#0a0a0a" fontSize="12" fontFamily="sans-serif" fontWeight="bold"
                >
                  {ptLabel(box.className)} {Math.round(box.confidence * 100)}%
                </text>
              </g>
            )
          })}
        </svg>
      ) : null}
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
    <img
      src={visionIconPng}
      alt="MomAI Vision"
      className={`${className} object-contain inline-block shrink-0`}
      draggable={false}
    />
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

export function VisionAlertCard({ data }: { data?: AlertData }): JSX.Element {
  const { t } = useI18n()
  const [stopping, setStopping] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const isOverlay = typeof data?.onClose === 'function'
  const isSnapshot = data?.triggeredBy === 'snapshot'
  const [effectiveImageUri, setEffectiveImageUri] = useState<string | undefined>(data?.imageDataUri)

  useEffect(() => {
    if (data?.imageDataUri) {
      setEffectiveImageUri(data.imageDataUri)
      return
    }
    if (!data?.snapshotId) return
    let cancelled = false
    sdk.api
      .get<{ dataUri?: string }>(`/extensions/${EXT_ID}/snapshot/${data.snapshotId}`)
      .then((res) => {
        if (!cancelled && res.ok && res.data?.dataUri) {
          setEffectiveImageUri(res.data.dataUri)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [data?.imageDataUri, data?.snapshotId])

  const toggleExpand = () => {
    const next = !expanded
    setExpanded(next)
    if (!isOverlay) return
    const cleanData = data ? { ...data, onClose: undefined } : undefined
    const resize = (aspect: number) => {
      const screenW = (window as any).screen?.availWidth || 1920
      const screenH = (window as any).screen?.availHeight || 1080
      const maxW = Math.round(screenW * 0.85)
      const maxH = Math.round(screenH * 0.85)
      let w = Math.min(1080, maxW)
      let h = Math.round(w / aspect)
      if (h > Math.min(maxH, screenH - 80)) {
        h = Math.max(240, Math.min(maxH, screenH - 80))
        w = Math.round(h * aspect)
      }
      ;(window as any).api.openOverlay({
        skillId: EXT_ID,
        panel: 'dist/panel.js',
        panelType: 'extension-panel',
        overlayId: cleanData?.cameraId ? `vision-cam-${cleanData.cameraId}` : undefined,
        overlay_id: cleanData?.cameraId ? `vision-cam-${cleanData.cameraId}` : undefined,
        overlaySize: { width: w, height: h },
        strategy: 'stack',
        structuredResponse: { type: 'vision_alert', data: cleanData }
      })
    }
    if (!next) {
      ;(window as any).api.openOverlay({
        skillId: EXT_ID,
        panel: 'dist/panel.js',
        panelType: 'extension-panel',
        overlayId: cleanData?.cameraId ? `vision-cam-${cleanData.cameraId}` : undefined,
        overlay_id: cleanData?.cameraId ? `vision-cam-${cleanData.cameraId}` : undefined,
        overlaySize: { width: 480, height: 560 },
        strategy: 'stack',
        structuredResponse: { type: 'vision_alert', data: cleanData }
      })
      return
    }
    if (effectiveImageUri) {
      const img = new Image()
      img.onload = () => {
        const aspect =
          img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 16 / 9
        resize(aspect)
      }
      img.onerror = () => resize(16 / 9)
      img.src = effectiveImageUri
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
        {effectiveImageUri ? (
          <AlertCanvasOverlay
            imageDataUri={effectiveImageUri}
            boxes={data?.boxes}
            objectFit="object-contain"
          />
        ) : (
          <p className="text-sm text-gray-400">{t('gallery.emptyTitle')}</p>
        )}
        <button
          onClick={toggleExpand}
          className="absolute top-3 right-3 rounded-full bg-black/60 hover:bg-black/80 text-gray-300 p-2 z-20"
          style={{ WebkitAppRegion: 'no-drag' } as any}
          aria-label={t('panel.viewSnapshot')}
          title={t('panel.viewSnapshot')}
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
          </svg>
        </button>
      </div>
    )
  }

  const title = data?.cameraName || t('name') || 'MomAI Vision'
  const subtitle = data?.className
    ? `${data.cameraName || t('nav.cameras')} · ${localizedClassLabel(data.className, t)}${data.confidence ? ` ${Math.round(data.confidence * 100)}%` : ''}`
    : isSnapshot
      ? t('triggers.snapshot')
      : data?.cameraName || ''

  return (
    <div
      className={`w-full ${expanded && isOverlay ? '' : 'max-w-md'} rounded-xl border border-white/10 bg-zinc-900/95 text-gray-100 shadow-lg overflow-hidden`}
      style={isOverlay ? ({ WebkitAppRegion: 'no-drag' } as any) : undefined}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
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
          {effectiveImageUri ? (
            <button
              onClick={toggleExpand}
              className="rounded-full p-1.5 text-gray-400 hover:bg-white/10 hover:text-white transition-colors"
              title={t('panel.viewSnapshot')}
              aria-label={t('panel.viewSnapshot')}
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
              aria-label={t('common.close')}
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      {effectiveImageUri ? (
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
          title={t('panel.viewSnapshot')}
        >
          <AlertCanvasOverlay
            imageDataUri={effectiveImageUri}
            boxes={data?.boxes}
            objectFit={expanded ? 'object-contain' : 'object-cover'}
          />
        </div>
      ) : null}

      <div
        className="px-4 py-3"
        style={isOverlay ? ({ WebkitAppRegion: 'no-drag' } as any) : undefined}
      >
        <p className="text-sm text-gray-300">
          {data?.description || (isSnapshot ? t('triggers.snapshot') : t('alerts.title'))}
        </p>
        {data?.triggeredBy && !isSnapshot ? (
          <p className="mt-1 text-xs text-gray-500">{formatTime(data.ts)} · {localizedTriggerLabel(data, t)}</p>
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
            {t('panel.openDashboard')}
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
              {stopping ? t('common.loading') : t('monitoring.paused')}
            </button>
          ) : null}
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            ...(data?.imageDataUri
              ? [
                  {
                    id: 'expand',
                    label: t('panel.viewSnapshot'),
                    onClick: toggleExpand
                  }
                ]
              : []),
            {
              id: 'copy-desc',
              label: t('common.confirm'),
              onClick: () => {
                try {
                  void navigator.clipboard?.writeText?.(
                    data?.description || (isSnapshot ? t('triggers.snapshot') : t('alerts.title'))
                  )
                } catch {}
              }
            },
            ...(typeof data?.onClose === 'function'
              ? [
                  {
                    id: 'close',
                    label: t('common.close'),
                    onClick: () => data?.onClose?.()
                  }
                ]
              : [])
          ]}
        />
      )}
    </div>
  )
}

sdk.registry.registerRenderer('vision_alert', VisionAlertCard)

interface Status {
  monitors?: Array<{ id: string; cameraName?: string; triggers?: Array<{ type: string }>; createdAt?: number }>
  cameras?: Record<string, { online: boolean; monitors: number }>
}

export default function VisionPanel(props: { data?: unknown }): JSX.Element {
  const { t } = useI18n()
  const [status, setStatus] = useState<Status | null>(null)
  const [monitorMenu, setMonitorMenu] = useState<{
    x: number
    y: number
    id: string
    cameraName?: string
  } | null>(null)

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
        <h3 className="text-sm font-semibold">{t('name')}</h3>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="rounded-xl bg-white/5 p-3">
          <p className="text-lg font-bold text-emerald-400">{Object.keys(cameras).length}</p>
          <p className="text-xs text-gray-400">{t('nav.cameras')} ({onlineCount} {t('cameras.statusOnline')})</p>
        </div>
        <div className="rounded-xl bg-white/5 p-3">
          <p className="text-lg font-bold text-emerald-400">{monitors.length}</p>
          <p className="text-xs text-gray-400">{t('monitoring.active')}</p>
        </div>
      </div>
      {monitors.length > 0 ? (
        <ul className="space-y-1.5">
          {monitors.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 cursor-context-menu"
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setMonitorMenu({ x: e.clientX, y: e.clientY, id: m.id, cameraName: m.cameraName })
              }}
            >
              <div className="min-w-0">
                <p className="text-xs font-medium truncate">{m.cameraName || m.id}</p>
                <p className="text-[11px] text-gray-400">
                  {m.triggers?.map((tr) => tr.type).join(', ') || '—'}
                </p>
              </div>
              <span className="ml-2 shrink-0 w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-gray-400">{t('monitoring.emptyTitle')}</p>
      )}
      {monitorMenu && (
        <ContextMenu
          x={monitorMenu.x}
          y={monitorMenu.y}
          onClose={() => setMonitorMenu(null)}
          items={[
            {
              id: 'pause',
              label: t('monitoring.paused'),
              onClick: () => {
                void pauseMonitor(monitorMenu.id).catch(() => {})
              }
            }
          ]}
        />
      )}
    </div>
  )
}
