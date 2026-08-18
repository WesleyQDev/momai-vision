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
import { ptLabel, PT_CLASS, triggerLabel } from './vision/labels'
import { AlertCanvasOverlay } from './panel'
import { classColor } from './vision/theme-color'
import { extractJpegFrame, indexOfSeq } from './vision/mjpeg-parse'

const sdk = getSDK()
const EXT_ID = 'momai-vision'

/**
 * Reflects whether the MomAI host window is maximized. Same contract the host
 * uses for its own settings card: when the window is resized (not maximized)
 * the card overlays the whole MomAI area; when maximized it shows as a normal
 * centered card.
 */
function useWindowMaximized(): boolean {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    const api = (window as any).api
    api
      ?.isWindowMaximized?.()
      .then((maximized: boolean) => setIsMaximized(maximized))
      .catch(() => { })
    const unsubscribe = api?.onWindowStateChanged?.((state: { maximized: boolean }) => {
      setIsMaximized(state.maximized)
    })
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  return isMaximized
}

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
  triggers: MonitorTriggerInfo[]
  schedule?: { days?: number[]; start?: string; end?: string }
  cooldownSec?: number
  label?: string
  createdAt?: number
  lastAlertTs?: number
  actions?: MonitorActionUI[]
  paused?: boolean
}

// Forma permissiva dos triggers vindos da API (o runtime normaliza para os
// tipos de ./vision/triggers; aqui a página só lê campos para exibir/editar).
interface MonitorTriggerInfo {
  type: string
  className?: string
  sensitivity?: string
  present?: boolean
  event?: string
  windowSec?: number
  question?: string
  everySec?: number
}

interface MonitorActionUI {
  id?: string
  target: string
  tool: string
  args?: Record<string, unknown>
}

interface CatalogToolParam {
  type?: string
  description?: string
  default?: unknown
  enum?: string[]
}
interface CatalogTool {
  name: string
  description?: string
  parameters?: {
    properties?: Record<string, CatalogToolParam>
    required?: string[]
  } | null
}
interface CatalogExt {
  id: string
  name?: string
  installed?: boolean
  enabled?: boolean
  tools?: CatalogTool[]
  eventFields?: Record<string, Record<string, { label?: string; type?: string }>>
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
  sendActions?: MonitorActionUI[]
}

// Array vazio estável (módulo): evita criar referência nova a cada render do
// card, o que invalidaria o memo do drawBoxes sem necessidade.
const EMPTY_DETECTIONS: Detection[] = []

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

function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const dateStr = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const timeStr = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return `${dateStr} ${timeStr}`
}

// Chave estável de um alerta para deduplicação e key de renderização.
// snapshotId é único por alerta (cada alerta grava um snapshot); sem ele,
// usa a composição temporal do evento.
function alertKey(a: Alert): string {
  if (a?.snapshotId) return `snap:${a.snapshotId}`
  return `${a?.ts || 0}|${a?.cameraId || a?.cameraName || ''}|${a?.triggeredBy || ''}|${a?.className || ''}`
}

// Funde a lista atual (que pode conter alertas recém-chegados via SSE ainda
// não persistidos no backend) com a lista vinda da API, sem perder nenhum dos
// dois lados. Deduplica por chave estável e ordena do mais recente para o
// mais antigo, respeitando o limite de 100.
function mergeAlerts(existing: Alert[], fresh: Alert[]): Alert[] {
  const byKey = new Map<string, Alert>()
  for (const a of fresh) {
    if (a && typeof a === 'object') byKey.set(alertKey(a), a)
  }
  for (const a of existing) {
    if (a && typeof a === 'object' && !byKey.has(alertKey(a))) {
      byKey.set(alertKey(a), a)
    }
  }
  return [...byKey.values()]
    .sort((x, y) => (y.ts || 0) - (x.ts || 0))
    .slice(0, 100)
}

// Timeout global dos comandos para o runtime. Sem isso, um comando preso
// (ex.: list_cameras esperando o start-watch de uma webcam lenta no bridge)
// segura a Promise do onConfirm e o modal fica em "Adicionando..." sem
// nunca terminar — o fluxo precisa SEMPRE finalizar em sucesso ou erro.
//
// O valor fica ACIMA do limite de 30s do host (extension-host-manager
// `_sendRequest`): se a página abortasse antes (ex.: 15s), um comando que o
// host concluiria em 16–30s (reaquisição de uma webcam USB recém-lançada via
// getUserMedia na janela oculta) seria falsamente cancelado com "demorou
// demais". Com este alinhamento, o próprio host é quem arbitra: se ele
// responder, o comando conclui; se travar de verdade, o host rejeita em 30s
// com um erro claro e o modal finaliza de qualquer forma.
const COMMAND_TIMEOUT_MS = 35000

// Timeout curto para o frame_pump do CARD (não o do modal): o pump é um loop
// contínuo e cada ciclo deve desistir rápido se o worker estiver ocupado com o
// poll (list_cameras → startMjpeg/ffmpeg). Com o timeout global de 35s, o pump
// ficava pendurado e deixava POSTs órfãos no node-core.
const PUMP_COMMAND_TIMEOUT_MS = 4000

async function command<T = unknown>(toolName: string, args: Record<string, unknown> = {}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const res = await Promise.race([
      sdk.api.post<{ ok: boolean; error?: string } & T>(
        `/extensions/${EXT_ID}/command`,
        { toolName, args }
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`O comando "${toolName}" demorou demais e foi cancelado. Tente novamente.`)),
          COMMAND_TIMEOUT_MS
        )
        if (typeof timer.unref === 'function') timer.unref()
      })
    ])
    if (!res.ok || res.data?.ok === false) {
      throw new Error(res.error || res.data?.error || `command failed: ${toolName}`)
    }
    return res.data as T
  } finally {
    // O timer do Promise.race nunca era limpo quando o fetch vencia — o
    // setTimeout ficava vivo até disparar (35s) mantendo o processo de página
    // com timers inúteis.
    if (timer) clearTimeout(timer)
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const res = reader.result as string
      resolve(res ? res.split(',')[1] || '' : '')
    }
    reader.readAsDataURL(blob)
  })
}

// Espera LIMITADA pelo status "online" das webcams recém-adicionadas. O
// start-watch roda em background no runtime; este helper aguarda o frame
// chegar (via get_status) até um teto fixo, sem nunca travar o fluxo.
const WEBCAM_ONLINE_WAIT_MS = 12000

async function waitForWebcamOnline(
  webcamIds: string[],
  onStatus?: (cams: Record<string, { online?: boolean }>) => void
): Promise<void> {
  if (!webcamIds || webcamIds.length === 0) return
  const deadline = Date.now() + WEBCAM_ONLINE_WAIT_MS
  while (Date.now() < deadline) {
    try {
      // Cada chamada também é limitada (1.5s) — o teto total é sempre
      // respeitado mesmo se um get_status individual demorar.
      const statusRes = await Promise.race([
        command<{ cameras?: Record<string, { online?: boolean }> }>('get_status', {}),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500))
      ])
      if (!statusRes) continue
      const cams = statusRes.cameras
      // Sem dados de câmera no get_status (runtime antigo / resposta parcial):
      // não dá para saber o status — não bloqueia o fluxo de forma alguma.
      if (!cams) return
      // Atualiza o card em tempo real (quando um callback é passado): a webcam
      // recém-adicionada vira "Conectado" assim que o watch subir no host, sem
      // esperar o próximo poll de 5s (que sob carga pode demorar bastante).
      onStatus?.(cams)
      if (webcamIds.every((id) => cams[id]?.online)) return
    } catch {
      // transiente — continua tentando até o teto
    }
    await new Promise((r) => setTimeout(r, 800))
  }
}

