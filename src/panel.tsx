/**
 * MomAI Vision — panel (compact status + floating overlay alert card).
 *
 * The same `vision_alert` renderer serves two contexts: the floating
 * overlay window (open_overlay) and chat cards (structuredResponse).
 */

import { useEffect, useState } from 'react'
import { getSDK } from 'momai:sdk'

const sdk = getSDK()
const EXT_ID = 'momai-vision'

interface AlertData {
  cameraId?: string
  cameraName?: string
  monitorId?: string
  monitorLabel?: string
  triggeredBy?: string
  className?: string
  confidence?: number
  snapshotId?: string
  ts?: number
  description?: string
  imageDataUri?: string
  onClose?: () => void
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

async function stopMonitor(monitorId: string | undefined, onClose?: () => void): Promise<void> {
  if (!monitorId) return
  await sdk.api.post(`/extensions/${EXT_ID}/command`, {
    toolName: 'stop_monitoring',
    args: { monitorId }
  })
  onClose?.()
}

function VisionAlertCard({ data }: { data?: AlertData }): JSX.Element {
  const [stopping, setStopping] = useState(false)
  const title = data?.cameraName || 'MomAI Vision'
  const subtitle = data?.className
    ? `${data.cameraName || 'Câmera'} · ${data.className}${data.confidence ? ` ${Math.round(data.confidence * 100)}%` : ''}`
    : data?.triggeredBy === 'snapshot'
      ? 'Snapshot'
      : data?.cameraName || ''

  return (
    <div className="w-full max-w-md rounded-2xl border border-emerald-500/30 bg-zinc-900/95 text-gray-100 shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-emerald-600 to-green-700">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg">👁️</span>
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{title}</p>
            <p className="text-xs text-emerald-100/90 truncate">{subtitle || formatTime(data?.ts)}</p>
          </div>
        </div>
        <button
          onClick={data?.onClose}
          className="shrink-0 rounded-full p-1.5 text-emerald-50 hover:bg-white/20 transition-colors"
          aria-label="Fechar"
        >
          <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
            <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
          </svg>
        </button>
      </div>

      {data?.imageDataUri ? (
        <img src={data.imageDataUri} alt="Snapshot" className="w-full max-h-56 object-cover bg-black" />
      ) : null}

      <div className="px-4 py-3">
        <p className="text-sm text-gray-200">{data?.description || 'Alerta da câmera'}</p>
        {data?.triggeredBy && data?.triggeredBy !== 'snapshot' ? (
          <p className="mt-1 text-xs text-gray-400">{formatTime(data.ts)} · trigger: {data.triggeredBy}</p>
        ) : null}
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => {
              window.api?.send?.('window-focus')
              data?.onClose?.()
            }}
            className="flex-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium py-2 transition-colors"
          >
            Abrir MomAI
          </button>
          {data?.monitorId ? (
            <button
              disabled={stopping}
              onClick={() => {
                setStopping(true)
                void stopMonitor(data.monitorId, data.onClose)
              }}
              className="flex-1 rounded-lg border border-white/15 hover:bg-white/10 text-xs font-medium py-2 transition-colors disabled:opacity-50"
            >
              {stopping ? 'Parando...' : 'Parar monitoramento'}
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
        <span className="text-lg">👁️</span>
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