// Busca direta do frame no node-core como Base64 (fallback para testes/compatibilidade).
async function fetchDirectFrame(cameraId: string): Promise<string | null> {
  const deviceId = cameraId.startsWith('webcam:') ? cameraId.slice('webcam:'.length) : cameraId
  try {
    const base = (window as any).api?.getApiBaseUrl?.() || 'http://127.0.0.1:8000'
    const token = (window as any).api?.getSessionToken?.() || ''
    const res = await fetch(`${base}/media/camera/frame/${encodeURIComponent(deviceId)}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-extension-id': EXT_ID
      }
    })
    if (!res.ok) return null
    const data = await res.json()
    return typeof data?.jpegBase64 === 'string' ? data.jpegBase64 : null
  } catch {
    return null
  }
}

// Taxa de detecção na página. Com o YOLO11s 640x640 a ~300-600ms por
// inferência e um mutex global (1 inferência por vez), 2 câmeras precisam
// ~600-1200ms por ciclo. fluid=500 dá ~2 detecções/s por câmera;
// balanced=1000 é um bom equilíbrio; economy=1500 poupa CPU sem perder
// carros em movimento.
const PUMP_INTERVALS: Record<string, number> = { fluid: 500, balanced: 1000, economy: 1500 }

// Leitor MJPEG em JS (via fetch + ReadableStream) — alternativa confiável ao
// <img src="multipart/x-mixed-replace">, que no Chromium congela no mesmo frame
// de forma aleatória e não permite contar FPS real. O parser desenha cada frame
// JPEG num canvas e chama onFrame(framesPorSegundo) periodicamente.
//
// O stream é "multipart/x-mixed-replace; boundary=frame": cada parte vem como
// "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n\r\n<bytes>\r\n".
function createMjpegReader(
  url: string,
  handlers: {
    // `frame` são os BYTES do JPEG (subarray view, ZERO cópia). O consumidor
    // decodifica direto com createImageBitmap(frame) — sem Blob intermediário.
    onFrame: (frame: Uint8Array) => void
    onError: (err: unknown) => void
  },
  signal: AbortSignal
): void {
  const BOUNDARY = new TextEncoder().encode('--frame\r\n')
  const HEADER_END = new TextEncoder().encode('\r\n\r\n')
  // Reutilizar o TextDecoder (criar um por frame a 24fps × N câmeras era
  // alocação desnecessária no main thread).
  const DECODER = new TextDecoder('latin1')

  const start = async () => {
    const res = await fetch(url, { signal, headers: { Accept: 'image/jpeg' } })
    if (!res.ok || !res.body) throw new Error(`Mjpeg stream HTTP ${res.status}`)
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    const flushToU8 = () => {
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
    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
    // Busca de sequência otimizada (indexOfSeq em vision/mjpeg-parse.ts): o
    // primeiro byte via `indexOf` NATIVO (memchr do V8, ~10x mais rápido que
    // scan JS puro) e validação dos bytes seguintes apenas quando ele casa.
    const parse = (buf: Uint8Array): Uint8Array => {
      let idx = indexOfSeq(buf, BOUNDARY)
      while (idx !== -1) {
        const after = idx + BOUNDARY.length
        // Sem Content-Length o frame termina no próximo boundary — antes era
        // emitido um frame de 0 bytes (length = 0) que quebrava o
        // createImageBitmap.
        const range = extractJpegFrame(buf, BOUNDARY, HEADER_END, (bytes) => DECODER.decode(bytes), after)
        if (!range) break
        // View do JPEG dentro do buffer de concat — sem cópia. O buffer não é
        // mutado depois (o parse substitui `joined` por subarrays novos), então
        // é seguro o createImageBitmap ler assíncrono dele.
        latestFrame = buf.subarray(range.start, range.end)
        if (!emitScheduled) {
          // Caso comum (frames a ~24fps, intervalo já decorrido): emite
          // SÍNCRONO, sem a latência de um setTimeout(0) extra no event loop
          // (que, com o main thread ocupado, adicionava atraso perceptível).
          // O timer só é agendado para o throttle quando os frames chegam mais
          // rápido que MAX_EMIT_INTERVAL.
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

    // Teto de ~24fps com latest-wins, emitindo BYTES (zero cópia por frame).
    // O stream MJPEG do node-core é clampado a 20-24fps. Se a fonte entregar
    // acima disso, só o frame mais recente é emitido a cada 42ms — preview
    // sempre no frame mais novo, sem backlog nem fila de decodes.
    const MAX_EMIT_INTERVAL = 42 // ~24fps (teto, não piso)
    let latestFrame: Uint8Array | null = null
    let emitScheduled = false
    let lastEmit = 0

    const emitLatest = () => {
      emitScheduled = false
      if (!latestFrame) return
      const now = Date.now()
      const wait = lastEmit + MAX_EMIT_INTERVAL - now
      if (wait > 0) {
        emitScheduled = true
        setTimeout(emitLatest, wait)
        return
      }
      lastEmit = now
      const frame = latestFrame
      latestFrame = null
      handlers.onFrame(frame)
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
      // Caso comum em LAN: cada frame chega num ÚNICO chunk (o node-core
      // escreve o multipart por frame). Nesse caso `joined` é a view do próprio
      // chunk — evita a cópia de ~100KB por frame (a maior fonte de alocação
      // do main thread com 3 câmeras → GC → jank).
      let joined: Uint8Array
      if (chunks.length === 1 && pending.length === 0) {
        joined = chunks[0]
        chunks.length = 0
      } else {
        joined = pending.length ? concatBytes(pending, flushToU8()) : flushToU8()
      }
      pending = parse(joined)
      // Guarda anti-vazamento: stream malformado (sem boundary/frame completo)
      // não pode acumular memória sem limite no main thread.
      if (pending.length > 5 * 1024 * 1024) {
        pending = new Uint8Array(0)
      }
    }
  }

  start().catch((err) => {
    if (signal.aborted) return
    handlers.onError(err)
  })
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

// Hash simples de string → usado para dessincronizar os pumps de detecção
// entre câmeras (ver pump do card). Os pumps começam juntos no mount e, sem
// stagger, ficam SINCRONIZADOS: o YOLO (mutex global, 1 inferência por vez)
// processa rajadas de N inferências a cada intervalo → picos de CPU que fazem
// os 3 vídeos travarem juntos. Espalhar por câmera suaviza a carga.
function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

// Extrai as dimensões de um JPEG lendo o SOF0/SOF2 marker (sem decodificar).
// Usado para o scaled decode (resizeWidth do createImageBitmap) e para manter
// as dims ORIGINAIS do frame nos boxes (que são normalizados 0-1 ao frame).
function jpegDims(buf: Uint8Array): { w: number; h: number } | null {
  let i = 2 // skip SOI
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isSof) {
      const h = (buf[i + 5] << 8) | buf[i + 6]
      const w = (buf[i + 7] << 8) | buf[i + 8]
      return { w, h }
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    const len = (buf[i + 2] << 8) | buf[i + 3]
    if (len < 2) break
    i += 2 + len
  }
  return null
}

/**
 * Parser MJPEG em Web Worker: o fetch + parse + throttle acontecem numa THREAD
 * SEPARADA, fora do main thread do renderer principal (que também roda a UI do
 * MomAI). Os frames chegam via postMessage transferable (zero cópia no main);
 * o decode (createImageBitmap) e o draw ficam no main, como no caminho inline.
 *
 * O canvas NUNCA é transferido: se o worker não carregar (URL não resolvida
 * em dev, etc.), o caller cai no createMjpegReader inline e o preview continua
 * funcionando — sem canvas "queimado", sem "iniciando câmera" eterno.
 */
interface ParserWorker {
  start(url: string): void
  getFrame(): Promise<Uint8Array | null>
  dispose(): void
  /** true quando o script do worker carregou (ack 'ready' recebido). */
  isReady(): boolean
}

function createParserWorker(opts: {
  onFrame: (frame: Uint8Array) => void
  onError?: () => void
  onFps?: (fps: number) => void
}): ParserWorker | null {
  if (typeof Worker === 'undefined') return null
  let worker: Worker
  try {
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
      case 'frame':
        if (msg.buffer) opts.onFrame(new Uint8Array(msg.buffer))
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
        className={`w-full flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-zinc-900/90 text-gray-200 hover:bg-white/10 hover:border-white/20 transition-all font-medium select-none shadow-md backdrop-blur-md active:scale-[0.99] ${size === 'sm' ? 'px-2.5 py-1.5 text-[11px]' : 'px-3.5 py-2.5 text-xs'
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
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors ${isDisabled
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
// SVG Bounding Box Overlay — renders detection boxes as SVG elements.
// React manages the redraw: when `boxes` changes, the SVG re-renders
// automatically. No manual canvas drawing, no refs, no ResizeObserver.
// ---------------------------------------------------------------------------

function SvgBoxOverlay({
  boxes,
  frameDims,
  fit = 'cover'
}: {
  boxes: Detection[]
  frameDims?: { w: number; h: number }
  fit?: 'cover' | 'contain'
}): JSX.Element | null {
  if (boxes.length === 0) return null

  // With object-contain, the image is centered inside the container with
  // letterbox bars. The SVG must be offset to align with the image.
  // With object-cover, the image fills the container (crops overflow),
  // so normalized 0-1 coordinates map directly to the full container.
  const style: React.CSSProperties = fit === 'contain' && frameDims?.w && frameDims?.h
    ? { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }
    : {}

  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none z-10"
      style={style}
      viewBox={fit === 'contain' && frameDims?.w && frameDims?.h
        ? `0 0 ${frameDims.w} ${frameDims.h}`
        : undefined
      }
      preserveAspectRatio={fit === 'contain' ? 'xMidYMid meet' : undefined}
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
              fill="#0a0a0a" fontSize="11" fontFamily="sans-serif"
            >
              {ptLabel(box.className)} {Math.round(box.confidence * 100)}%
            </text>
          </g>
        )
      })}
    </svg>
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
  onDragEnd,
  onDetections,
  mode = 'balanced',
  hasMonitor = false,
  suppressPump = false
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
  onDetections?: (cameraId: string, boxes: Detection[]) => void
  mode?: 'fluid' | 'balanced' | 'economy'
  hasMonitor?: boolean
  // Quando o ExpandedCameraModal está aberto para esta câmera, o modal já
  // bombeia frames de detecção para ela — o card por trás não precisa
  // duplicar a carga (2 fetchDirectFrame + 2 frame_pump por ciclo).
  suppressPump?: boolean
}): JSX.Element {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [ready, setReady] = useState(false)
  // True apenas quando um frame REAL foi exibido no preview. Antes disso, o
  // card mostra o placeholder de status ("Conectando.../Iniciando câmera..."),
  // nunca uma moldura preta vazia.
  const [hasFrame, setHasFrame] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flashing, setFlashing] = useState(false)
  const [printStatus, setPrintStatus] = useState<'idle' | 'capturing' | 'success'>('idle')
  const [reloading, setReloading] = useState(false)
  const [fps, setFps] = useState(0)
  const framesRef = useRef(0)
  const fpsTsRef = useRef(0)
  const frameDimsRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 })

  // Rastreadores de estado "commitado": evita chamar setHasFrame/setReady/
  // setError a CADA frame. Mesmo com bail-out do React, cada setState agenda
  // uma render pass do card — com 3 câmeras a 24fps isso eram ~216 renders/s
  // de vdom no main thread, competindo com o parse/draw (causa real da
  // oscilação de FPS 13-24). Com os refs, o card NÃO re-renderiza enquanto o
  // estado não muda de verdade.
  const hasFrameRef = useRef(false)
  const readyRef = useRef(false)
  const errorRef = useRef<string | null>(null)

  // Último frame (bytes JPEG) do preview MJPEG — o pump de detecção reusa
  // este frame local em vez de baixar outro do node-core (ver pump abaixo).
  const lastFrameRef = useRef<Uint8Array | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const isWebcam = camera.source === 'webcam' || camera.id.startsWith('webcam:')

  // Parser de preview em Web Worker (thread separada) — parse fora do main
  // thread; null = fallback inline (jsdom / worker indisponível).
  const parserWorkerRef = useRef<ParserWorker | null>(null)

  // Redraw de boxes apenas quando as detecções DESTA câmera mudam. Usar o
  // objeto `detections` inteiro nas deps fazia TODOS os cards redesenharem o
  // canvas quando QUALQUER câmera recebia detecções novas (o state é um novo
  // Record a cada applyDetections).
  const myDetections = detections[camera.id] || EMPTY_DETECTIONS

  const fetchingRef = useRef(false)
  // A corrida visual de 8 s abaixo não cancela o POST do SDK. Sem este ref, o
  // próximo ciclo criava outro POST enquanto o anterior ainda estava no
  // node-core, acumulando comandos de frame_pump quando uma câmera RTSP estava
  // lenta. O worker já mantém a inferência em background; basta um request do
  // card por vez para receber os SSEs normalmente.
  const pumpingRef = useRef(false)

  // Refs para condições voláteis do pump (hasMonitor/suppressPump) que o poll
  // atualiza a cada 5s. Se elas estivessem nas deps do pump effect, QUALQUER
  // mudança re-executava o effect → `cancelled=true` do run antigo → o
  // frame_pump em andamento acordava com cancelled e descartava detections
  // válidas (e o POST órfão seguia no node-core). Com refs, o loop do pump
  // NUNCA reinicia por mudança de monitor — só lê o valor atual a cada ciclo.
  const hasMonitorRef = useRef(hasMonitor)
  hasMonitorRef.current = hasMonitor
  const suppressPumpRef = useRef(suppressPump)
  suppressPumpRef.current = suppressPump

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

  // Warmup: dispara um get_frame único na montagem do card (mesmo com a view
  // oculta na pré-montagem em background). Isso inicia o stream da câmera
  // (startMjpeg/start-watch) cedo, então quando o usuário abre o page o
  // primeiro frame já está pronto — sem a demora de "iniciando" e sem todas
  // as câmeras aparecerem juntas no mesmo instante.
  //
  // IMPORTANTE: NUNCA sobrescrever o src do <img> com um data URI aqui. O
  // preview é o stream MJPEG (src={streamUrl}); mutar imgRef.current.src
  // imperativamente ABORTA o carregamento do stream e, como o src do React
  // (memo) não muda, o <img> nunca volta ao MJPEG — o preview congela e o
  // contador de FPS (que conta os onLoad do stream) fica preso em 1. Este
  // efeito apenas dispara get_frame para iniciar o stream no backend e guarda
  // o frame para o pump de detecção.
  useEffect(() => {
    let cancelled = false
    const warm = async () => {
      try {
        // Dispara get_frame único para INICIAR o stream no backend (startMjpeg
        // / start-watch) cedo. O frame em si é descartado — o preview usa o
        // stream MJPEG e o pump usa o último blob que o leitor recebeu.
        await command('get_frame', { cameraId: camera.id })
      } catch {
        // O loop visível cuida do retry.
      }
    }
    void warm()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.id])

  const streamUrl = useMemo(() => {
    const deviceId = camera.id.startsWith('webcam:') ? camera.id.slice('webcam:'.length) : camera.id
    const base = (window as any).api?.getApiBaseUrl?.() || 'http://127.0.0.1:8000'
    const token = (window as any).api?.getSessionToken?.() || ''
    return `${base}/media/camera/stream/${encodeURIComponent(deviceId)}?ext=${EXT_ID}&token=${encodeURIComponent(token)}&r=${refreshKey}`
  }, [camera.id, refreshKey])

  const handleFrameLoad = () => {
    setReady(true)
    setHasFrame(true)
    setError(null)
  }

  // Preview ao vivo + FPS real. Usa o leitor MJPEG em JS (fetch + ReadableStream)
  // em vez do <img multipart/x-mixed-replace>, que no Chromium congela no mesmo
  // frame de forma aleatória e não deixa contar FPS.
  //
  // PERFORMANCE: o parse roda num Web Worker (thread separada) quando
  // disponível; o draw é direto com "latest-wins": se um decode ainda está em
  // andamento, só o último frame é guardado — nunca acumula fila de
  // createImageBitmap/drawImage no main thread. O canvas NUNCA é transferido:
  // se o worker falhar, o createMjpegReader inline assume na hora.
  useEffect(() => {
    if (!isActive) return

    if (isWebcam) {
      let activeStream: MediaStream | null = null
      let cancelled = false
      // CameraInfo não expõe deviceId (list_cameras não o devolve); o card
      // resolve o id bruto a partir do id `webcam:<deviceId>`.
      const rawId = (camera as { deviceId?: string }).deviceId || (camera.id.startsWith('webcam:') ? camera.id.slice('webcam:'.length) : camera.id)

      const startWebcamStream = async () => {
        try {
          let stream: MediaStream
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              video: rawId ? { deviceId: { exact: rawId } } : true
            })
          } catch {
            stream = await navigator.mediaDevices.getUserMedia({ video: true })
          }
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop())
            return
          }
          activeStream = stream
          if (videoRef.current) {
            videoRef.current.srcObject = stream
            videoRef.current.play().catch(() => {})
          }
          hasFrameRef.current = true
          readyRef.current = true
          setHasFrame(true)
          setReady(true)
          setError(null)
          setFps(30)
          // Atualiza frameDimsRef com as dimensões reais da webcam para o
          // letterbox mapping dos boxes. Sem isso, iw/ih = 0 e os boxes
          // desenhariam com proporção errada.
          const updateDims = () => {
            if (cancelled) return
            const v = videoRef.current
            if (v && v.videoWidth && v.videoHeight) {
              frameDimsRef.current = { w: v.videoWidth, h: v.videoHeight }
            }
            if (!cancelled) requestAnimationFrame(updateDims)
          }
          requestAnimationFrame(updateDims)
        } catch (err: any) {
          if (!cancelled) {
            setError('Sem acesso à webcam local: ' + (err?.message || 'Desconectada'))
          }
        }
      }

      void startWebcamStream()

      return () => {
        cancelled = true
        if (activeStream) {
          activeStream.getTracks().forEach((t) => t.stop())
        }
      }
    }

    let cancelled = false
    const ac = new AbortController()
    const frameCanvas = frameCanvasRef.current
    const ctx = frameCanvas?.getContext('2d')
    if (!frameCanvas || !ctx) return

    let drawing = false
    let queued: Uint8Array | null = null

    // Tamanho do canvas CACHEADO: ler clientWidth/Height a cada frame (72/s
    // com 3 câmeras) é layout read no main thread. O ResizeObserver atualiza
    // o ref apenas quando o card realmente muda de tamanho (raro).
    let canvasW = frameCanvas.clientWidth || frameCanvas.width
    let canvasH = frameCanvas.clientHeight || frameCanvas.height
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            canvasW = frameCanvas.clientWidth || frameCanvas.width
            canvasH = frameCanvas.clientHeight || frameCanvas.height
          })
        : null
    ro?.observe(frameCanvas)

    const drawToCanvas = (
      bitmap: ImageBitmap | HTMLImageElement,
      origW = 0,
      origH = 0
    ): void => {
      const cw = canvasW
      const ch = canvasH
      if (frameCanvas.width !== cw) frameCanvas.width = cw
      if (frameCanvas.height !== ch) frameCanvas.height = ch
      // object-cover SEM clearRect: com scale = max(...) o drawImage cobre
      // 100% do canvas (corta o excesso), então limpar antes era redundante —
      // e o clearRect por frame (72/s com 3 câmeras) é trabalho no main thread
      // à toa.
      const scale = Math.max(cw / bitmap.width, ch / bitmap.height)
      const dw = bitmap.width * scale
      const dh = bitmap.height * scale
      ctx.drawImage(bitmap, (cw - dw) / 2, (ch - dh) / 2, dw, dh)
      // frameDimsRef usa as dims ORIGINAIS do frame (não as do bitmap se foi
      // decodificado em escala reduzida) — os boxes são normalizados 0-1 ao
      // frame original.
      frameDimsRef.current = {
        w: origW || bitmap.width,
        h: origH || bitmap.height
      }
      framesRef.current++
      const now = Date.now()
      if (now - fpsTsRef.current >= 1000) {
        setFps(framesRef.current)
        framesRef.current = 0
        fpsTsRef.current = now
      }
      // setState apenas na transição (primeiro frame / erro → ok), nunca por
      // frame — senão o React agenda render do card a 24fps × N câmeras.
      if (!hasFrameRef.current) {
        hasFrameRef.current = true
        setHasFrame(true)
      }
      if (!readyRef.current) {
        readyRef.current = true
        setReady(true)
      }
      if (errorRef.current !== null) {
        errorRef.current = null
        setError(null)
      }
    }

    const drawFallback = (frame: Uint8Array): Promise<void> =>
      new Promise((resolve) => {
        const img = new Image()
        const url = URL.createObjectURL(new Blob([frame as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }))
        img.onload = () => {
          try {
            if (!cancelled) drawToCanvas(img, img.naturalWidth, img.naturalHeight)
          } catch {
            // ignora frame inválido
          } finally {
            URL.revokeObjectURL(url)
            resolve()
          }
        }
        img.onerror = () => {
          URL.revokeObjectURL(url)
          resolve()
        }
        img.src = url
      })

    const drawFrame = async (frame: Uint8Array): Promise<void> => {
      if (cancelled) return
      try {
        if (typeof createImageBitmap === 'function') {
          // Decodifica direto dos BYTES do frame (BufferSource) — sem Blob,
          // sem cópia intermediária; o decode roda em thread de background.
          //
          // SCALED DECODE: para câmeras de alta resolução (>640px), o
          // createImageBitmap com resizeWidth/Height usa o decode em escala
          // reduzida do libjpeg-turbo (frações 1/2, 1/4...), que é ~3x mais
          // rápido que decodificar cheio. O card exibe ~400-500px — decodificar
          // acima de 640 é desperdício. Os boxes continuam certos (frameDimsRef
          // usa as dims originais).
          const dims = jpegDims(frame)
          if (dims && dims.w > 640) {
            let scale = 0.5
            while (dims.w * scale > 640) scale *= 0.5
            const rw = Math.max(1, Math.round(dims.w * scale))
            const rh = Math.max(1, Math.round(dims.h * scale))
            const bitmap = await createImageBitmap(frame as unknown as ImageBitmapSource, {
              resizeWidth: rw,
              resizeHeight: rh
            })
            if (cancelled) {
              bitmap.close()
              return
            }
            drawToCanvas(bitmap, dims.w, dims.h)
            bitmap.close()
            return
          }
          const bitmap = await createImageBitmap(frame as unknown as ImageBitmapSource)
          if (cancelled) {
            bitmap.close()
            return
          }
          drawToCanvas(bitmap, dims?.w || 0, dims?.h || 0)
          bitmap.close()
          return
        }
      } catch {
        // fallback para Image se createImageBitmap falhar
      }
      await drawFallback(frame)
    }

    const drawNext = (frame: Uint8Array): void => {
      if (cancelled) return
      if (drawing) {
        queued = frame
        return
      }
      drawing = true
      void drawFrame(frame).finally(() => {
        drawing = false
        if (queued && !cancelled) {
          const q = queued
          queued = null
          drawNext(q)
        }
      })
    }

    // Fonte dos frames: parser em Web Worker (thread separada) quando
    // disponível; senão o parser inline. O canvas NUNCA é transferido — se o
    // worker falhar ao carregar (URL não resolvida em dev), o inline assume na
    // hora e o preview continua.
    const parser = createParserWorker({
      onFrame: (frame) => {
        if (cancelled) return
        // Guarda os bytes do frame mais recente: o pump de detecção reusa este
        // frame local (zero round-trip ao node-core).
        lastFrameRef.current = frame
        drawNext(frame)
      },
      onError: () => {
        if (cancelled) return
        if (errorRef.current === null) {
          errorRef.current = 'Perda de conexão com a câmera. Tente recarregar.'
          setError(errorRef.current)
        }
      },
      onFps: (fps) => setFps(fps)
    })
    if (parser) {
      parserWorkerRef.current = parser
      parser.start(streamUrl)
      // Fallback automático: o `new Worker` não lança quando a URL não resolve
      // (erro assíncrono). Se o ack 'ready' não chegar, descarta o worker e
      // inicia o parser inline — o preview NUNCA fica em "iniciando câmera"
      // por causa de um worker mudo.
      let inlineStarted = false
      const startInline = () => {
        if (cancelled || inlineStarted) return
        inlineStarted = true
        createMjpegReader(
          streamUrl,
          {
            onFrame: (frame) => {
              if (cancelled) return
              lastFrameRef.current = frame
              drawNext(frame)
            },
            onError: () => {
              if (cancelled) return
              if (errorRef.current === null) {
                errorRef.current = 'Perda de conexão com a câmera. Tente recarregar.'
                setError(errorRef.current)
              }
            }
          },
          ac.signal
        )
      }
      const fallbackTimer = setTimeout(() => {
        if (parser.isReady()) return
        parser.dispose()
        parserWorkerRef.current = null
        startInline()
      }, 500)
      return () => {
        clearTimeout(fallbackTimer)
        cancelled = true
        ac.abort()
        ro?.disconnect()
        parser.dispose()
        parserWorkerRef.current = null
      }
    }

    // Fallback direto (jsdom / Worker indisponível).
    createMjpegReader(
      streamUrl,
      {
        onFrame: (frame) => {
          if (cancelled) return
          lastFrameRef.current = frame
          drawNext(frame)
        },
        onError: () => {
          if (cancelled) return
          if (errorRef.current === null) {
            errorRef.current = 'Perda de conexão com a câmera. Tente recarregar.'
            setError(errorRef.current)
          }
        }
      },
      ac.signal
    )

    return () => {
      cancelled = true
      ac.abort()
      ro?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl, isActive])

  // YOLO detection frame pump.
  // PERFORMANCE: o frame enviado é o ÚLTIMO frame (bytes) que o leitor MJPEG
  // do preview já recebeu (lastFrameRef) — convertido para base64 via Blob +
  // FileReader (encode em background), muito mais barato que o caminho antigo
  // que baixava o frame de novo do node-core (GET /frame re-encoda o JPEG em
  // base64 no thread único do host e devolve JSON gigante, disputando o push
  // do MJPEG). fetchDirectFrame vira fallback apenas para cold start.
  //
  // Quando a câmera tem MONITOR ATIVO, o monitor já roda YOLO ~1/s e envia os
  // boxes via vision_detections (SSE) — o pump do card seria redundante e só
  // somaria POSTs JSON no node-core + inferências no mutex global. Nesse caso
  // o pump é suprimido (os boxes chegam pelo SSE).
  useEffect(() => {
    if (!isActive) return
    let cancelled = false
    const interval = PUMP_INTERVALS[mode] || 1000
    // Último resultado de detecção recebido por esta câmera (persiste entre os
    // ciclos do pump dentro deste effect). Quando um frame_pump não responde a
    // tempo (timeout de PUMP_COMMAND_TIMEOUT_MS — engine ocupado / fila do
    // worker) ou falha, o ciclo redesenha ESTE último estado em vez de deixar o
    // canvas sem boxes: a detecção "congela" no último resultado conhecido e
    // volta a atualizar assim que o engine responder. Antes, o timeout não
    // redesenhava nada e o hold de 1.5s do applyDetections limpava os boxes —
    // por isso os quadrados só apareciam após trocar de aba (remount que
    // re-iniciava o pump e achava o engine livre).
    let lastBoxes: Detection[] = []
    let lastWarnTime = 0
    const WARN_MIN_INTERVAL_MS = 30_000 // no máximo 1 warn por 30s por câmera

    const run = async () => {
      if (cancelled || suppressPumpRef.current || hasMonitorRef.current || document.hidden) {
        if (!cancelled) timerRef = setTimeout(run, interval)
        return
      }
      if (pumpingRef.current) {
        // A resposta do POST anterior ainda não chegou. Não criar uma segunda
        // chamada: o resultado pendente será entregue por SSE e o próximo
        // intervalo retoma o pump quando o transporte liberar.
        timerRef = setTimeout(run, interval)
        return
      }
      try {
        let jpegBase64: string | null = null
        if (isWebcam && videoRef.current && (videoRef.current.readyState >= 2 || videoRef.current.videoWidth > 0)) {
          const v = videoRef.current
          const vw = v.videoWidth || 640
          const vh = v.videoHeight || 360
          frameDimsRef.current = { w: vw, h: vh }
          const tempCanvas = document.createElement('canvas')
          const scale = Math.min(640 / vw, 360 / vh, 1)
          tempCanvas.width = Math.max(1, Math.round(vw * scale))
          tempCanvas.height = Math.max(1, Math.round(vh * scale))
          const ctx = tempCanvas.getContext('2d')
          if (ctx) {
            ctx.drawImage(v, 0, 0, tempCanvas.width, tempCanvas.height)
            jpegBase64 = tempCanvas.toDataURL('image/jpeg', 0.8)
          }
        } else {
          const parser = parserWorkerRef.current
          if (parser) {
            // O parse está no Web Worker: pede o frame mais recente (transferable
            // — zero cópia no main) e converte via Blob+FileReader (background).
            const buf = await parser.getFrame()
            if (buf && buf.length > 0) {
              jpegBase64 = await blobToBase64(
                new Blob([buf as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
              )
            }
          } else {
            const localFrame = lastFrameRef.current
            if (localFrame && localFrame.length > 0) {
              // Cria o Blob SOB DEMANDA (1 cópia por pump, ~1x/0.9-2.5s por
              // câmera) — nunca por frame do stream.
              jpegBase64 = await blobToBase64(
                new Blob([localFrame as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
              )
            }
          }
        }
        if (!jpegBase64) {
          jpegBase64 = await fetchDirectFrame(camera.id)
        }
        if (!jpegBase64) {
          const res = await command<{ jpegBase64?: string }>('get_frame', { cameraId: camera.id })
          jpegBase64 = res?.jpegBase64 || null
        }
        if (jpegBase64 && !cancelled) {
          // Timeout curto específico do pump: o frame_pump pode ficar na fila
          // do worker quando o poll (list_cameras a cada 5s) está processando
          // startMjpeg/ffmpeg. Com o timeout global de 35s, o pump ficava 35s
          // pendurado (POST órfão no node-core + "demorou demais"). Aqui ele
          // desiste em PUMP_COMMAND_TIMEOUT_MS e tenta no próximo ciclo.
          const request = command<{ detections?: Detection[]; engineBusy?: boolean; stale?: boolean }>('frame_pump', { cameraId: camera.id, jpegBase64 })
          pumpingRef.current = true
          void request.then(
            () => { pumpingRef.current = false },
            () => { pumpingRef.current = false }
          )
          const res = await Promise.race([
            request,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), PUMP_COMMAND_TIMEOUT_MS))
          ])
          if (res?.engineBusy) {
            console.log(`[vision-diag][${camera.id}] frame_pump engine busy, using cached boxes`)
          }
          if (res?.detections && Array.isArray(res.detections) && !cancelled) {
            lastBoxes = res.detections
            // Atualiza o state via onDetections (React redesenha o SVG).
            // Funciona para dados frescos E stale — o hold temporal no
            // applyDetections suaviza a instabilidade do YOLO.
            onDetections?.(camera.id, res.detections)
          } else if (!cancelled) {
            // Sem resposta a tempo (timeout — engine ocupado / frame_pump na
            // fila do worker) ou resposta sem detections: mantém o último
            // estado conhecido via onDetections para não limpar os boxes.
            if (lastBoxes.length > 0) {
              onDetections?.(camera.id, lastBoxes)
            }
            // DIAG: frame_pump respondeu mas sem detections (vazio/erro silencioso)
            try {
              const now = Date.now()
              if (now - lastWarnTime >= WARN_MIN_INTERVAL_MS) {
                lastWarnTime = now
                console.warn(
                  `[vision-diag][${camera.id}] frame_pump sem detections: ${res === null ? 'timeout-pump' : JSON.stringify(res)}`
                )
              }
            } catch {
              const now = Date.now()
              if (now - lastWarnTime >= WARN_MIN_INTERVAL_MS) {
                lastWarnTime = now
                console.warn(`[vision-diag][${camera.id}] frame_pump sem detections (unserializable)`)
              }
            }
          }
        } else if (!jpegBase64) {
          // DIAG: nenhum frame disponível — preview morto, fetchDirectFrame 404 ou get_frame falhou
          if (Date.now() - lastWarnTime >= WARN_MIN_INTERVAL_MS) {
            lastWarnTime = Date.now()
            console.warn(
              `[vision-diag][${camera.id}] pump sem frame (lastFrame=${lastFrameRef.current?.length ?? 'null'}, parser=${parserWorkerRef.current ? 'sim' : 'não'}, webcam=${isWebcam ? (videoRef.current ? `ready=${videoRef.current.readyState}` : 'sem-video') : 'não'})`
            )
          }
        }
      } catch (err) {
        // DIAG: erros silenciosos que mantinham os boxes congelados
        // Rate-limit do warn: no máximo 1 a cada 30s por câmera para não encher o log
        const now = Date.now()
        if (now - lastWarnTime >= WARN_MIN_INTERVAL_MS) {
          lastWarnTime = now
          console.warn(`[vision-diag][${camera.id}] pump erro:`, err instanceof Error ? err.message : String(err))
        }
        // Falha do frame_pump: mantém o último estado conhecido via onDetections.
        if (!cancelled && lastBoxes.length > 0) {
          onDetections?.(camera.id, lastBoxes)
        }
      } finally {
        if (!cancelled) {
          timerRef = setTimeout(run, interval)
        }
      }
    }

    const stagger = (hashCode(camera.id) % 3) * (interval / 3)
    let timerRef = setTimeout(run, stagger)

    // Retoma o pump imediatamente quando a página voltar a ficar visível
    // (janela restaurada/aba do app re-focada): sem o listener, o próximo
    // ciclo só rodaria no próximo intervalo (até 2.5s em economy). O pump em si
    // nunca morre no hidden (só pausa e re-agenda), mas este listener torna o
    // resume instantâneo — mesmo comportamento de um remount por troca de aba.
    const onVisibility = () => {
      if (!cancelled && !document.hidden) {
        clearTimeout(timerRef)
        timerRef = setTimeout(run, 0)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      clearTimeout(timerRef)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // hasMonitor/suppressPump NÃO estão nas deps: mudanças no monitor (poll 5s)
    // NÃO devem reiniciar o loop do pump (causava descarte de detections + POSTs
    // órfãos). A condição é lida via ref a cada ciclo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera.id, mode, isActive])

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
        // O preview é o stream MJPEG; o reload apenas marca pronto. O pump
        // reusa o próximo frame do stream, então nada a guardar aqui.
        setReady(true)
        setHasFrame(true)
      }
      setError(null)
      // A replug can change the deviceId while keeping the same name — sync the
      // card with the resolved id so polling stops hitting the stale one.
      if (res.cameraId && res.cameraId !== camera.id) {
        onReload?.(res.cameraId)
      } else {
        onReload?.(camera.id)
      }
    } catch {
      // Clear error overlay on reload attempt so live frames aren't obscured;
      // live polling retries automatically and poll() updates card state.
      setError(null)
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
      className={`flex flex-col h-full rounded-2xl bg-zinc-900/80 border overflow-hidden shadow-xl transition-all ${isDragging
        ? 'opacity-40 scale-95 border-emerald-500/50'
        : isDragOver
          ? 'border-2 border-emerald-400 bg-emerald-500/10 shadow-emerald-500/20 scale-[1.02]'
          : 'border-white/10 hover:border-white/20'
        }`}
    >
      <div className="relative w-full aspect-video bg-black rounded-t-2xl overflow-hidden shrink-0" style={{ aspectRatio: '16 / 9' }}>
        {isWebcam ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`absolute inset-0 w-full h-full object-cover ${hasFrame ? 'block' : 'opacity-0'}`}
          />
        ) : (
          <canvas
            ref={frameCanvasRef}
            className={`absolute inset-0 w-full h-full ${hasFrame ? 'block' : 'opacity-0'}`}
          />
        )}
        {!hasFrame && (
          <div className="absolute inset-0 w-full h-full flex flex-col items-center justify-center text-xs text-gray-400 bg-black p-4 text-center">
            <VisionIcon className="w-6 h-6 text-gray-400 mb-2 animate-pulse" />
            <span>{reloading ? 'Conectando à sua câmera...' : camera.online ? 'Iniciando câmera...' : 'Sem sinal'}</span>
          </div>
        )}
        {/* Bounding boxes — SVG overlay (React gerencia o redesenho) */}
        <SvgBoxOverlay boxes={myDetections} />

        {/* FPS real do preview (diagnóstico de desempenho) */}
        {hasFrame && fps > 0 ? (
          <div className="absolute bottom-2 right-2 z-20 text-[10px] font-mono bg-black/60 text-emerald-300 px-1.5 py-0.5 rounded">
            {fps} fps
          </div>
        ) : null}

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
            <span className="text-xs font-semibold text-white drop-shadow truncate" title={camera.name}>
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
                title={
                  camera.source === 'ip'
                    ? 'Remover câmera IP (cadastro e exibição)'
                    : 'Fechar / Remover câmera da exibição'
                }
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
            className={`text-[11px] font-medium rounded-lg px-3 py-1.5 transition-all flex items-center gap-1.5 shadow-md active:scale-95 ${printStatus === 'success'
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
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                  <circle cx="12" cy="13" r="4" />
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
      className="relative group rounded-2xl border-2 border-dashed border-white/10 hover:border-emerald-500/40 bg-white/[0.02] hover:bg-white/[0.05] transition-all duration-200 flex flex-col items-center justify-center p-4 text-center overflow-hidden focus:outline-none focus:ring-1 focus:ring-white/20 h-full min-h-[160px] cursor-pointer min-w-0"
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
    // Pré-aquece a câmera (getUserMedia no host) JÁ NA SELEÇÃO, em background:
    // assim, ao confirmar, o watch já está subindo e o card conecta mais rápido
    // (menos tempo "sem sinal"), parecido com o navegador inicializando a webcam.
    void command('warm_webcam', { cameraId: val }).catch(() => {})
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
      // Rede de segurança absoluta: o modal NUNCA pode ficar preso em
      // "Adicionando..." para sempre. Cada comando já tem timeout (COMMAND_TIMEOUT_MS)
      // e o onConfirm já fecha o modal logo após a persistência; este race garante
      // que, mesmo que algo pendure por um motivo não coberto (ex.: resposta que
      // nunca chega sem rejeitar), o fluxo finaliza com erro claro e permite tentar
      // de novo — em vez de congelar a UI.
      await Promise.race([
        onConfirm(pendingWebcamIds, pendingIpDrafts),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new Error('Tempo esgotado ao adicionar. Verifique a conexão e tente novamente.')
              ),
            COMMAND_TIMEOUT_MS
          )
          if (typeof timer.unref === 'function') timer.unref()
        })
      ])
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
              className={`py-2.5 px-3 rounded-md flex items-center justify-center gap-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${activeTab === 'webcam'
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
              className={`py-2.5 px-3 rounded-md flex items-center justify-center gap-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 ${activeTab === 'ip'
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
                  className={`w-full sm:w-auto rounded-xl text-white px-5 py-2 text-xs font-semibold transition-colors shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 ${pendingCount === 0
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
  onSnapshot,
  onDetections,
  mode = 'balanced'
}: {
  camera: CameraInfo | null
  detections: Record<string, Detection[]>
  onClose: () => void
  onSnapshot: (cameraId: string) => Promise<void> | void
  onDetections?: (cameraId: string, boxes: Detection[]) => void
  mode?: 'fluid' | 'balanced' | 'economy'
}): JSX.Element | null {
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameBoxRef = useRef<HTMLDivElement | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flashing, setFlashing] = useState(false)
  const [printStatus, setPrintStatus] = useState<'idle' | 'capturing' | 'success'>('idle')
  const pumpingRef = useRef(false)
  const frameDimsRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 })

  // Rastreadores de estado "commitado" (mesma otimização do card): setReady/
  // setError só nas transições, nunca por frame.
  const readyRef = useRef(false)
  const errorRef = useRef<string | null>(null)

  // Último frame (bytes JPEG) do preview MJPEG — o pump de detecção reusa
  // este frame local.
  const lastFrameRef = useRef<Uint8Array | null>(null)

  // Parser de preview em Web Worker (thread separada); null = fallback inline.
  const parserWorkerRef = useRef<ParserWorker | null>(null)

  // Redraw de boxes apenas quando as detecções DESTA câmera mudam.
  const myDetections = camera ? detections[camera.id] || EMPTY_DETECTIONS : EMPTY_DETECTIONS

  const streamUrl = useMemo(() => {
    if (!camera) return ''
    const deviceId = camera.id.startsWith('webcam:') ? camera.id.slice('webcam:'.length) : camera.id
    const base = (window as any).api?.getApiBaseUrl?.() || 'http://127.0.0.1:8000'
    const token = (window as any).api?.getSessionToken?.() || ''
    return `${base}/media/camera/stream/${encodeURIComponent(deviceId)}?ext=${EXT_ID}&token=${encodeURIComponent(token)}`
  }, [camera])

  // Pump detection frames for expanded camera. PERFORMANCE: reusa o último
  // frame (bytes) do preview (lastFrameRef) em vez de baixar outro do
  // node-core (fetchDirectFrame re-encoda o JPEG em base64 no thread único do
  // host); fetchDirectFrame é só o fallback de cold start.
  useEffect(() => {
    if (!camera) return
    // Último estado de detecção desenhado (persiste entre ciclos do pump): se o
    // frame_pump falhar/timeout, redesenha este estado em vez de limpar o canvas.
    let lastBoxes: Detection[] = []
    const run = async () => {
      if (document.hidden || pumpingRef.current) return
      pumpingRef.current = true
      try {
        let jpegBase64: string | null = null
        const parser = parserWorkerRef.current
        if (parser) {
          const buf = await parser.getFrame()
          if (buf && buf.length > 0) {
            jpegBase64 = await blobToBase64(
              new Blob([buf as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
            )
          }
        } else {
          const localFrame = lastFrameRef.current
          if (localFrame && localFrame.length > 0) {
            // Blob sob demanda (1 cópia por pump), encode via FileReader
            // (background) — nunca por frame do stream.
            jpegBase64 = await blobToBase64(
              new Blob([localFrame as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
            )
          }
        }
        if (!jpegBase64) {
          jpegBase64 = await fetchDirectFrame(camera.id)
        }
        if (!jpegBase64) {
          const res = await command<{ jpegBase64?: string }>('get_frame', { cameraId: camera.id })
          jpegBase64 = res?.jpegBase64 || null
        }
        if (!jpegBase64) return
        const res = await command<{ detections?: Detection[]; stale?: boolean }>('frame_pump', { cameraId: camera.id, jpegBase64 })
        if (res?.detections && Array.isArray(res.detections)) {
          lastBoxes = res.detections
          // Atualiza o state via onDetections (React redesenha o SVG).
          onDetections?.(camera.id, res.detections)
        } else if (lastBoxes.length > 0) {
          // Timeout/falha: mantém o último estado de detecção.
          onDetections?.(camera.id, lastBoxes)
        }
      } catch {
        // transient — keep pumping; mantém o último estado de detecção
        if (lastBoxes.length > 0) {
          onDetections?.(camera.id, lastBoxes)
        }
      } finally {
        pumpingRef.current = false
      }
    }
    void run()
    const stagger = (hashCode(camera.id) % 3) * ((PUMP_INTERVALS[mode] || 1000) / 3)
    const t0 = setTimeout(() => void run(), stagger)
    const timer = window.setInterval(() => void run(), PUMP_INTERVALS[mode] || 1000)
    return () => {
      clearTimeout(t0)
      clearInterval(timer)
    }
  }, [camera, onDetections, mode])

  // Preview ao vivo via leitor MJPEG em JS (mesma lógica do card), sem o
  // <img multipart/x-mixed-replace> que congela no Chromium. O draw é direto
  // com "latest-wins" (drawing/queued), sem fila de decodes; o parse roda em
  // Web Worker quando disponível (fallback inline se não).
  useEffect(() => {
    if (!camera) return
    let cancelled = false
    const ac = new AbortController()
    const frameCanvas = frameCanvasRef.current
    const ctx = frameCanvas?.getContext('2d')
    if (!frameCanvas || !ctx) return

    let drawing = false
    let queued: Uint8Array | null = null

    // Tamanho do canvas cacheado (sem layout read por frame).
    let canvasW = frameCanvas.clientWidth || frameCanvas.width
    let canvasH = frameCanvas.clientHeight || frameCanvas.height
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            canvasW = frameCanvas.clientWidth || frameCanvas.width
            canvasH = frameCanvas.clientHeight || frameCanvas.height
          })
        : null
    ro?.observe(frameCanvas)

    const drawToCanvas = (bitmap: ImageBitmap | HTMLImageElement): void => {
      const cw = canvasW
      const ch = canvasH
      if (frameCanvas.width !== cw) frameCanvas.width = cw
      if (frameCanvas.height !== ch) frameCanvas.height = ch
      ctx.clearRect(0, 0, cw, ch)
      // object-contain: imagem inteira visível.
      const scale = Math.min(cw / bitmap.width, ch / bitmap.height)
      const dw = bitmap.width * scale
      const dh = bitmap.height * scale
      ctx.drawImage(bitmap, (cw - dw) / 2, (ch - dh) / 2, dw, dh)
      frameDimsRef.current = { w: bitmap.width, h: bitmap.height }
      if (!readyRef.current) {
        readyRef.current = true
        setReady(true)
      }
      if (errorRef.current !== null) {
        errorRef.current = null
        setError(null)
      }
    }

    const drawFallback = (frame: Uint8Array): Promise<void> =>
      new Promise((resolve) => {
        const img = new Image()
        const url = URL.createObjectURL(new Blob([frame as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }))
        img.onload = () => {
          try {
            if (!cancelled) drawToCanvas(img)
          } catch {
            // ignora frame inválido
          } finally {
            URL.revokeObjectURL(url)
            resolve()
          }
        }
        img.onerror = () => {
          URL.revokeObjectURL(url)
          resolve()
        }
        img.src = url
      })

    const drawFrame = async (frame: Uint8Array): Promise<void> => {
      if (cancelled) return
      try {
        if (typeof createImageBitmap === 'function') {
          // Decodifica direto dos BYTES do frame — sem Blob/cópia; decode em
          // thread de background.
          const bitmap = await createImageBitmap(frame as unknown as ImageBitmapSource)
          if (cancelled) {
            bitmap.close()
            return
          }
          drawToCanvas(bitmap)
          bitmap.close()
          return
        }
      } catch {
        // fallback
      }
      await drawFallback(frame)
    }

    const drawNext = (frame: Uint8Array): void => {
      if (cancelled) return
      if (drawing) {
        queued = frame
        return
      }
      drawing = true
      void drawFrame(frame).finally(() => {
        drawing = false
        if (queued && !cancelled) {
          const q = queued
          queued = null
          drawNext(q)
        }
      })
    }

    // Fonte dos frames: parser em Web Worker (thread separada) quando
    // disponível; senão o parser inline. O canvas nunca é transferido — se o
    // worker falhar, o inline assume na hora.
    const parser = createParserWorker({
      onFrame: (frame) => {
        if (cancelled) return
        lastFrameRef.current = frame
        drawNext(frame)
      },
      onError: () => {
        if (cancelled) return
        if (errorRef.current === null) {
          errorRef.current = 'Perda de conexão com a câmera. Feche e reabra para reconectar.'
          setError(errorRef.current)
        }
      },
      onFps: () => {}
    })
    if (parser) {
      parserWorkerRef.current = parser
      parser.start(streamUrl)
      // Fallback automático (mesma lógica do card): ack 'ready' ou inline.
      let inlineStarted = false
      const startInline = () => {
        if (cancelled || inlineStarted) return
        inlineStarted = true
        createMjpegReader(
          streamUrl,
          {
            onFrame: (frame) => {
              if (cancelled) return
              lastFrameRef.current = frame
              drawNext(frame)
            },
            onError: () => {
              if (cancelled) return
              if (errorRef.current === null) {
                errorRef.current = 'Perda de conexão com a câmera. Feche e reabra para reconectar.'
                setError(errorRef.current)
              }
            }
          },
          ac.signal
        )
      }
      const fallbackTimer = setTimeout(() => {
        if (parser.isReady()) return
        parser.dispose()
        parserWorkerRef.current = null
        startInline()
      }, 500)
      return () => {
        clearTimeout(fallbackTimer)
        cancelled = true
        ac.abort()
        ro?.disconnect()
        parser.dispose()
        parserWorkerRef.current = null
      }
    }

    // Fallback direto (jsdom / Worker indisponível).
    createMjpegReader(
      streamUrl,
      {
        onFrame: (frame) => {
          if (cancelled) return
          lastFrameRef.current = frame
          drawNext(frame)
        },
        onError: () => {
          if (cancelled) return
          if (errorRef.current === null) {
            errorRef.current = 'Perda de conexão com a câmera. Feche e reabra para reconectar.'
            setError(errorRef.current)
          }
        }
      },
      ac.signal
    )

    return () => {
      cancelled = true
      ac.abort()
      ro?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, streamUrl])

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
              className={`text-xs font-medium rounded-lg px-3 py-1.5 transition-all flex items-center gap-1.5 shadow-md active:scale-95 ${printStatus === 'success'
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
                    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                    <circle cx="12" cy="13" r="4" />
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
          <canvas
            ref={frameCanvasRef}
            className="absolute inset-0 w-full h-full"
          />

          {/* Bounding boxes — SVG overlay with object-contain letterbox */}
          <SvgBoxOverlay boxes={myDetections} frameDims={frameDimsRef.current} fit="contain" />

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

      {alert.description || alert.triggeredBy ? (
        <div className="px-5 py-3 bg-zinc-900 border-t border-white/10 shrink-0 flex items-center gap-2">
          <p className="text-xs text-gray-300">{alert.description}</p>
          {alert.triggeredBy ? (
            <span className="text-xs text-gray-500 shrink-0">{triggerLabel(alert)}</span>
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

function formatTriggerPortuguese(t: MonitorTriggerInfo): string {
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
      return t.type
  }
}

interface AddEditMonitorModalProps {
  isOpen: boolean
  onClose: () => void
  cameras: CameraInfo[]
  initialMonitor?: MonitorInfo | null
  onSave: () => Promise<void> | void
}

const EVENT_PLACEHOLDERS = [
  { token: '{cameraName}', label: 'Câmera' },
  { token: '{description}', label: 'Descrição' },
  { token: '{ts}', label: 'Horário' },
  { token: '{event.imageDataUri}', label: 'Imagem' }
]

// i18n pt-BR: traduz nomes de tools e campos para o seletor, mantendo o nome
// técnico apenas como fallback.
const TOOL_LABELS: Record<string, string> = {
  send_message: 'Enviar mensagem',
  list_contacts: 'Listar contatos',
  add_contact: 'Adicionar contato',
  remove_contact: 'Remover contato',
  get_stats: 'Estatísticas',
  get_history: 'Histórico',
  get_wa_contacts: 'Buscar contatos',
  get_wa_groups: 'Buscar grupos',
  control_device: 'Controlar dispositivo',
  set_light_color: 'Cor da luz',
  control_tv_remote: 'Controle da TV',
  control_climate: 'Controlar clima',
  call_ha_service: 'Serviço da casa',
  list_devices: 'Listar dispositivos',
  query_device: 'Consultar dispositivo',
  capture_snapshot: 'Capturar print',
  start_monitoring: 'Iniciar monitoramento',
  set_actions: 'Configurar ações',
  get_actions: 'Ver ações'
}

const PARAM_LABELS: Record<string, string> = {
  contact: 'Contato ou número',
  message: 'Mensagem',
  image: 'Imagem',
  media: 'Imagem',
  device_name: 'Dispositivo',
  action: 'Ação',
  brightness: 'Brilho',
  color: 'Cor',
  temperature: 'Temperatura',
  domain: 'Domínio',
  service: 'Serviço',
  data: 'Dados',
  room: 'Cômodo',
  cameraId: 'Câmera',
  camera: 'Câmera',
  monitorId: 'Monitor',
  label: 'Rótulo'
}

function humanizeKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function toolLabel(name: string): string {
  return TOOL_LABELS[name] || humanizeKey(name)
}

function paramLabel(key: string): string {
  return PARAM_LABELS[key] || humanizeKey(key)
}

// Formata os args de uma ação em texto legível, ex.: "Dispositivo: Luz, Cor: verde".
function formatActionArgs(args?: Record<string, unknown>): string {
  if (!args) return ''
  return Object.entries(args)
    .filter(([, v]) => !(typeof v === 'string' && !v.trim()))
    .map(([k, v]) => {
      const val = v && typeof v === 'object' ? JSON.stringify(v) : String(v)
      return `${paramLabel(k)}: ${val}`
    })
    .join(' · ')
}

// Campos que representam "entidades" (contato, dispositivo, câmera…) e
// merecem um seletor com busca em vez de um input livre.
const ENTITY_PARAM_KEYS = new Set(['contact', 'device_name', 'cameraId', 'camera', 'monitorId'])

/**
 * Generic action selector (MOM-115): reads the host catalog of installed
 * extensions and lets the user pick target → tool → args. Args pre-fill from
 * the tool schema defaults; the host resolves placeholders at execution time.
 *
 * UX: labels em português, campos de entidade (ex.: contato) viram seletor com
 * busca, placeholders clicáveis para pré-preencher.
 */
function ActionEditor({
  actions,
  onChange,
  footerButton = false
}: {
  actions: MonitorActionUI[]
  onChange: (next: MonitorActionUI[]) => void
  footerButton?: boolean
}): JSX.Element {
  const [catalog, setCatalog] = useState<CatalogExt[]>([])
  const [showDraft, setShowDraft] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [tool, setTool] = useState('')
  const [draftArgs, setDraftArgs] = useState<Record<string, unknown>>({})

  useEffect(() => {
    let cancelled = false
    sdk.api
      .get<CatalogExt[]>('/extensions')
      .then((res) => {
        if (cancelled || !res.ok) return
        const installed = (res.data || []).filter(
          (e) => e.installed !== false && e.enabled !== false && Array.isArray(e.tools) && e.tools.length > 0
        )
        setCatalog(installed)
        if (installed.length > 0) setTarget((prev) => prev || installed[0].id)
      })
      .catch(() => { })
    return () => {
      cancelled = true
    }
  }, [])

  const targetExt = catalog.find((e) => e.id === target)
  const toolDef = targetExt?.tools?.find((t) => t.name === tool)

  function selectTarget(nextTarget: string) {
    setTarget(nextTarget)
    const ext = catalog.find((e) => e.id === nextTarget)
    const first = ext?.tools?.find((t) => t.name !== 'get_actions' && t.name !== 'set_actions') || ext?.tools?.[0]
    setTool(first?.name || '')
    setDraftArgs(first ? defaultArgsFor(first) : {})
  }

  function selectTool(nextTool: string) {
    setTool(nextTool)
    setDraftArgs(defaultArgsFor(targetExt?.tools?.find((t) => t.name === nextTool) as CatalogTool))
  }

  function defaultArgsFor(def: CatalogTool | undefined): Record<string, unknown> {
    const props = def?.parameters?.properties || {}
    const out: Record<string, unknown> = {}
    for (const [key, param] of Object.entries(props)) {
      out[key] = param && param.default !== undefined ? param.default : ''
    }
    return out
  }

  function addAction() {
    if (!target || !tool) return
    const cleanArgs: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(draftArgs)) {
      if (typeof value === 'string' && !value.trim()) continue
      cleanArgs[key] = value
    }
    const nextAction: MonitorActionUI = {
      id: editingId || `act-${Date.now()}`,
      target,
      tool,
      args: Object.keys(cleanArgs).length ? cleanArgs : undefined
    }
    onChange(
      editingId
        ? actions.map((a) => (a.id === editingId ? nextAction : a))
        : [...actions, nextAction]
    )
    setShowDraft(false)
    setEditingId(null)
  }

  function startEdit(a: MonitorActionUI) {
    setEditingId(a.id || null)
    setTarget(a.target)
    setTool(a.tool)
    setDraftArgs(a.args ? { ...a.args } : {})
    setShowDraft(true)
  }

  function toggleDraft() {
    if (showDraft) {
      setEditingId(null)
      setDraftArgs({})
    }
    setShowDraft((v) => !v)
  }

  const props = toolDef?.parameters?.properties || {}

  return (
    <div className="space-y-3">
      <div className={`${footerButton ? 'flex items-center' : 'flex items-center justify-between'}`}>
        <label className="block text-xs font-semibold text-text-muted">
          Ações automáticas (o que fazer quando disparar)
        </label>
        {!footerButton ? (
          <button
            type="button"
            onClick={toggleDraft}
            className="text-[11px] font-medium text-emerald-400 hover:opacity-80 border border-emerald-500/30 hover:border-emerald-500 px-2.5 py-1 rounded-lg transition-colors"
          >
            {showDraft ? 'Cancelar' : '+ Adicionar ação'}
          </button>
        ) : null}
      </div>

      {actions.length === 0 && !showDraft ? (
        <p className="text-[11px] text-text-muted/70">
          Ex.: detectou pessoa → WhatsApp envia mensagem com o print. Campos
          disponíveis: {EVENT_PLACEHOLDERS.map((p) => p.label).join(', ')}
        </p>
      ) : null}

      {actions.map((a, i) => (
        <div
          key={a.id || i}
          className="flex items-start justify-between gap-2 bg-white/[0.03] border border-border/60 rounded-xl px-3 py-2"
        >
          <div className="min-w-0">
            <div className="text-xs font-medium text-text">
              {catalog.find((e) => e.id === a.target)?.name || a.target}
              <span className="text-text-muted"> / </span>
              {toolLabel(a.tool)}
            </div>
            {a.args && Object.keys(a.args).length > 0 ? (
              <div className="text-[11px] text-text-muted/70 truncate">{formatActionArgs(a.args)}</div>
            ) : null}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => startEdit(a)}
              className="p-1 text-text-muted hover:text-emerald-400 hover:bg-emerald-500/10 rounded-md transition-colors"
              aria-label="Editar ação"
              title="Editar ação"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => onChange(actions.filter((_, j) => j !== i))}
              className="text-gray-500 hover:text-red-400 text-sm"
              aria-label="Remover ação"
            >
              ×
            </button>
          </div>
        </div>
      ))}

      {showDraft ? (
        <div className="space-y-3 bg-white/[0.03] border border-border/60 rounded-xl p-3">
          <div>
            <label className="block text-[11px] font-semibold text-text-muted mb-1">
              Extensão alvo
            </label>            <select
              value={target}
              onChange={(e) => selectTarget(e.target.value)}
              className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text focus:outline-none focus:border-emerald-500"
            >
              {catalog.length === 0 ? (
                <option value="">Nenhuma extensão com ações instalada</option>
              ) : null}
              {catalog.map((ext) => (
                <option key={ext.id} value={ext.id}>
                  {ext.name || ext.id}
                </option>
              ))}
            </select>
          </div>

          {toolDef ? (
            <>
              <div>
                <label className="block text-[11px] font-semibold text-text-muted mb-1">Ação</label>
                <select
                  value={tool}
                  onChange={(e) => selectTool(e.target.value)}
                  className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text focus:outline-none focus:border-emerald-500"
                >
                  {targetExt?.tools
                    ?.filter((t) => t.name !== 'get_actions' && t.name !== 'set_actions')
                    .map((t) => (
                      <option key={t.name} value={t.name}>
                        {toolLabel(t.name)}
                      </option>
                    ))}
                </select>
              </div>

              <div className="space-y-2">
                {Object.entries(props).map(([key, param]) => (
                  <div key={key}>
                    <label className="block text-[11px] font-semibold text-text-muted mb-1">
                      {paramLabel(key)}
                      {param?.default !== undefined ? ' (pré-preenchido)' : ''}
                    </label>
                    {param?.enum ? (
                      <select
                        value={String(draftArgs[key] ?? '')}
                        onChange={(e) => setDraftArgs((d) => ({ ...d, [key]: e.target.value }))}
                        className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text focus:outline-none focus:border-emerald-500"
                      >
                        {param.enum.map((opt) => (
                          <option key={opt} value={opt}>
                            {opt}
                          </option>
                        ))}
                      </select>
                    ) : ENTITY_PARAM_KEYS.has(key) ? (
                      <SearchInput
                        paramKey={key}
                        target={target}
                        tool={tool}
                        value={String(draftArgs[key] ?? '')}
                        onChange={(v) => setDraftArgs((d) => ({ ...d, [key]: v }))}
                      />
                    ) : (
                      <input
                        type="text"
                        value={String(draftArgs[key] ?? '')}
                        onChange={(e) => setDraftArgs((d) => ({ ...d, [key]: e.target.value }))}
                        placeholder={param?.description || ''}
                        className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text placeholder-text-muted/60 focus:outline-none focus:border-emerald-500"
                      />
                    )}
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-1.5">
                {EVENT_PLACEHOLDERS.map((p) => (
                  <button
                    key={p.token}
                    type="button"
                    onClick={() =>
                      setDraftArgs((d) => {
                        const firstEmpty = Object.keys(props).find(
                          (k) => !String(d[k] ?? '').trim()
                        )
                        if (!firstEmpty) return d
                        return { ...d, [firstEmpty]: p.token }
                      })
                    }
                    className="text-[10px] text-text-muted border border-border/60 hover:border-emerald-500/60 hover:text-emerald-300 rounded-lg px-2 py-0.5 transition-colors"
                  >
                    {p.label} {p.token}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={addAction}
                className="text-[11px] font-semibold bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-lg transition-colors"
              >
                {editingId ? 'Salvar alterações' : 'Usar esta ação'}
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {footerButton ? (
        <button
          type="button"
          onClick={toggleDraft}
          className="text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white px-3.5 py-1.5 rounded-lg transition-colors shadow-md active:scale-[0.99] disabled:opacity-60"
        >
          {showDraft ? 'Cancelar' : 'Adicionar ação'}
        </button>
      ) : null}
    </div>
  )
}

/**
 * Input com dropdown + busca para campos de entidade (ex.: contato do
 * WhatsApp). Tenta carregar sugestões da extensão-alvo quando ela expõe uma
 * tool de listagem; caso contrário vira um campo de texto simples.
 */
function SearchInput({
  paramKey,
  target,
  tool,
  value,
  onChange
}: {
  paramKey: string
  target: string
  tool: string
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  const [options, setOptions] = useState<string[]>([])
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    // Tool genérica de listagem por tipo de campo (contato → list_contacts,
    // que devolve contatos E grupos; device_name → list_devices).
    const listTool =
      paramKey === 'contact' || paramKey === 'device_name'
        ? paramKey === 'contact'
          ? 'list_contacts'
          : 'list_devices'
        : null
    if (!listTool) return
    sdk.api
      .post<{ ok?: boolean; contacts?: unknown[]; groups?: unknown[]; devices?: unknown[] }>(
        `/extensions/${target}/command`,
        { toolName: listTool, args: {} }
      )
      .then((res) => {
        if (cancelled || !res.ok) return
        const names: string[] = []
        if (paramKey === 'contact') {
          const contacts = (res.data?.contacts || [])
            .map((c) => {
              const cc = c as { name?: string | null; notify?: string | null; phone?: string }
              return cc.name || cc.notify || cc.phone || ''
            })
            .filter(Boolean) as string[]
          const groups = (res.data?.groups || [])
            .map((g) => {
              const gg = g as { name?: string | null; subject?: string | null; id?: string }
              return gg.name || gg.subject || ''
            })
            .filter(Boolean) as string[]
          names.push(...contacts, ...groups)
        } else if (paramKey === 'device_name') {
          names.push(
            ...((res.data?.devices || []) as Array<{ name?: string }>)
              .map((d) => String(d.name || ''))
              .filter(Boolean)
          )
        }
        setOptions(Array.from(new Set(names)))
      })
      .catch(() => { })
    return () => {
      cancelled = true
    }
  }, [paramKey, target, tool])

  const filtered = value.trim()
    ? options.filter((o) => o.toLowerCase().includes(value.toLowerCase()))
    : options

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={options.length > 0 ? 'Digite para buscar…' : 'Digite nome ou número'}
        className="w-full bg-zinc-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-emerald-500"
      />
      {open && filtered.length > 0 ? (
        <div className="absolute z-20 mt-1 w-full max-h-40 overflow-y-auto bg-zinc-800 border border-white/10 rounded-xl shadow-xl custom-scrollbar">
          {filtered.slice(0, 30).map((opt) => (
            <button
              key={opt}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                onChange(opt)
                setOpen(false)
              }}
              className="block w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-emerald-500/10 hover:text-emerald-300 transition-colors"
            >
              {opt}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function AddEditMonitorModal({
  isOpen,
  onClose,
  cameras,
  initialMonitor,
  onSave
}: AddEditMonitorModalProps): JSX.Element | null {
  const isMaximized = useWindowMaximized()
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
  const [actions, setActions] = useState<MonitorActionUI[]>(initialMonitor?.actions || [])

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
          label: label.trim() || undefined,
          actions: actions.length ? actions : undefined
        })
      } else {
        await command('start_monitoring', {
          cameraId,
          triggers: [trigger],
          cooldownSec: finalCooldown,
          label: label.trim() || undefined,
          actions: actions.length ? actions : undefined
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
    <>
      <style>{`
        .mv-mmodal .mv-mmodal-card {
          overflow: hidden;
          width: 100%;
        }
        .mv-mmodal .mv-mmodal-card-max {
          max-width: 42rem;
        }
        /* In fullscreen (window not maximized) keep the form column comfortable
           and centered instead of sprawling edge-to-edge behind side panels. */
        .mv-mmodal .mv-mmodal-card:not(.mv-mmodal-card-max) .mv-mmodal-form {
          width: 100%;
          max-width: 36rem;
          margin: 0 auto;
        }
        /* Two-col camera/name fields on wide-enough cards */
        .mv-mgrid-2 {
          display: grid;
          grid-template-columns: 1fr;
          gap: 1.25rem;
        }
        /* Footer actions: stack on narrow cards, row on wide cards */
        .mv-mmodal-actions {
          display: flex;
          flex-direction: column-reverse;
          align-items: stretch;
          gap: 0.75rem;
        }
        .mv-mmodal-actions > button {
          width: 100%;
          justify-content: center;
        }
        @media (min-width: 640px) {
          .mv-mgrid-2 {
            grid-template-columns: 1fr 1fr;
          }
          .mv-mmodal-actions {
            flex-direction: row;
            align-items: center;
            justify-content: flex-end;
          }
          .mv-mmodal-actions > button {
            width: auto;
          }
        }
      `}</style>
      <div className={`mv-mmodal fixed inset-0 z-50 ${isMaximized ? 'flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fadeIn' : 'flex flex-col bg-black/90 animate-fadeIn'}`}>
        <div
          className={
            `mv-mmodal-card flex flex-col ${isMaximized
              ? 'mv-mmodal-card-max w-full bg-card border border-border rounded-xl shadow-xl max-h-[90vh]'
              : 'bg-card border-x border-border flex-1 max-h-full max-w-none'}`
          }
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-border/70 bg-sidebar shrink-0">
            <h2 className="text-sm font-bold text-text flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              {initialMonitor ? 'Editar Monitoramento' : 'Novo Monitoramento'}
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="text-text-muted hover:text-text rounded-lg p-1.5 hover:bg-white/10 transition-colors"
              aria-label="Fechar"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <form onSubmit={handleSubmit} className="mv-mmodal-form px-5 py-6 sm:px-8 space-y-6 overflow-y-auto custom-scrollbar flex-1">
            {error ? (
              <div className="p-3 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-xl">
                {error}
              </div>
            ) : null}

            <div className="mv-mgrid-2">
              <div>
                <label className="block text-xs font-semibold text-text-muted mb-1.5">
                  Câmera
                </label>
                <select
                  value={cameraId}
                  onChange={(e) => setCameraId(e.target.value)}
                  className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text focus:outline-none focus:border-emerald-500 font-medium"
                >
                  {cameras.map((cam) => (
                    <option key={cam.id} value={cam.id}>
                      {cam.name} ({cam.source === 'webcam' ? 'Webcam' : 'IP'})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-text-muted mb-1.5">
                  Nome <span className="font-normal text-text-muted/60">(Opcional)</span>
                </label>
                <input
                  type="text"
                  placeholder="ex: Portão da Garagem"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text placeholder-text-muted/60 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-text-muted mb-1.5">
                Gatilho de Alerta (Trigger)
              </label>
              <select
                value={triggerType}
                onChange={(e) => setTriggerType(e.target.value)}
                className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text focus:outline-none focus:border-emerald-500 font-medium"
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
                <label className="block text-xs font-semibold text-text-muted mb-1.5">
                  Sensibilidade de Movimento
                </label>
                <select
                  value={sensitivity}
                  onChange={(e) => setSensitivity(e.target.value)}
                  className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text focus:outline-none focus:border-emerald-500"
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
              <div className="space-y-4 bg-white/[0.03] p-4 rounded-xl border border-border/60">
                <div>
                  <label className="block text-xs font-semibold text-text-muted mb-1.5">
                    Objeto Inanimado a Detectar
                  </label>
                  <select
                    value={objectClass}
                    onChange={(e) => setObjectClass(e.target.value)}
                    className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text focus:outline-none focus:border-emerald-500 font-medium"
                  >
                    {INANIMATE_OBJECT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-text-muted mb-1.5">
                    Condição
                  </label>
                  <select
                    value={objectPresent ? 'true' : 'false'}
                    onChange={(e) => setObjectPresent(e.target.value === 'true')}
                    className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text focus:outline-none focus:border-emerald-500"
                  >
                    <option value="true">Detectar quando estiver Presente</option>
                    <option value="false">Detectar quando estiver Ausente</option>
                  </select>
                </div>
              </div>
            )}

            {triggerType === 'person' && (
              <div className="space-y-4 bg-white/[0.03] p-4 rounded-xl border border-border/60">
                <div className="text-xs text-text-muted flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                  <span>Detecta a presença de pessoas na cena via Inteligência Artificial.</span>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-text-muted mb-1.5">
                    Condição
                  </label>
                  <select
                    value={objectPresent ? 'true' : 'false'}
                    onChange={(e) => setObjectPresent(e.target.value === 'true')}
                    className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text focus:outline-none focus:border-emerald-500"
                  >
                    <option value="true">Detectar quando Pessoa estiver Presente</option>
                    <option value="false">Detectar quando Pessoa estiver Ausente</option>
                  </select>
                </div>
              </div>
            )}

            {triggerType === 'animal' && (
              <div className="space-y-4 bg-white/[0.03] p-4 rounded-xl border border-border/60">
                <div>
                  <label className="block text-xs font-semibold text-text-muted mb-1.5">
                    Animal a Detectar
                  </label>
                  <select
                    value={animalClass}
                    onChange={(e) => setAnimalClass(e.target.value)}
                    className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text focus:outline-none focus:border-emerald-500 font-medium"
                  >
                    {ANIMAL_OBJECT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-text-muted mb-1.5">
                    Condição
                  </label>
                  <select
                    value={objectPresent ? 'true' : 'false'}
                    onChange={(e) => setObjectPresent(e.target.value === 'true')}
                    className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text focus:outline-none focus:border-emerald-500"
                  >
                    <option value="true">Detectar quando Animal estiver Presente</option>
                    <option value="false">Detectar quando Animal estiver Ausente</option>
                  </select>
                </div>
              </div>
            )}

            {(triggerType === 'presence' || triggerType === 'absence') && (
              <div className="space-y-4 bg-white/[0.03] p-4 rounded-xl border border-border/60">
                <div>
                  <label className="block text-xs font-semibold text-text-muted mb-1.5">
                    Alvo (Ser Vivo ou Objeto)
                  </label>
                  <select
                    value={presenceTargetClass}
                    onChange={(e) => setPresenceTargetClass(e.target.value)}
                    className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text focus:outline-none focus:border-emerald-500 font-medium"
                  >
                    {ALL_OBJECT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-text-muted mb-1.5">
                    Evento
                  </label>
                  <select
                    value={presenceEvent}
                    onChange={(e) => setPresenceEvent(e.target.value)}
                    className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text focus:outline-none focus:border-emerald-500"
                  >
                    <option value="entered">Entrou / Apareceu na cena</option>
                    <option value="stayed">Permaneceu na cena</option>
                    <option value="left">Saiu / Desapareceu da cena</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-text-muted mb-1.5">
                    Janela de Tempo (Segundos)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={3600}
                    value={windowSec}
                    onChange={(e) => setWindowSec(Number(e.target.value) || 10)}
                    className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-text-muted mb-1.5">
                Intervalo mínimo entre Alertas (Cooldown)
              </label>
              <select
                value={cooldownPreset}
                onChange={(e) => setCooldownPreset(e.target.value)}
                className="w-full bg-input border border-border rounded-xl px-3 py-2 text-sm text-text focus:outline-none focus:border-emerald-500 font-medium"
              >
                {COOLDOWN_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>

              {cooldownPreset === 'custom' && (
                <div className="flex items-center gap-2 mt-2 bg-white/[0.03] p-3 rounded-xl border border-border/60 animate-fadeIn">
                  <input
                    type="number"
                    min={1}
                    max={86400}
                    value={customCooldownValue}
                    onChange={(e) => setCustomCooldownValue(Number(e.target.value) || 1)}
                    className="flex-1 bg-input border border-border rounded-xl px-3 py-1.5 text-sm text-text focus:outline-none focus:border-emerald-500 font-medium text-center"
                  />
                  <select
                    value={customCooldownUnit}
                    onChange={(e) => setCustomCooldownUnit(e.target.value as 'sec' | 'min')}
                    className="w-32 bg-input border border-border rounded-xl px-3 py-1.5 text-sm text-text focus:outline-none focus:border-emerald-500 font-medium"
                  >
                    <option value="sec">Segundos</option>
                    <option value="min">Minutos</option>
                  </select>
                </div>
              )}
            </div>

            <div className="mv-mmodal-actions pt-4 border-t border-border/70 shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="text-xs font-medium text-text-muted hover:text-text bg-white/5 hover:bg-white/10 px-4 py-2 rounded-xl transition-all"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2 rounded-xl transition-all shadow-md active:scale-95 disabled:opacity-60 flex items-center justify-center gap-2"
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
    </>
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
  const [monitors, setMonitors] = useState<MonitorInfo[]>(() => {
    try {
      const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(`${EXT_ID}:monitors`) : null
      return saved ? JSON.parse(saved) : []
    } catch {
      return []
    }
  })
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

  // Smoothing temporal (anti-pisca): o YOLO é instável entre frames — um
  // objeto perto do threshold pode sumir num frame e voltar no seguinte.
  // Mantemos a última detecção por um curto intervalo (HOLD_MS) antes de
  // apagá-la, então um frame vazio não faz o box piscar. Dois produtores
  // (pump da página + monitor via vision_detections) escrevem aqui; o hold
  // estabiliza ambos. Sem tracking real (Ids), é a forma barata e estável de
  // suavizar boxes independentes.
  // HOLD_MS DEVE ser MAIOR que o intervalo do ticker do monitor (~1000ms):
  // o ticker emite a cada ~1s e frames vazios intercalados (objeto borderline
  // de confiança) chegariam com now - prevTs >= HOLD_MS e LIMPARIAM os boxes
  // antes do próximo frame com detecção — fazendo os quadrados sumirem.
  const HOLD_MS = 1500
  const detLastTs = useRef<Record<string, number>>({})
  const detHoldRef = useRef<Record<string, Detection[]>>({})
  // DIAG: throttle de logs de applyDetections (máx 1 por 2s por câmera)
  const applyDiagTs = useRef<Record<string, number>>({})
  // DIAG: throttle de log do SSE vision_detections
  const sseDiagTs = useRef(0)

  const applyDetections = useCallback((cameraId: string, boxes: Detection[]) => {
    const now = Date.now()
    const prevTs = detLastTs.current[cameraId] || 0
    // DIAG: registrar toda chegada de detecção (fonte SSE/pump) para saber se
    // o problema é "não chega" vs "chega mas não desenha".
    if (cameraId && boxes.length >= 0) {
      const diagKey = `diag:${cameraId}`
      const last = applyDiagTs.current[diagKey] || 0
      if (now - last >= 2000) {
        applyDiagTs.current[diagKey] = now
        console.log(
          `[vision-diag][${cameraId}] applyDetections boxes=${boxes.length}${boxes.length > 0 ? ` ${boxes.map((b) => `${b.className}:${Math.round(b.confidence * 100)}%`).join(', ')}` : ''}`
        )
      }
    }
    if (boxes.length > 0) {
      // Resultado novo (não vazio): atualiza imediatamente e rearma o hold.
      detHoldRef.current[cameraId] = [...boxes]
      detLastTs.current[cameraId] = now
      setDetections((prev) => ({ ...prev, [cameraId]: [...boxes] }))
    } else if (now - prevTs < HOLD_MS) {
      // Frame vazio dentro do hold: mantém a última detecção visível.
      const held = detHoldRef.current[cameraId]
      if (held && held.length > 0) {
        setDetections((prev) => ({ ...prev, [cameraId]: [...held] }))
      }
    } else {
      // Fora do hold: apaga.
      detHoldRef.current[cameraId] = []
      setDetections((prev) => ({ ...prev, [cameraId]: [] }))
    }
  }, [])

  const handleDetections = applyDetections
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
      await navigator.clipboard.writeText(imgSrc).catch(() => { })
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

  const fetchActiveAutomationTriggers = useCallback(async (): Promise<any[]> => {
    const base =
      (window as any).api?.getApiBaseUrl?.() ||
      (window.parent as any)?.api?.getApiBaseUrl?.()
    if (!base) return []

    try {
      const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 600)
      const res = await fetch(`${cleanBase}/automations/active-triggers?provider=vision`, {
        signal: ctrl.signal
      }).finally(() => clearTimeout(timer))
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data)) return data
      }
    } catch { }
    return []
  }, [])

  // Silent poll — only updates camera/monitor data, no card reset or animation.
  // Guarda de reentrância (M6): o poll dispara 4 comandos e roda no interval de
  // 5s + no vision_status; sob carga um poll anterior ainda em voo faria outro
  // poll empilhar comandos no worker. Se um poll está em andamento, o novo é
  // pulado (o próximo ciclo cobre).
  const pollInFlightRef = useRef(false)
  const poll = useCallback(async () => {
    if (pollInFlightRef.current) return
    pollInFlightRef.current = true
    try {
      const [camRes, statusRes, alertsRes, activeTriggersRes] = await Promise.all([
        command<{ cameras: CameraInfo[]; selectedCameras?: string[] | null }>('list_cameras'),
        command<{ monitors: MonitorInfo[] }>('get_status'),
        command<{ alerts: Alert[] }>('list_alerts').catch(() => null),
        fetchActiveAutomationTriggers()
      ])
      const fetchedCams = camRes.cameras || []
      setCameras(fetchedCams)
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`${EXT_ID}:cameras`, JSON.stringify(fetchedCams))
      }

      let combinedMonitors: MonitorInfo[] = statusRes.monitors || []
      if (Array.isArray(activeTriggersRes) && activeTriggersRes.length > 0) {
        const autoMons: MonitorInfo[] = activeTriggersRes.map((auto: any) => {
          const trig = auto.trigger || {}
          const camCond = (auto.global_conditions || []).find((c: any) => c.field?.toLowerCase().includes('camera'))
          const rawCam = trig.trigger_config?.camera || trig.params?.camera || trig.camera || camCond?.value || ''
          const cam = fetchedCams.find((c) => c.id === rawCam || c.name === rawCam) || fetchedCams[0]
          const camId = cam ? cam.id : (rawCam || 'webcam:0')
          const camName = cam ? cam.name : camId
          const labelName = auto.automationName || 'Automação Hub'
          return {
            id: `auto-${auto.automationId}`,
            cameraId: camId,
            cameraName: camName,
            triggers: [{ type: trig.id || trig.type || 'vision:detection' }],
            label: `⚡ ${labelName}`,
            createdAt: Date.now(),
            paused: !auto.enabled,
            isAutomation: true,
            actions: auto.actions || []
          }
        })
        const existingIds = new Set(combinedMonitors.map((m) => m.id))
        for (const am of autoMons) {
          if (!existingIds.has(am.id)) {
            combinedMonitors.push(am)
          }
        }
      }

      setMonitors(combinedMonitors)
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`${EXT_ID}:monitors`, JSON.stringify(combinedMonitors))
      }
      if (Array.isArray(alertsRes?.alerts)) {
        // Merge, nunca substituição: alertas recém-chegados via SSE que ainda
        // não foram persistidos pelo backend não podem sumir da tela.
        setAlerts((prev) => mergeAlerts(prev, alertsRes.alerts as Alert[]))
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
    } finally {
      pollInFlightRef.current = false
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
    } catch { }
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
      setAlerts((prev) => mergeAlerts(prev, [alert]))
    })
    const unsubDetections = sdk.events.subscribe<{
      cameraId: string
      detections: Detection[]
    }>('vision_detections', (data: { cameraId: string; detections: Detection[] }) => {
      // DIAG: o SSE vision_detections está chegando ao renderer?
      const nowDiag = Date.now()
      if (nowDiag - (sseDiagTs.current || 0) >= 2000) {
        sseDiagTs.current = nowDiag
        console.log(
          `[vision-diag] SSE vision_detections camera=${data?.cameraId ?? '?'} boxes=${Array.isArray(data?.detections) ? data.detections.length : '?'}`
        )
      }
      if (data?.cameraId && Array.isArray(data.detections)) {
        applyDetections(data.cameraId, data.detections)
      }
    })
    const unsubStatus = sdk.events.subscribe('vision_status', () => {
      // Monitor config changed elsewhere (pause/resume/delete via overlay or
      // chat) — refresh the list right away instead of waiting for the poll.
      void poll()
    })
    return () => {
      unsubAlert()
      unsubDetections()
      unsubStatus()
    }
  }, [poll, applyDetections])

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
        // Removendo uma câmera IP do grid: além de sair da seleção, o cadastro
        // (ipCameras) também é apagado. Webcams não têm cadastro próprio, então
        // apenas saem da seleção.
        const isRemovingIp = cameraId.startsWith('ip:') && currentSelected.includes(cameraId)
        if (isRemovingIp) {
          const configRes = await command<{ config: { ipCameras?: Array<{ id: string; name: string; url: string }> } }>(
            'configure',
            {}
          )
          const current = configRes.config || {}
          const ipCamerasList = Array.isArray(current.ipCameras) ? current.ipCameras : []
          const updatedIp = ipCamerasList.filter((c) => c.id !== cameraId)
          await command('configure', { ipCameras: updatedIp, selectedCameras: nextSelected })
        } else {
          await command('configure', { selectedCameras: nextSelected })
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [config.selectedCameras]
  )

  // Applies the whole pending selection in one configure call: registers new
  // IP cameras and selects webcams/IPs together. Only called on confirm.
  //
  // Confirmação OTIMISTA: o modal fecha IMEDIATAMENTE ao confirmar e a
  // persistência (configure) + ativação do monitor rodam em BACKGROUND. Sob
  // carga (várias câmeras / reaquisição de webcam USB), o round-trip do
  // configure no node-core pode ser lento — o usuário não deve ficar preso em
  // "Adicionando...". A câmera já entra na grade otimisticamente e o status
  // "Conectado" converge via poll (5s) / waitForWebcamOnline (background). Em
  // caso de erro na persistência, um banner claro é exibido e o usuário pode
  // reabrir o modal e tentar de novo.
  const confirmAddCameras = useCallback(
    async (webcamIds: string[], ipDrafts: Array<{ name: string; url: string }>) => {
      setBusy(true)
      setIsModalOpen(false)

      // 1) OTIMISTA — a câmera entra na grade AGORA, sem esperar o round-trip
      //    do configure (que, sob carga com várias câmeras, pode demorar e
      //    fazer o configure/list_cameras estourar o timeout). Assim a câmera
      //    aparece imediatamente; a persistência roda em background e o status
      //    "Conectado" converge via poll (5s).
      const currentSelected = config.selectedCameras ?? []
      const ipIds = ipDrafts.map((d) => `ip:${d.url}`)
      const nextSelected = [...new Set([...currentSelected, ...webcamIds, ...ipIds])]

      setConfig((prev) => {
        const next = { ...prev, selectedCameras: nextSelected }
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(`${EXT_ID}:config`, JSON.stringify(next))
        }
        return next
      })
      setCameras((prev) => {
        const existing = new Set(prev.map((c) => c.id))
        const toAdd = webcamIds
          .filter((id) => !existing.has(id))
          .map(
            (id) =>
              knownCamerasRef.current[id] ?? {
                id,
                name: id.replace(/^webcam:/, '') || 'Webcam',
                source: 'webcam',
                online: false,
                monitors: 0
              }
          )
        return toAdd.length ? [...prev, ...toAdd] : prev
      })

      // 2) Persistência em background; erros vão para o banner (não travam a UI).
      void (async () => {
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
          await command('configure', { ipCameras: updatedIp, selectedCameras: nextSelected })
          void (async () => {
            try {
              // Refresh (atualiza a grade) em paralelo com a espera pelo status:
              // a webcam recém-adicionada vira "Conectado" assim que o watch
              // subir, sem esperar o poll de 5s (que sob carga demora).
              const refreshP = refresh().catch(() => {})
              if (webcamIds.length > 0) {
                await waitForWebcamOnline(webcamIds, (cams) => {
                  setCameras((prev) =>
                    prev.map((c) => (c.id in cams ? { ...c, online: !!cams[c.id]?.online } : c))
                  )
                }).catch(() => {})
              }
              await refreshP
            } catch {}
          })()
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      })()
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

  const handleDragLeave = useCallback(() => { }, [])

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

      void command('configure', { selectedCameras: nextSelectedIds }).catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
      })

      setDraggedIndex(null)
      setDragOverIndex(null)
    },
    [draggedIndex, displayedCameras]
  )

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null)
    setDragOverIndex(null)
  }, [])

  const activeMonitors = monitors.filter((m) => !m.paused)
  const pausedMonitors = monitors.filter((m) => m.paused)
  const activeCameras = activeMonitors.filter((m) => m.cameraId)
  const cameraIds = new Set(cameras.map((c) => c.id))
  const orphanMonitors = activeCameras.filter((m) => !cameraIds.has(m.cameraId))

  const tabClass = (tab: string) =>
    `px-3.5 py-1.5 text-xs font-medium rounded-full transition-all ${activeTab === tab ? 'bg-emerald-600 text-white shadow-md' : 'bg-white/5 text-gray-300 hover:bg-white/10'
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
          <p className="text-xs text-gray-300 mt-0.5">
            Visão e monitoramento 100% locais — nada sai da sua máquina.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400">
            {activeMonitors.length} monitor{activeMonitors.length !== 1 ? 'es' : ''} ativo{activeMonitors.length !== 1 ? 's' : ''}
            {pausedMonitors.length > 0
              ? ` · ${pausedMonitors.length} pausado${pausedMonitors.length !== 1 ? 's' : ''}`
              : ''}
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

      {/* Avisos de erro são redirecionados silenciosamente para o console (logs do dev) */}

      {/* Tab: Cameras Grid */}
      {activeTab === 'cameras' ? (
        <section>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5 md:gap-6 items-stretch">
            {displayedCameras.map((camera, idx) => (
              <CameraCard
                key={camera.id}
                camera={camera}
                detections={detections}
                onDetections={handleDetections}
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
                mode={config.trackingMode || 'balanced'}
                hasMonitor={monitors.some((m) => m.cameraId === camera.id && !m.paused)}
                suppressPump={expandedCamera?.id === camera.id}
              />
            ))}
            <AddCameraCard onClick={() => setIsModalOpen(true)} />
          </div>

          <div className="mt-8 pt-4">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div className="flex items-center gap-2.5">
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_10px_rgba(52,211,153,0.5)]" />
                <h3 className="text-lg font-bold text-white tracking-tight">
                  Monitoramento Ativo
                </h3>
                {monitors.length > 0 && (
                  <span className="text-xs text-gray-400 font-medium">
                    ({activeCameras.length + orphanMonitors.length})
                  </span>
                )}
              </div>
              <button
                onClick={() => {
                  const evt = new CustomEvent('momai:open_automation_modal', {
                    detail: { triggerProvider: 'momai-vision' }
                  })
                  window.dispatchEvent(evt)
                  if (window.parent && window.parent !== window) {
                    window.parent.dispatchEvent(evt)
                  }
                }}
                className="text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg px-3.5 py-2 transition-all shadow-md flex items-center gap-2 active:scale-95 cursor-pointer"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>Adicionar Monitoramento</span>
              </button>
            </div>

            {monitors.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-7 flex flex-col items-center justify-center text-center gap-2">
                <svg
                  className="w-7 h-7 text-gray-500"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
                  <circle cx="12" cy="12" r="3" />
                  <path d="M12 9.5V12l1.6 1.2" />
                </svg>
                <p className="text-xs text-gray-400 max-w-sm">
                  Nenhum monitoramento configurado no momento. Clique em
                  <span className="text-gray-300"> Adicionar Monitoramento </span>
                  acima para começar.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <ul className="divide-y divide-white/5">
                  {[...activeCameras, ...orphanMonitors].map((m) => (
                    <li key={m.id} className="flex items-center justify-between py-3 gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-white truncate">
                            {m.label || m.cameraName || m.cameraId}
                          </span>
                          {m.cameraName && m.label && (
                            <span className="text-xs text-gray-400 font-normal">
                              · {m.cameraName}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {m.triggers.map(formatTriggerPortuguese).join(' · ')}
                          {m.cooldownSec ? ` · Cooldown: ${m.cooldownSec}s` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => {
                            setEditingMonitor(m)
                            setIsMonitorModalOpen(true)
                          }}
                          className="text-xs font-medium text-gray-300 hover:text-white px-2.5 py-1 rounded-md hover:bg-white/10 transition-all"
                        >
                          Editar
                        </button>
                        <button
                          onClick={async () => {
                            try {
                              await command('pause_monitoring', { monitorId: m.id })
                              void refresh()
                            } catch (err) {
                              setError(err instanceof Error ? err.message : String(err))
                            }
                          }}
                          className="text-xs font-medium text-amber-400 hover:text-amber-300 px-2.5 py-1 rounded-md hover:bg-amber-500/10 transition-all"
                        >
                          Pausar
                        </button>
                        <button
                          onClick={async () => {
                            try {
                              await command('stop_monitoring', { monitorId: m.id })
                              void refresh()
                            } catch (err) {
                              setError(err instanceof Error ? err.message : String(err))
                            }
                          }}
                          title="Excluir monitoramento"
                          aria-label={`Excluir monitoramento ${m.label || m.cameraName || m.cameraId}`}
                          className="text-xs text-red-400 hover:text-red-300 p-1.5 rounded-md hover:bg-red-500/10 transition-all"
                        >
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>

                {pausedMonitors.length > 0 && (
                  <div className="pt-3 border-t border-white/5">
                    <h4 className="text-xs font-medium text-gray-400 mb-2">
                      Pausados ({pausedMonitors.length})
                    </h4>
                    <ul className="divide-y divide-white/5 opacity-75">
                      {pausedMonitors.map((m) => (
                        <li key={m.id} className="flex items-center justify-between py-2.5 gap-4">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-gray-300 truncate">
                                {m.label || m.cameraName || m.cameraId}
                              </span>
                              {m.cameraName && m.label && (
                                <span className="text-xs text-gray-500">
                                  · {m.cameraName}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-gray-500 mt-0.5">
                              {m.triggers.map(formatTriggerPortuguese).join(' · ')}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              onClick={async () => {
                                try {
                                  await command('resume_monitoring', { monitorId: m.id })
                                  void refresh()
                                } catch (err) {
                                  setError(err instanceof Error ? err.message : String(err))
                                }
                              }}
                              className="text-xs font-medium text-emerald-400 hover:text-emerald-300 px-2.5 py-1 rounded-md hover:bg-emerald-500/10 transition-all"
                            >
                              Retomar
                            </button>
                            <button
                              onClick={() => {
                                setEditingMonitor(m)
                                setIsMonitorModalOpen(true)
                              }}
                              className="text-xs font-medium text-gray-400 hover:text-gray-200 px-2.5 py-1 rounded-md hover:bg-white/10 transition-all"
                            >
                              Editar
                            </button>
                            <button
                              onClick={async () => {
                                try {
                                  await command('stop_monitoring', { monitorId: m.id })
                                  void refresh()
                                } catch (err) {
                                  setError(err instanceof Error ? err.message : String(err))
                                }
                              }}
                              title="Excluir monitoramento"
                              aria-label={`Excluir monitoramento ${m.label || m.cameraName || m.cameraId}`}
                              className="text-xs text-red-400 hover:text-red-300 p-1.5 rounded-md hover:bg-red-500/10 transition-all"
                            >
                              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2 2v2" />
                              </svg>
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
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
            alerts.map((alert: Alert) => {
              const imgSrc =
                alert.imageDataUri ||
                (alert.snapshotId
                  ? `${window.api?.getApiBaseUrl?.() || ''}/extensions/${EXT_ID}/storage/snapshots/${alert.snapshotId}.jpg`
                  : '')
              return (
                <div
                  key={alertKey(alert)}
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
                    {alert.description || alert.triggeredBy ? (
                      <p className="text-xs text-gray-300 mt-1">
                        {alert.description ? `${alert.description} ` : ''}
                        {alert.triggeredBy ? (
                          <span className="text-gray-500">{triggerLabel(alert)}</span>
                        ) : null}
                      </p>
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
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
        onDetections={handleDetections}
        onClose={() => setExpandedCamera(null)}
        onSnapshot={takeSnapshot}
        mode={config.trackingMode || 'balanced'}
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
