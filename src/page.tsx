/**
 * MomAI Vision — dashboard page.
 *
 * Camera grid with live preview (webcam getUserMedia + IP/MJPEG), bounding
 * boxes drawn on a transparent canvas over each video, alerts feed, print
 * gallery and settings. Detection data comes from the worker through the
 * extension command routes and SSE events.
 */

import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'
import { createPortal } from 'react-dom'
import { getSDK } from 'momai:sdk'
import { ptLabel, PT_CLASS, triggerLabel } from './vision/labels'
import { AlertCanvasOverlay } from './panel'
import { classColor } from './vision/theme-color'
import { extractJpegFrame, indexOfSeq } from './vision/mjpeg-parse'
import { filterDetectionsInZone, orderPointsClockwise, createBoxFromCorners, type Point } from './vision/zone'
import visionIconPng from '../icon.png'

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
  detectionZones?: Record<string, Point[]>
}

// Array vazio estável (módulo): evita criar referência nova a cada render do
// card, o que invalidaria o memo do drawBoxes sem necessidade.
const EMPTY_DETECTIONS: Detection[] = []

export function VisionIcon({ className = 'w-6 h-6' }: { className?: string }): JSX.Element {
  return (
    <img
      src={visionIconPng}
      alt="MomAI Vision"
      className={`${className} object-contain inline-block shrink-0`}
      draggable={false}
    />
  )
}

// Olho piscando + status amigável: mantém o olho em movimento (blink) mas
// nunca mostra "Sem sinal" durante a fase de conexão — só quando há erro real.
// O CSS é injetado uma vez e a animação é aplicada ao wrapper do ícone.
const VISION_EYE_BLINK_CSS = `
@keyframes vision-eye-blink {
  0%, 88%, 92%, 100% { transform: scaleY(1); }
  90% { transform: scaleY(0.12); }
}
.vision-eye-blink { animation: vision-eye-blink 3.2s ease-in-out infinite; transform-origin: center; display: inline-flex; }
`

function VisionBlinkStyleTag(): JSX.Element {
  return <style>{VISION_EYE_BLINK_CSS}</style>
}

function cameraPlaceholderStatus(
  camera: CameraInfo,
  reloading: boolean,
  error: string | null,
  isSlow: boolean,
  isUnavailable: boolean
): string {
  if (isUnavailable) return 'Sem sinal'
  if (error) return 'Sem sinal'
  if (isSlow) return 'Conectando...'
  if (reloading) return 'Conectando...'
  if (camera.online) return 'Iniciando...'
  return 'Conectando...'
}

function cameraPlaceholderSubtitle(
  camera: CameraInfo,
  reloading: boolean,
  error: string | null,
  isSlow: boolean,
  isUnavailable: boolean
): string | null {
  if (isUnavailable) return null
  if (error) return null
  if (isSlow || reloading || !camera.online) return null
  return null
}

function formatTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const dateStr = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const timeStr = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  return `${dateStr} ${timeStr}`
}

// Formata o nome de exibição da câmera: simplifica identificadores longos
// de webcam/USB como "USB2.0 PC CAMERA (1bcf:28c1)" para "USB 2.0".
function formatCameraName(name?: string | null, source?: string): string {
  if (!name) return 'Câmera'
  if (source === 'webcam' || /usb/i.test(name)) {
    const match = name.match(/usb\s*(\d+(?:[.,]\d+)?)/i)
    if (match) {
      return `USB ${match[1]}`
    }
    if (/usb/i.test(name)) {
      return 'USB'
    }
  }
  return name
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

// Helper assíncrono para encode de canvas sem bloquear o main thread.
// `toDataURL` é síncrono e trava o event loop a cada pump (2× por câmera),
// competindo com o decode do preview (createImageBitmap). `toBlob` é async
// (off-thread encode) e mantém o FPS do preview independente da detecção.
function canvasToBase64(canvas: HTMLCanvasElement, quality = 0.8): Promise<string> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve('')
            return
          }
          void blobToBase64(blob).then(resolve)
        },
        'image/jpeg',
        quality
      )
    } catch {
      try {
        resolve(canvas.toDataURL('image/jpeg', quality).split(',')[1] || '')
      } catch {
        resolve('')
      }
    }
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

// Taxa de detecção da página no engine YOLO (~1 inferência/s por câmera).
const PUMP_INTERVAL_MS = 1000

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

    // Teto de ~60fps com latest-wins, emitindo BYTES (zero cópia por frame).
    // Preview sempre no frame mais novo, com fluidez máxima sem atrasos.
    const MAX_EMIT_INTERVAL = 16 // ~60fps (máxima fluidez)
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
  onBitmap?: (bitmap: ImageBitmap, origW: number, origH: number) => void
  onFrame?: (frame: Uint8Array) => void
  onError?: () => void
  onFps?: (fps: number) => void
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
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxH: number } | null>(null)

  const close = useCallback(() => setOpen(false), [])

  // Posiciona o popover via portal no body, calculado pela posição real do
  // trigger na viewport. Isso escapa de qualquer clipping por overflow dos
  // ancestrais (ex.: o modal de adicionar câmeras tem overflow-y-auto e
  // cortava a lista de webcams na borda do card).
  const openWithPosition = useCallback(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const gap = 6
    const vh = window.innerHeight || document.documentElement.clientHeight || 0
    const maxBelow = vh - rect.bottom - gap
    const maxAbove = rect.top - gap
    const maxH = Math.max(96, Math.min(224, direction === 'up' ? maxAbove : maxBelow))
    // Abre para cima quando o espaço abaixo não comporta a lista.
    const openUp = direction === 'up' ? maxAbove >= maxH : maxBelow < maxH && maxAbove >= maxH
    if (openUp) {
      setPos({ top: rect.top - maxH - gap, left: rect.left, width: rect.width, maxH })
    } else {
      setPos({ top: rect.bottom + gap, left: rect.left, width: rect.width, maxH })
    }
    setOpen(true)
  }, [direction])

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const t = e.target as Node
      const insideTrigger = ref.current?.contains(t)
      const insidePopover = popoverRef.current?.contains(t)
      if (!insideTrigger && !insidePopover) close()
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    // Fecha ao rolar/redimensionar para nunca exibir o dropdown desalinhado
    // (a posição fixed não acompanha o scroll do modal).
    const handleScroll = () => close()
    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
      document.addEventListener('keydown', handleKeyDown)
      window.addEventListener('scroll', handleScroll, true)
      window.addEventListener('resize', handleScroll)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleScroll)
    }
  }, [open, close])

  const selectedOption = options.find((o) => o.value === value)

  return (
    <div className={`relative inline-block text-left ${open ? 'z-40' : 'z-10'} ${className}`} ref={ref}>
      <button
        type="button"
        onClick={() => (open ? close() : openWithPosition())}
        className={`w-full flex items-center justify-between gap-2 rounded-xl border border-border/40 bg-input text-text hover:bg-card hover:border-border transition-all font-medium select-none shadow-sm backdrop-blur-md active:scale-[0.99] ${size === 'sm' ? 'px-2.5 py-1.5 text-[11px]' : 'px-3.5 py-2.5 text-xs'
          }`}
      >
        <span className="flex items-center gap-2 truncate">
          {selectedOption?.icon}
          <span className="truncate">{selectedOption?.label || placeholder}</span>
        </span>
        <svg
          className={`w-3.5 h-3.5 text-text-muted shrink-0 transition-transform duration-200 ${open ? 'rotate-180 text-emerald-400' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && pos && createPortal(
        <div
          ref={popoverRef}
          role="listbox"
          style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxH }}
          className="fixed z-[100] rounded-xl border border-border/40 bg-card/95 backdrop-blur-xl shadow-2xl overflow-y-auto py-1 animate-fadeIn"
        >
          {options.map((opt) => {
            const isSelected = opt.value === value
            const isDisabled = !!opt.disabled
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={isDisabled}
                onClick={() => {
                  if (isDisabled) return
                  onChange(opt.value)
                  close()
                }}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors ${isDisabled
                  ? 'opacity-40 cursor-not-allowed text-text-muted bg-transparent'
                  : isSelected
                    ? 'bg-emerald-500/20 text-emerald-400 font-semibold'
                    : 'text-text hover:bg-input'
                  }`}
              >
                <span className="flex items-center gap-2 truncate">
                  {opt.icon}
                  <span className="truncate">{opt.label}</span>
                </span>
                <span className="flex items-center gap-1.5 shrink-0">
                  {opt.badge && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-input border border-border/30 text-text-muted font-normal">
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
        </div>,
        document.body
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
  fit = 'cover',
  zone
}: {
  boxes: Detection[]
  frameDims?: { w: number; h: number }
  fit?: 'cover' | 'contain'
  zone?: Point[] | null
}): JSX.Element | null {
  const visibleBoxes = useMemo(() => {
    if (!zone || zone.length < 3) return boxes
    return filterDetectionsInZone(boxes, zone)
  }, [boxes, zone])

  if (visibleBoxes.length === 0) return null

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
      {visibleBoxes.map((box, i) => {
        const color = classColor(box.className)
        if (fit === 'contain' && frameDims?.w && frameDims?.h) {
          const x1 = box.x1 * frameDims.w
          const y1 = box.y1 * frameDims.h
          const w = (box.x2 - box.x1) * frameDims.w
          const h = (box.y2 - box.y1) * frameDims.h
          const tagH = Math.max(16, frameDims.h * 0.04)
          const fontSize = Math.max(10, Math.round(frameDims.h * 0.03))
          return (
            <g key={`${box.className}-${i}`}>
              <rect
                x={x1} y={y1} width={w} height={h}
                stroke={color} strokeWidth="2" fill="none"
              />
              <rect
                x={x1} y={Math.max(0, y1 - tagH)} width={w} height={tagH}
                fill={color}
              />
              <text
                x={x1 + 3} y={Math.max(tagH - 3, y1 - 3)}
                fill="#0a0a0a" fontSize={fontSize} fontWeight="600" fontFamily="sans-serif"
              >
                {ptLabel(box.className)} {Math.round(box.confidence * 100)}%
              </text>
            </g>
          )
        }

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
              x={`${x1}%`} y={`${Math.max(0, y1 - 4)}%`} width={`${w}%`} height="4%"
              fill={color}
            />
            <text
              x={`${x1 + 0.5}%`} y={`${Math.max(2.8, y1 - 1)}%`}
              fill="#0a0a0a" fontSize="11" fontWeight="600" fontFamily="sans-serif"
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
// ZoneOverlay: interactive polygon selection & detection zone perimeter display
// ---------------------------------------------------------------------------

function ZoneOverlay({
  zone,
  draftPoints,
  isEditing,
  frameDims,
  fit,
  onAddPoint,
  onSetPoints,
  onSave,
  onClear,
  onCancel,
  onUndo
}: {
  zone?: Point[] | null
  draftPoints: Point[]
  isEditing: boolean
  frameDims: { w: number; h: number } | null
  fit: 'cover' | 'contain'
  onAddPoint?: (pt: Point) => void
  onSetPoints?: (pts: Point[]) => void
  onSave?: (points: Point[]) => void
  onClear?: () => void
  onCancel?: () => void
  onUndo?: () => void
}): JSX.Element | null {
  const hasSavedZone = Boolean(zone && zone.length >= 3)
  const isContain = fit === 'contain' && Boolean(frameDims?.w && frameDims?.h)
  const isCompact = fit === 'cover'
  const vbW = isContain && frameDims ? frameDims.w : 1000
  const vbH = isContain && frameDims ? frameDims.h : 1000

  // Modo de desenho: 'freehand' (lápis livre), 'box' (retângulo) ou 'points' (clicar ponto a ponto)
  type DrawMode = 'freehand' | 'box' | 'points'
  const [drawMode, setDrawMode] = useState<DrawMode>('freehand')
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement | null>(null)

  // Arrastar/editar vértices existentes
  const [dragVertexIdx, setDragVertexIdx] = useState<number | null>(null)
  const dragVertexIdxRef = useRef<number | null>(null)
  dragVertexIdxRef.current = dragVertexIdx

  const dragStartRef = useRef<Point | null>(null)
  const isDraggingRef = useRef(false)
  const freehandPointsRef = useRef<Point[]>([])

  // Fecha o dropdown ao clicar fora
  useEffect(() => {
    if (!isDropdownOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false)
      }
    }
    window.addEventListener('mousedown', handleClickOutside)
    return () => window.removeEventListener('mousedown', handleClickOutside)
  }, [isDropdownOpen])

  const getSvgNormPoint = (e: React.MouseEvent<SVGSVGElement>): Point | null => {
    const svg = e.currentTarget
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    const p = pt.matrixTransform(ctm.inverse())
    const nx = Math.max(0, Math.min(1, p.x / vbW))
    const ny = Math.max(0, Math.min(1, p.y / vbH))
    return { x: Number(nx.toFixed(4)), y: Number(ny.toFixed(4)) }
  }

  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!isEditing) return
    const pt = getSvgNormPoint(e)
    if (!pt) return
    dragStartRef.current = pt
    isDraggingRef.current = false
    if (drawMode === 'freehand') {
      freehandPointsRef.current = [pt]
      if (onSetPoints) {
        onSetPoints([pt])
      }
    }
  }

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!isEditing) return
    const pt = getSvgNormPoint(e)
    if (!pt) return

    // 1. Edição de vértice: arrastar bolinha para ajustar a posição do ponto
    if (dragVertexIdxRef.current !== null && onSetPoints) {
      const idx = dragVertexIdxRef.current
      const currentList = isEditing ? draftPoints : (zone || [])
      const updated = [...currentList]
      if (idx >= 0 && idx < updated.length) {
        updated[idx] = pt
        onSetPoints(updated)
      }
      return
    }

    if (!dragStartRef.current || !onSetPoints) return
    const start = dragStartRef.current
    const distFromStart = Math.hypot(pt.x - start.x, pt.y - start.y)

    if (distFromStart > 0.012) {
      isDraggingRef.current = true
    }

    if (!isDraggingRef.current) return

    if (drawMode === 'box') {
      const box = createBoxFromCorners(start, pt)
      onSetPoints(box)
    } else if (drawMode === 'freehand') {
      // Modo Lápis Livre: adiciona pontos continuamente por onde o mouse/lápis passa
      const pts = freehandPointsRef.current
      const lastPt = pts[pts.length - 1] || start
      const distFromLast = Math.hypot(pt.x - lastPt.x, pt.y - lastPt.y)
      if (distFromLast >= 0.015) {
        pts.push(pt)
        onSetPoints([...pts])
      }
    }
  }

  const handleMouseUp = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!isEditing) return

    // Soltou o vértice que estava sendo editado/arrastado
    if (dragVertexIdxRef.current !== null) {
      setDragVertexIdx(null)
      return
    }

    if (!dragStartRef.current) return
    const pt = getSvgNormPoint(e)
    const wasDragging = isDraggingRef.current
    const currentMode = drawMode
    dragStartRef.current = null
    isDraggingRef.current = false

    if (!wasDragging) {
      // Clique pontual sem arrastar no modo 'points': insere vértice individual
      if (pt && currentMode === 'points' && onAddPoint) {
        onAddPoint(pt)
      }
    } else if (currentMode === 'freehand') {
      // Finalizou desenho livre com o lápis
      const pts = freehandPointsRef.current
      if (pts.length >= 3 && onSetPoints) {
        onSetPoints([...pts])
      }
    }
  }

  // Pontos ativos para renderizar: rascunho durante edição ou zona salva
  const activePoints = isEditing ? draftPoints : (hasSavedZone ? zone! : [])
  const svgPointsStr = activePoints.map((p) => `${p.x * vbW},${p.y * vbH}`).join(' ')

  const style: React.CSSProperties = isContain
    ? { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }
    : {}

  return (
    <>
      {/* SVG polygon layer com suporte a lápis livre (freehand), retângulo e pontos */}
      <svg
        className={`absolute inset-0 w-full h-full z-20 ${
          isEditing ? 'cursor-crosshair pointer-events-auto select-none' : 'pointer-events-none'
        }`}
        style={style}
        viewBox={`0 0 ${vbW} ${vbH}`}
        preserveAspectRatio={isContain ? 'xMidYMid meet' : 'none'}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        {/* Polígono: em edição fica vermelho; salvo fica em azul claro com intensidade aumentada */}
        {activePoints.length >= 3 ? (
          <polygon
            points={svgPointsStr}
            fill={isEditing ? 'rgba(239, 68, 68, 0.16)' : 'rgba(56, 189, 248, 0.12)'}
            stroke={isEditing ? '#ef4444' : 'rgba(56, 189, 248, 0.85)'}
            strokeWidth={isEditing ? '2.5' : '1.8'}
            strokeDasharray={isEditing ? '6 4' : '5 3'}
          />
        ) : activePoints.length === 2 ? (
          <polyline
            points={svgPointsStr}
            fill="none"
            stroke="#ef4444"
            strokeWidth="2.5"
            strokeDasharray="6 4"
          />
        ) : null}

        {/* Vértices/bolinhas editáveis: visíveis nos modos 'points' ou 'box' (ou poucos pontos) para arrastar e ajustar */}
        {isEditing && (drawMode === 'points' || drawMode === 'box' || activePoints.length <= 16) &&
          activePoints.map((p, idx) => {
            const isDraggingThis = dragVertexIdx === idx
            return (
              <g key={idx}>
                {/* Hit area invisível maior para facilitar agarrar com o mouse */}
                <circle
                  cx={p.x * vbW}
                  cy={p.y * vbH}
                  r={isCompact ? 9 : 14}
                  fill="transparent"
                  className="cursor-move pointer-events-auto"
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    setDragVertexIdx(idx)
                  }}
                  
                />
                <circle
                  cx={p.x * vbW}
                  cy={p.y * vbH}
                  r={isDraggingThis ? (isCompact ? 5.5 : 8) : (isCompact ? 3.5 : 5.5)}
                  fill={isDraggingThis ? '#f59e0b' : '#ef4444'}
                  stroke="#ffffff"
                  strokeWidth={isDraggingThis ? 2.5 : (isCompact ? 1.5 : 2)}
                  className="cursor-move pointer-events-none transition-transform"
                />
              </g>
            )
          })}
      </svg>

      {/* Durante edição: barra flutuante no canto inferior direito adaptada aos temas e sem contagem de pontos */}
      {isEditing ? (
        isCompact ? (
          /* Modo Card Compacto: leve, compacto, adaptado aos temas com Dropdown de modos */
          <div className="absolute bottom-1.5 right-1.5 z-40 flex items-center gap-1 p-1 rounded-lg bg-card/90 backdrop-blur-xs border border-border/40 text-text text-xs shadow-xl animate-fadeIn pointer-events-auto">
            {/* Dropdown de Ferramentas no Card Pequeno */}
            <div ref={dropdownRef} className="relative">
              <button
                type="button"
                onClick={() => setIsDropdownOpen((v) => !v)}
                className="px-1.5 py-0.5 rounded bg-transparent hover:bg-input text-text font-bold text-[9px] border border-border/40 transition-colors flex items-center gap-0.5"
                title="Escolher ferramenta de seleção de área"
              >
                <span>
                  {drawMode === 'freehand' ? '✏️ Livre' : drawMode === 'box' ? '▢ Retângulo' : '📍 Pontos'}
                </span>
                <svg className={`w-2.5 h-2.5 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>

              {isDropdownOpen ? (
                <div className="absolute bottom-full mb-1 left-0 z-50 min-w-[110px] py-1 bg-card/95 border border-border/50 rounded-lg shadow-xl backdrop-blur-md text-[10px] animate-fadeIn">
                  <button
                    type="button"
                    onClick={() => { setDrawMode('freehand'); setIsDropdownOpen(false) }}
                    className={`w-full text-left px-2 py-1 flex items-center gap-1.5 hover:bg-input transition-colors ${drawMode === 'freehand' ? 'font-bold text-text bg-input/60' : 'text-text-muted hover:text-text'}`}
                  >
                    <span>✏️</span> <span>Lápis livre</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setDrawMode('box'); setIsDropdownOpen(false) }}
                    className={`w-full text-left px-2 py-1 flex items-center gap-1.5 hover:bg-input transition-colors ${drawMode === 'box' ? 'font-bold text-text bg-input/60' : 'text-text-muted hover:text-text'}`}
                  >
                    <span>▢</span> <span>Retângulo</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setDrawMode('points'); setIsDropdownOpen(false) }}
                    className={`w-full text-left px-2 py-1 flex items-center gap-1.5 hover:bg-input transition-colors ${drawMode === 'points' ? 'font-bold text-text bg-input/60' : 'text-text-muted hover:text-text'}`}
                  >
                    <span>📍</span> <span>Pontos</span>
                  </button>
                </div>
              ) : null}
            </div>

            {draftPoints.length > 0 && onUndo ? (
              <button
                type="button"
                onClick={onUndo}
                className="px-1.5 py-0.5 rounded bg-transparent hover:bg-input text-text font-medium text-[9px] border border-border/40 transition-colors"
                title="Desfazer último ponto"
              >
                Desfazer
              </button>
            ) : null}

            {onClear ? (
              <button
                type="button"
                onClick={onClear}
                className="px-1.5 py-0.5 rounded bg-transparent hover:bg-red-500/20 text-red-500 hover:text-red-400 font-medium text-[9px] border border-border/40 transition-colors"
                title="Limpar área"
              >
                Limpar
              </button>
            ) : null}

            {onCancel ? (
              <button
                type="button"
                onClick={onCancel}
                className="px-1.5 py-0.5 rounded bg-transparent hover:bg-input text-text font-bold text-[9px] border border-border/40 transition-colors"
              >
                Cancelar
              </button>
            ) : null}

            {onSave ? (
              <button
                type="button"
                disabled={draftPoints.length < 3}
                onClick={() => onSave(draftPoints)}
                className={`px-2 py-0.5 rounded font-bold text-[9px] transition-all shadow-sm border ${
                  draftPoints.length >= 3
                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-400'
                    : 'bg-transparent text-text-muted/40 border-border/30 cursor-not-allowed'
                }`}
              >
                Salvar
              </button>
            ) : null}
          </div>
        ) : (
          /* Modo Modal Ampliado: barra com dropdown (Lápis Livre / Retângulo / Pontos), adaptado aos temas e sem contagem de pontos */
          <div className="absolute bottom-4 right-4 z-40 flex items-center gap-2 p-2 rounded-2xl bg-card/90 backdrop-blur-md border border-border/40 text-text text-sm shadow-2xl animate-fadeIn pointer-events-auto">
            {/* Dropdown de Ferramentas no Modal Ampliado */}
            <div ref={dropdownRef} className="relative">
              <button
                type="button"
                onClick={() => setIsDropdownOpen((v) => !v)}
                className="px-3 py-1.5 rounded-xl bg-input/60 hover:bg-input text-text font-bold text-xs border border-border/40 transition-colors flex items-center gap-2 shadow-sm"
                title="Escolher ferramenta de seleção de área"
              >
                <span>
                  {drawMode === 'freehand' ? '✏️ Lápis livre' : drawMode === 'box' ? '▢ Retângulo' : '📍 Pontos'}
                </span>
                <svg className={`w-3 h-3 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>

              {isDropdownOpen ? (
                <div className="absolute bottom-full mb-2 left-0 z-50 min-w-[175px] py-1 bg-card/95 border border-border/50 rounded-xl shadow-2xl backdrop-blur-md text-xs animate-fadeIn overflow-hidden">
                  <button
                    type="button"
                    onClick={() => { setDrawMode('freehand'); setIsDropdownOpen(false) }}
                    className={`w-full text-left px-3 py-2 flex items-center gap-2.5 hover:bg-input transition-colors ${drawMode === 'freehand' ? 'font-bold text-text bg-input/60' : 'text-text-muted hover:text-text'}`}
                  >
                    <span className="text-sm">✏️</span>
                    <div>
                      <div className="font-semibold">Lápis livre</div>
                      <div className="text-[10px] text-text-muted">Desenhar trajeto contínuo</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setDrawMode('box'); setIsDropdownOpen(false) }}
                    className={`w-full text-left px-3 py-2 flex items-center gap-2.5 hover:bg-input transition-colors ${drawMode === 'box' ? 'font-bold text-text bg-input/60' : 'text-text-muted hover:text-text'}`}
                  >
                    <span className="text-sm">▢</span>
                    <div>
                      <div className="font-semibold">Retângulo</div>
                      <div className="text-[10px] text-text-muted">Arrastar caixa de 4 cantos</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => { setDrawMode('points'); setIsDropdownOpen(false) }}
                    className={`w-full text-left px-3 py-2 flex items-center gap-2.5 hover:bg-input transition-colors ${drawMode === 'points' ? 'font-bold text-text bg-input/60' : 'text-text-muted hover:text-text'}`}
                  >
                    <span className="text-sm">📍</span>
                    <div>
                      <div className="font-semibold">Pontos</div>
                      <div className="text-[10px] text-text-muted">Clicar ponto a ponto na tela</div>
                    </div>
                  </button>
                </div>
              ) : null}
            </div>

            {draftPoints.length > 0 && onUndo ? (
              <button
                type="button"
                onClick={onUndo}
                className="px-3 py-1 rounded-xl bg-transparent hover:bg-input text-text font-bold text-sm border border-border/40 transition-colors"
              >
                Desfazer
              </button>
            ) : null}

            {onClear ? (
              <button
                type="button"
                onClick={onClear}
                className="px-3 py-1 rounded-xl bg-transparent hover:bg-red-500/20 text-red-500 hover:text-red-400 font-bold text-sm border border-border/40 transition-colors"
              >
                Limpar
              </button>
            ) : null}

            {onCancel ? (
              <button
                type="button"
                onClick={onCancel}
                className="px-3 py-1 rounded-xl bg-transparent hover:bg-input text-text font-bold text-sm border border-border/40 transition-colors"
              >
                Cancelar
              </button>
            ) : null}

            {onSave ? (
              <button
                type="button"
                disabled={draftPoints.length < 3}
                onClick={() => onSave(draftPoints)}
                className={`px-4 py-1 rounded-xl font-bold text-sm transition-all shadow-md flex items-center gap-1.5 border ${
                  draftPoints.length >= 3
                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white border-emerald-400 shadow-emerald-900/40'
                    : 'bg-transparent text-text-muted/40 border-border/30 cursor-not-allowed'
                }`}
              >
                Salvar
              </button>
            ) : null}
          </div>
        )
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// Camera Card with Live Preview & Top Header Bar (Name, Expand & Close)
// ---------------------------------------------------------------------------

const CameraCard = memo(function CameraCard({
  camera,
  boxes = EMPTY_DETECTIONS,
  zone,
  isEditingZone = false,
  onToggleEditZone,
  onSaveZone,
  onClearZone,
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
  hasMonitor = false,
  suppressPump = false
}: {
  camera: CameraInfo
  boxes?: Detection[]
  zone?: Point[] | null
  isEditingZone?: boolean
  onToggleEditZone?: () => void
  onSaveZone?: (points: Point[]) => void
  onClearZone?: () => void
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
  hasMonitor?: boolean
  // Quando o ExpandedCameraModal está aberto para esta câmera, o modal já
  // bombeia frames de detecção para ela — o card por trás não precisa
  // duplicar a carga (2 fetchDirectFrame + 2 frame_pump por ciclo).
  suppressPump?: boolean
}): JSX.Element {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const [draftPoints, setDraftPoints] = useState<Point[]>([])

  useEffect(() => {
    if (isEditingZone) {
      setDraftPoints(zone && zone.length >= 3 ? [...zone] : [])
    }
  }, [isEditingZone, zone])

  const handleAddDraftPoint = useCallback((pt: Point) => {
    setDraftPoints((prev) => {
      const next = [...prev, pt]
      return next.length >= 3 ? orderPointsClockwise(next) : next
    })
  }, [])

  const handleSetDraftPoints = useCallback((pts: Point[]) => {
    setDraftPoints(pts)
  }, [])

  const handleUndoDraftPoint = useCallback(() => {
    setDraftPoints((prev) => prev.slice(0, -1))
  }, [])

  const handleSaveDraftZone = useCallback(() => {
    if (draftPoints.length >= 3 && onSaveZone) {
      onSaveZone(draftPoints)
    }
  }, [draftPoints, onSaveZone])

  const handleClearDraftZone = useCallback(() => {
    setDraftPoints([])
    onClearZone?.()
  }, [onClearZone])

  const handleCancelDraftZone = useCallback(() => {
    setDraftPoints([])
    onToggleEditZone?.()
  }, [onToggleEditZone])

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
  // Fase de conexão lenta/indisponível: se demorar demais sem frame, mostra feedback amigável
  const [isSlow, setIsSlow] = useState(false)
  const [isUnavailable, setIsUnavailable] = useState(false)
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

  // Redraw de boxes apenas quando as detecções DESTA câmera mudam.
  const myDetections = boxes

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

  // Feedback de conexão demorada: se ficar muito tempo sem frame, mostra
  // estados progressivos "Ainda conectando..." (12s) e "Câmera indisponível" (22s)
  // em vez de deixar "Conectando..." para sempre. Reseta ao receber frame, erro ou reload.
  useEffect(() => {
    if (hasFrame || error) {
      setIsSlow(false)
      setIsUnavailable(false)
      return
    }
    setIsSlow(false)
    setIsUnavailable(false)
    const slowTimer = setTimeout(() => setIsSlow(true), 12000)
    const unavailableTimer = setTimeout(() => {
      setIsSlow(true)
      setIsUnavailable(true)
    }, 22000)
    return () => {
      clearTimeout(slowTimer)
      clearTimeout(unavailableTimer)
    }
  }, [hasFrame, error, camera.id, reloading, refreshKey])

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
  // Preview unificado: tanto webcam quanto IP usam o MJPEG stream do
  // node-core (via hidden window para webcam, via FFmpeg/fetch para IP).
  // Antes a webcam usava `getUserMedia` local (`<video>`) em paralelo ao
  // `getUserMedia` da hidden window — 2 streams concorrentes no mesmo device
  // causavam `Failed to reserve output capture buffer` e travavam a webcam
  // quando a IP era adicionada (a hidden window tentava restart e competia).
  // Agora há só 1 `getUserMedia` (hidden window) e o preview de ambas é o mesmo
  // caminho de canvas + Worker, garantindo independência real.
  useEffect(() => {
    if (!isActive) return

    let cancelled = false
    const ac = new AbortController()
    const frameCanvas = frameCanvasRef.current
    const ctx = frameCanvas?.getContext('2d')
    if (!frameCanvas || !ctx) return

    let drawing = false
    let queued: Uint8Array | null = null

    // V-Sync Engine: sincroniza a renderização com a taxa de atualização da tela
    // e descarta quadros atrasados em rajadas de rede (latest-wins vsync).
    let pendingBitmap: ImageBitmap | HTMLImageElement | null = null
    let pendingW = 0
    let pendingH = 0
    let rafId: number | null = null

    const renderVsyncFrame = () => {
      rafId = null
      if (!pendingBitmap || cancelled) return
      const bmp = pendingBitmap
      const w = pendingW
      const h = pendingH
      pendingBitmap = null

      if (frameCanvas.width !== bmp.width) frameCanvas.width = bmp.width
      if (frameCanvas.height !== bmp.height) frameCanvas.height = bmp.height
      ctx.drawImage(bmp, 0, 0)

      if ('close' in bmp && typeof (bmp as ImageBitmap).close === 'function') {
        (bmp as ImageBitmap).close()
      }

      frameDimsRef.current = {
        w: w || bmp.width,
        h: h || bmp.height
      }

      framesRef.current++
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
      if (fpsTsRef.current === 0) fpsTsRef.current = now
      const elapsed = now - fpsTsRef.current
      if (elapsed >= 1000) {
        const realFps = Math.min(30, Math.round((framesRef.current * 1000) / elapsed))
        setFps(realFps)
        framesRef.current = 0
        fpsTsRef.current = now
      }

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

        const drawToCanvas = (
      bitmap: ImageBitmap | HTMLImageElement,
      origW = 0,
      origH = 0
    ): void => {
      if (pendingBitmap && 'close' in pendingBitmap && typeof (pendingBitmap as ImageBitmap).close === 'function') {
        (pendingBitmap as ImageBitmap).close()
      }
      pendingBitmap = bitmap
      pendingW = origW
      pendingH = origH

      if (rafId === null) {
        rafId = typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(renderVsyncFrame)
          : (setTimeout(renderVsyncFrame, 16) as unknown as number)
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
          const dims = jpegDims(frame)
          if (dims && dims.w > 1280) {
            let scale = 0.5
            while (dims.w * scale > 1280) scale *= 0.5
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

    // Fonte dos frames: Web Worker com decodificação ImageBitmap em thread separada.
    const parser = createParserWorker({
      onBitmap: (bitmap, origW, origH) => {
        if (cancelled) {
          bitmap.close()
          return
        }
        drawToCanvas(bitmap, origW, origH)
      },
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
      },
      onFps: () => {}
    })
    if (parser) {
      parserWorkerRef.current = parser
      parser.start(streamUrl)
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
      }, 8000)
      return () => {
        clearTimeout(fallbackTimer)
        cancelled = true
        if (rafId !== null) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId)
          else clearTimeout(rafId)
          rafId = null
        }
        if (pendingBitmap && 'close' in pendingBitmap && typeof (pendingBitmap as ImageBitmap).close === 'function') {
          (pendingBitmap as ImageBitmap).close()
          pendingBitmap = null
        }
        ac.abort()
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
    const interval = PUMP_INTERVAL_MS
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
      if (cancelled || suppressPumpRef.current || document.hidden) {
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
            jpegBase64 = await canvasToBase64(tempCanvas, 0.7)
          }
        } else if (lastFrameRef.current && lastFrameRef.current.length > 0) {
          // Câmera IP: extrai os bytes do ÚLTIMO frame JPEG recebido pelo leitor MJPEG
          jpegBase64 = await blobToBase64(
            new Blob([lastFrameRef.current as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
          )
        } else if (frameCanvasRef.current && (hasFrameRef.current || (frameDimsRef.current.w > 0 && frameDimsRef.current.h > 0))) {
          const c = frameCanvasRef.current
          const cw = frameDimsRef.current.w || c.width || 640
          const ch = frameDimsRef.current.h || c.height || 360
          const tempCanvas = document.createElement('canvas')
          const scale = Math.min(640 / cw, 360 / ch, 1)
          tempCanvas.width = Math.max(1, Math.round(cw * scale))
          tempCanvas.height = Math.max(1, Math.round(ch * scale))
          const ctx = tempCanvas.getContext('2d')
          if (ctx) {
            ctx.drawImage(c, 0, 0, tempCanvas.width, tempCanvas.height)
            jpegBase64 = await canvasToBase64(tempCanvas, 0.7)
          }
        } else {
          const parser = parserWorkerRef.current
          if (parser) {
            const buf = await parser.getFrame()
            if (buf && buf.length > 0) {
              jpegBase64 = await blobToBase64(
                new Blob([buf as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' })
              )
            }
          }
        }
        if (!jpegBase64) {
          jpegBase64 = await fetchDirectFrame(camera.id).catch(() => null)
        }
        if (!jpegBase64) {
          const res = await command<{ jpegBase64?: string }>('get_frame', { cameraId: camera.id }).catch(() => null)
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
          void request.catch(() => {}).finally(() => {
            pumpingRef.current = false
          })
          const res = await Promise.race([
            request,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), PUMP_COMMAND_TIMEOUT_MS))
          ])
          if (res === null) {
            // Timeout do frame_pump: libera pumpingRef para não travar próximos ciclos
            pumpingRef.current = false
          }
          if (res?.detections && Array.isArray(res.detections) && !cancelled) {
            lastBoxes = res.detections
            // Atualiza o state via onDetections (React redesenha o SVG).
            // Se detections for [], o applyDetections limpa os boxes após o HOLD_MS.
            onDetections?.(camera.id, res.detections)
          } else if (res === null && lastBoxes.length > 0 && !cancelled) {
            // Apenas se for TIMEOUT estrito (res === null) mantém temporariamente os boxes anteriores
            onDetections?.(camera.id, lastBoxes)
          } else if (!cancelled) {
            // DIAG: frame_pump respondeu mas sem detections (vazio/erro silencioso ou timeout)
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
        // DIAG: erros silenciosos
        pumpingRef.current = false
        const now = Date.now()
        if (now - lastWarnTime >= WARN_MIN_INTERVAL_MS) {
          lastWarnTime = now
          console.warn(`[vision-diag][${camera.id}] pump erro:`, err instanceof Error ? err.message : String(err))
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
  }, [camera.id, isActive])

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
      draggable={!isEditingZone}
      onDragStart={(e) => onDragStart?.(e, index)}
      onDragOver={(e) => onDragOver?.(e, index)}
      onDragLeave={(e) => onDragLeave?.(e)}
      onDrop={(e) => onDrop?.(e, index)}
      onDragEnd={(e) => onDragEnd?.(e)}
      className="flex flex-col min-w-0 h-full"
    >
      {/* Outside Top Left: Camera Name + Monitors count in gray */}
      <div className="flex items-center justify-between gap-2 px-1 mb-1.5 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-semibold text-text-muted truncate" title={camera.name}>
            {formatCameraName(camera.name, camera.source)}
          </span>
          {camera.monitors > 0 ? (
            <span className="text-[10px] font-medium text-text-muted/80 bg-input/60 rounded-full px-1.5 py-0.5 shrink-0">
              {camera.monitors} mon
            </span>
          ) : null}
        </div>
      </div>

      <div
        className={`flex flex-col h-full rounded-2xl bg-card border overflow-hidden shadow-md transition-all ${isDragging
          ? 'opacity-40 scale-95 border-emerald-500/50'
          : isDragOver
            ? 'border-2 border-emerald-400 bg-emerald-500/10 shadow-emerald-500/20 scale-[1.02]'
            : 'border-border/30 hover:border-border/60'
          }`}
      >
        <div className="relative w-full aspect-video bg-input/40 rounded-t-2xl overflow-hidden shrink-0" style={{ aspectRatio: '16 / 9' }}>
          <canvas
            ref={frameCanvasRef}
            className={`absolute inset-0 w-full h-full object-cover ${hasFrame ? 'block' : 'opacity-0'}`}
          />
          {!hasFrame && (
            <div className="absolute inset-0 w-full h-full flex flex-col items-center justify-center text-xs text-text-muted bg-input/60 p-3 text-center gap-1">
              <VisionBlinkStyleTag />
              <span className="vision-eye-blink">
                <VisionIcon className="w-5 h-5 text-text-muted" />
              </span>
              <span className="font-medium leading-none">{cameraPlaceholderStatus(camera, reloading, error, isSlow, isUnavailable)}</span>
            </div>
          )}
          {/* Bounding boxes — SVG overlay (filtrado por zona) */}
          <SvgBoxOverlay boxes={myDetections} frameDims={frameDimsRef.current} fit="cover" zone={zone} />

          {/* Camada interativa de seleção de área (polígono) */}
          <ZoneOverlay
            zone={zone}
            draftPoints={draftPoints}
            isEditing={isEditingZone}
            frameDims={frameDimsRef.current}
            fit="cover"
            onAddPoint={handleAddDraftPoint}
            onSetPoints={handleSetDraftPoints}
            onSave={handleSaveDraftZone}
            onClear={handleClearDraftZone}
            onCancel={handleCancelDraftZone}
            onUndo={handleUndoDraftPoint}
          />

          {/* FPS real do preview (diagnóstico de desempenho) */}
          {hasFrame && fps > 0 && !isEditingZone ? (
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

          {/* Top Header Bar Inside Card: Zone Pencil, Expand & Close/Remove Buttons */}
          <div className="absolute top-2 right-2 z-20 flex items-center gap-1.5">
            {onToggleEditZone ? (
              <button
                type="button"
                onClick={onToggleEditZone}
                className={`w-6 h-6 rounded-full flex items-center justify-center transition-all shadow-md active:scale-95 hover:scale-105 ${
                  isEditingZone
                    ? 'bg-sky-500 text-white ring-2 ring-sky-400'
                    : 'bg-black/60 hover:bg-black/80 text-white'
                }`}
                title={
                  isEditingZone
                    ? 'Concluir ou cancelar demarcação da área'
                    : zone && zone.length >= 3
                      ? 'Editar área de monitoramento (zona ativa)'
                      : 'Definir área de monitoramento'
                }
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
              </button>
            ) : null}
            {onExpand ? (
              <button
                onClick={() => onExpand(camera)}
                className="w-6 h-6 bg-black/60 hover:bg-black/80 text-white rounded-full flex items-center justify-center transition-all hover:scale-105 active:scale-95 shadow-md"
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
                className="w-6 h-6 bg-black/60 hover:bg-red-500 hover:text-white text-gray-200 rounded-full flex items-center justify-center transition-all hover:scale-105 active:scale-95 shadow-md"
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

      <div className="flex items-center justify-between px-3 py-2 bg-card/95 shrink-0 border-t border-border/30">
        <span className="text-[11px] text-text-muted font-medium px-1 flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${camera.online ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} />
          {camera.source === 'webcam' ? 'Webcam' : 'MJPEG / IP'}
        </span>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Reload: rebuild the camera source when the feed is stuck */}
          <button
            disabled={reloading}
            onClick={() => void handleReloadCamera()}
            className="w-7 h-7 rounded-lg bg-input hover:bg-card border border-border/40 text-text transition-all flex items-center justify-center shadow-md active:scale-95 disabled:opacity-70"
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
            className={`text-[11px] font-medium rounded-lg px-3 py-1.5 transition-all flex items-center gap-1.5 shadow-md active:scale-95 border border-border/40 ${printStatus === 'success'
              ? 'bg-emerald-600 text-white border-transparent'
              : printStatus === 'capturing'
                ? 'bg-input text-text opacity-80'
                : 'bg-input hover:bg-card text-text'
              }`}
          >
            {printStatus === 'success' ? (
              <>
                <svg className={`w-3.5 h-3.5 ${isEditingZone ? "text-sky-400" : "text-white"}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
                Print salvo!
              </>
            ) : printStatus === 'capturing' ? (
              <>
                <svg className="w-3.5 h-3.5 animate-spin text-text" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
    </div>
  )
})

// ---------------------------------------------------------------------------
// Add Camera Card (Striped border button) & Selection Modal
// ---------------------------------------------------------------------------

function AddCameraCard({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <div className="flex flex-col min-w-0 h-full">
      <div className="h-[21px] mb-1.5" />
      <button
        onClick={onClick}
        type="button"
        className="group relative rounded-2xl border border-dashed border-border/50 hover:border-border bg-input/40 hover:bg-input/80 transition-all duration-200 flex flex-col items-center justify-center p-6 text-center overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30 h-full min-h-[168px] cursor-pointer min-w-0 flex-1"
      >
        <div className="w-9 h-9 rounded-xl bg-card border border-border/40 text-text-muted group-hover:text-text flex items-center justify-center mb-3 transition-all duration-200">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </div>
        <span className="text-[13px] font-semibold text-text tracking-tight">
          Adicionar Câmera
        </span>
        <span className="text-[11px] text-text-muted mt-1 leading-snug">
          Webcam ou IP
        </span>
      </button>
    </div>
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
  const isMaximized = useWindowMaximized()
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

  const isValidIpUrl = (url: string): boolean => {
    const u = url.trim()
    if (!u) return false
    return /^(https?:\/\/|rtsp:\/\/).+/i.test(u)
  }

  const hasUnsavedValidIp = hasUnsavedIpInput && isValidIpUrl(ipUrl)
  // Contagem efetiva: inclui o draft ainda não clicado em "Adicionar à seleção"
  // para que 1 clique no rodapé já adicione uma única IP sem passo extra.
  const effectivePendingCount = pendingCount + (hasUnsavedValidIp ? 1 : 0)

  const doConfirm = async (overrideWebcams?: string[], overrideIps?: Array<{ name: string; url: string }>) => {
    const webcamsToAdd = overrideWebcams ?? pendingWebcamIds
    const ipsToAdd = overrideIps ?? pendingIpDrafts
    if (webcamsToAdd.length + ipsToAdd.length === 0) return
    setConfirmUnsaved(false)
    setSubmitting(true)
    setModalError(null)
    try {
      await Promise.race([
        onConfirm(webcamsToAdd, ipsToAdd),
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
    // Se há um IP válido digitado mas ainda não "Adicionado à seleção",
    // inclui automaticamente no confirm — evita o 2º clique + prompt.
    if (hasUnsavedValidIp) {
      const url = ipUrl.trim()
      const id = `ip:${url}`
      if (ipCameras.some((c) => c.id === id)) {
        setModalError('Esta câmera IP já está cadastrada.')
        return
      }
      if (pendingIpDrafts.some((d) => `ip:${d.url}` === id)) {
        setModalError('Esta câmera IP já está na lista de seleção.')
        return
      }
      const nextIps = [...pendingIpDrafts, { name: ipName.trim(), url }]
      await doConfirm(pendingWebcamIds, nextIps)
      return
    }
    if (pendingCount === 0) {
      // Se há texto inválido/incompleto, avisa em vez de silenciar
      if (hasUnsavedIpInput) {
        setModalError('Preencha uma URL válida (http://, https:// ou rtsp://) ou clique em Adicionar à seleção.')
        return
      }
      return
    }
    await doConfirm()
  }

  const webcamOptions: CustomSelectOption[] = webcamCameras
    .filter((cam) => !selectedCameraIds.includes(cam.id) && !pendingWebcamIds.includes(cam.id))
    .map((cam) => ({ value: cam.id, label: formatCameraName(cam.name, cam.source), badge: 'Disponível' }))

  return createPortal(
    <div
      className={`fixed inset-0 top-8 z-[100] animate-fadeIn overflow-y-auto ${
        isMaximized ? 'grid place-items-center p-6 bg-black/60 backdrop-blur-sm' : 'flex flex-col bg-bg'
      }`}
      style={{ top: '32px' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="vision-camera-dialog-title"
        className={`flex flex-col bg-card shadow-2xl overflow-hidden ${
          isMaximized
            ? 'w-full max-w-[720px] max-h-[min(88dvh,680px)] my-6 rounded-2xl border border-border/40'
            : 'w-full h-full max-w-none max-h-none rounded-none border-0 flex-1 min-h-0'
        }`}
      >
          {/* Modal Header */}
          <div className="flex items-center gap-3 px-4 sm:px-6 py-4 border-b border-border/30 shrink-0">
            <button
              onClick={onClose}
              aria-label="Voltar"
              className="w-8 h-8 rounded-full bg-input hover:bg-card border border-border/40 text-text-muted hover:text-text flex items-center justify-center shrink-0 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border/40"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="flex-1 flex items-center justify-center gap-2.5 min-w-0">
              <span className="w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center shrink-0">
                <VisionIcon className="w-3.5 h-3.5 text-emerald-400" />
              </span>
              <h2 id="vision-camera-dialog-title" className="text-[14px] font-semibold text-text tracking-tight">
                Adicionar Câmeras
              </h2>
            </div>
            <span className="w-8 h-8 shrink-0" aria-hidden="true" />
          </div>

          {/* Segmented Control / Tab Switcher */}
          <div role="tablist" className="mx-4 sm:mx-6 p-1 rounded-full bg-input border border-border/40 flex gap-1">
            <button
              type="button"
              role="tab"
              onClick={() => setActiveTab('webcam')}
              aria-selected={activeTab === 'webcam'}
              className={`flex-1 py-2.5 px-4 rounded-full text-[13px] font-medium flex items-center justify-center gap-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-border/40 ${activeTab === 'webcam'
                ? 'bg-card text-text shadow-sm font-semibold border border-border/30'
                : 'text-text-muted hover:text-text hover:bg-card/40'
                }`}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="3.5" />
              </svg>
              Webcam USB
              <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[10px] leading-none font-medium ${activeTab === 'webcam' ? 'bg-input text-text' : 'bg-input/60 text-text-muted'}`}>{webcamCameras.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              onClick={() => setActiveTab('ip')}
              aria-selected={activeTab === 'ip'}
              className={`flex-1 py-2.5 px-4 rounded-full text-[13px] font-medium flex items-center justify-center gap-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-border/40 ${activeTab === 'ip'
                ? 'bg-card text-text shadow-sm font-semibold border border-border/30'
                : 'text-text-muted hover:text-text hover:bg-card/40'
                }`}
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="8.5" />
                <path d="M12 3.5a15 15 0 0 1 3.8 8.5A15 15 0 0 1 12 20.5A15 15 0 0 1 8.2 12 15 15 0 0 1 12 3.5z" />
                <path d="M3.5 12h17" />
              </svg>
              Câmeras IP
              <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[10px] leading-none font-medium ${activeTab === 'ip' ? 'bg-input text-text' : 'bg-input/60 text-text-muted'}`}>{ipCameras.length}</span>
            </button>
          </div>

          <div className={`flex-1 overflow-y-auto custom-scrollbar min-h-0 ${isMaximized ? 'px-6 pt-5 pb-3 grid grid-cols-1 sm:grid-cols-[1.15fr_300px] gap-6' : 'px-6 pt-6 pb-4 space-y-6 max-w-[640px] mx-auto w-full'}`}>
                {/* Tab 1: Webcams USB */}
                {activeTab === 'webcam' && (
                  <div className="animate-fadeIn overflow-visible">
                    <label className="text-[11px] font-medium text-text-muted block mb-2">
                      Webcam disponível
                    </label>

                    {webcamCameras.length === 0 ? (
                      <div className="text-xs text-text-muted border border-dashed border-border/40 rounded-xl px-4 py-6 text-center bg-input/20">
                        Nenhuma webcam USB detectada.
                      </div>
                    ) : webcamOptions.length === 0 ? (
                      <div className="text-xs text-text-muted border border-dashed border-border/40 rounded-xl px-4 py-6 text-center bg-input/20">
                        Todas já estão na seleção.
                      </div>
                    ) : (
                      <div className="relative overflow-visible z-30 max-w-[360px]">
                        <CustomSelect
                          value={selectedWebcamId}
                          onChange={handleSelectWebcam}
                          options={webcamOptions}
                          placeholder="Selecione uma webcam..."
                          size="sm"
                          direction="down"
                          className="w-full"
                        />
                        <p className="text-[11px] text-text-muted mt-2">Selecione para adicionar.</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Tab 2: Câmeras IP */}
                {activeTab === 'ip' && (
                  <div className="animate-fadeIn">
                    <div className="rounded-xl border border-border/40 bg-input/20 p-3 sm:p-4 space-y-3">
                      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.7fr] gap-3">
                        <div>
                          <label htmlFor="vision-ip-name" className="block text-[11px] font-medium text-text-muted mb-1.5">
                            Nome <span className="text-text-muted/60 font-normal">— opcional</span>
                          </label>
                        <input
                          id="vision-ip-name"
                          value={ipName}
                          onChange={(e) => setIpName(e.target.value)}
                          placeholder="Nome da câmera (ex.: Garagem, Entrada)"
                          className="w-full bg-input border border-border/40 rounded-lg px-3 py-2 text-xs text-text placeholder-text-muted/60 focus:outline-none focus:border-border focus:ring-1 focus:ring-accent/20 transition-colors"
                        />
                      </div>
                      <div>
                        <label htmlFor="vision-ip-url" className="block text-[11px] font-medium text-text-muted mb-1.5">
                          URL da câmera
                        </label>
                        <input
                          id="vision-ip-url"
                          value={ipUrl}
                          onChange={(e) => setIpUrl(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && ipUrl.trim()) {
                              e.preventDefault()
                              handleStageIp()
                            }
                          }}
                          placeholder="URL (http://ip:porta/video ou rtsp://user:pass@ip)"
                          className="w-full bg-input border border-border/40 rounded-lg px-3 py-2 text-xs text-text placeholder-text-muted/60 focus:outline-none focus:border-border focus:ring-1 focus:ring-accent/20 transition-colors"
                        />
                      </div>
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="button"
                          disabled={!ipUrl.trim()}
                          onClick={handleStageIp}
                          className="inline-flex items-center gap-1.5 rounded-full bg-input hover:bg-card disabled:opacity-40 disabled:cursor-not-allowed border border-border/40 text-text text-[11px] font-medium px-3.5 py-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border/40"
                        >
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 5v14M5 12h14" />
                          </svg>
                          Adicionar à seleção
                        </button>
                      </div>
                      {hasUnsavedValidIp ? (
                        <p className="text-[11px] text-text-muted text-center">Vai entrar ao confirmar — pode adicionar mais.</p>
                      ) : null}
                    </div>
                  </div>
                )}

            {pendingCount > 0 && (
              <div className="rounded-xl border border-border/40 bg-input/30 overflow-hidden">
                <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border/30">
                  <span className="text-[11px] font-semibold text-text">Revisão</span>
                  <span className="text-[10px] text-text-muted">{pendingCount} {pendingCount === 1 ? 'câmera' : 'câmeras'} · confirmação única</span>
                </div>
                <div className="max-h-[160px] overflow-y-auto custom-scrollbar">
                  <ul className="divide-y divide-border/20">
                    {pendingWebcamIds.map((id) => {
                      const cam = webcamCameras.find((c) => c.id === id)
                      return (
                        <li
                          key={id}
                          className="flex items-center justify-between gap-2 px-2.5 py-1.5"
                        >
                          <span className="text-[11px] text-text truncate flex items-center gap-2 min-w-0">
                            <span className="w-6 h-6 rounded-full bg-input border border-border/30 flex items-center justify-center shrink-0">
                              <svg className="w-3 h-3 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                                <circle cx="12" cy="13" r="3" />
                              </svg>
                            </span>
                            <span className="truncate">{cam?.name || id}</span>
                          </span>
                          <button
                            type="button"
                            onClick={() => removePendingWebcam(id)}
                            aria-label={`Remover ${cam?.name || id} da seleção`}
                            className="w-6 h-6 rounded-full bg-input hover:bg-card border border-border/40 text-text-muted hover:text-red-400 flex items-center justify-center shrink-0 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border/40"
                          >
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                              <path d="M18 6L6 18M6 6l12 12" />
                            </svg>
                          </button>
                        </li>
                      )
                    })}
                    {pendingIpDrafts.map((draft, i) => (
                      <li
                        key={`ip-${draft.url}-${i}`}
                        className="flex items-center justify-between gap-2 px-3 py-2"
                      >
                        <span className="text-[11px] text-text truncate flex items-center gap-2 min-w-0">
                          <span className="w-6 h-6 rounded-full bg-input border border-border/30 flex items-center justify-center shrink-0">
                            <svg className="w-3 h-3 text-text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                              <circle cx="12" cy="12" r="7.5" />
                              <path d="M12 4a15 15 0 0 1 3.2 8A15 15 0 0 1 12 20A15 15 0 0 1 8.8 12 15 15 0 0 1 12 4z" />
                              <path d="M4.5 12h15" />
                            </svg>
                          </span>
                          <span className="truncate">{draft.name || draft.url}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => removePendingIp(i)}
                          aria-label={`Remover ${draft.name || draft.url} da seleção`}
                          className="w-6 h-6 rounded-full bg-input hover:bg-card border border-border/40 text-text-muted hover:text-red-400 flex items-center justify-center shrink-0 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border/40"
                        >
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        </button>
                      </li>
                    ))}
                  </ul>
                  </div>
                </div>
            )}
          </div>

          {/* Modal Footer */}
          <div className="shrink-0 px-4 sm:px-6 py-3 sm:py-4 border-t border-border/30 bg-card flex flex-col gap-2 sm:gap-3">
            {modalError ? (
              <p className="w-full text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2.5 text-left leading-relaxed">
                {modalError}
              </p>
            ) : null}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-full bg-input hover:bg-card border border-border/40 text-text-muted hover:text-text px-4 py-2 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border/40"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={submitting || effectivePendingCount === 0}
                onClick={() => void handleConfirm()}
                className={`rounded-full px-4 py-2 text-[11px] font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-border/40 border ${effectivePendingCount === 0
                  ? 'bg-input/40 border-border/20 text-text-muted/40 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-500 border-transparent text-white shadow-md'
                  }`}
              >
                {submitting
                  ? 'Adicionando...'
                  : effectivePendingCount === 0
                    ? 'Nenhuma câmera selecionada'
                    : `Adicionar ${effectivePendingCount === 1 ? '1 câmera' : `${effectivePendingCount} câmeras`}`}
              </button>
            </div>
          </div>
        </div>
    </div>,
    document.body
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
  mode = 'balanced',
  zone,
  isEditingZone = false,
  onToggleEditZone,
  onSaveZone,
  onClearZone
}: {
  camera: CameraInfo | null
  detections: Record<string, Detection[]>
  onClose: () => void
  onSnapshot: (cameraId: string) => Promise<void> | void
  onDetections?: (cameraId: string, boxes: Detection[]) => void
  mode?: 'fluid' | 'balanced' | 'economy'
  zone?: Point[] | null
  isEditingZone?: boolean
  onToggleEditZone?: () => void
  onSaveZone?: (points: Point[]) => void
  onClearZone?: () => void
}): JSX.Element | null {
  const frameCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameBoxRef = useRef<HTMLDivElement | null>(null)
  const [draftPoints, setDraftPoints] = useState<Point[]>([])

  useEffect(() => {
    if (isEditingZone) {
      setDraftPoints(zone && zone.length >= 3 ? [...zone] : [])
    }
  }, [isEditingZone, zone])

  const handleAddDraftPoint = useCallback((pt: Point) => {
    setDraftPoints((prev) => {
      const next = [...prev, pt]
      return next.length >= 3 ? orderPointsClockwise(next) : next
    })
  }, [])

  const handleSetDraftPoints = useCallback((pts: Point[]) => {
    setDraftPoints(pts)
  }, [])

  const handleUndoDraftPoint = useCallback(() => {
    setDraftPoints((prev) => prev.slice(0, -1))
  }, [])

  const handleSaveDraftZone = useCallback(() => {
    if (draftPoints.length >= 3 && onSaveZone) {
      onSaveZone(draftPoints)
    }
  }, [draftPoints, onSaveZone])

  const handleClearDraftZone = useCallback(() => {
    setDraftPoints([])
    onClearZone?.()
  }, [onClearZone])

  const handleCancelDraftZone = useCallback(() => {
    setDraftPoints([])
    onToggleEditZone?.()
  }, [onToggleEditZone])

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
            jpegBase64 = await canvasToBase64(tempCanvas, 0.7)
          }
        } else if (frameCanvasRef.current && (frameDimsRef.current.w > 0 && frameDimsRef.current.h > 0)) {
          const c = frameCanvasRef.current
          const cw = frameDimsRef.current.w || c.width || 640
          const ch = frameDimsRef.current.h || c.height || 360
          const tempCanvas = document.createElement('canvas')
          const scale = Math.min(640 / cw, 360 / ch, 1)
          tempCanvas.width = Math.max(1, Math.round(cw * scale))
          tempCanvas.height = Math.max(1, Math.round(ch * scale))
          const ctx = tempCanvas.getContext('2d')
          if (ctx) {
            ctx.drawImage(c, 0, 0, tempCanvas.width, tempCanvas.height)
            jpegBase64 = await canvasToBase64(tempCanvas, 0.7)
          }
        } else {
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
        if (!jpegBase64) {
          pumpingRef.current = false
          return
        }
        pumpingRef.current = true
        const request = command<{ detections?: Detection[]; stale?: boolean }>('frame_pump', { cameraId: camera.id, jpegBase64 })
        void request.finally(() => { pumpingRef.current = false })
        const res = await Promise.race([
          request,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), PUMP_COMMAND_TIMEOUT_MS))
        ])
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
    const stagger = (hashCode(camera.id) % 3) * (PUMP_INTERVAL_MS / 3)
    const t0 = setTimeout(() => void run(), stagger)
    const timer = window.setInterval(() => void run(), PUMP_INTERVAL_MS)
    return () => {
      clearTimeout(t0)
      clearInterval(timer)
    }
  }, [camera, onDetections])

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const isWebcam = Boolean(camera?.source === 'webcam' || camera?.id.startsWith('webcam:'))

  // Preview unificado (webcam e IP via MJPEG stream do node-core) — 1 getUserMedia só na hidden window.
  // Removido getUserMedia local duplicado que causava `Failed to reserve buffer` quando IP era adicionada.
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
      if (frameCanvas.width !== bitmap.width) frameCanvas.width = bitmap.width
      if (frameCanvas.height !== bitmap.height) frameCanvas.height = bitmap.height
      ctx.drawImage(bitmap, 0, 0)
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

    const parser = createParserWorker({
      onBitmap: (bitmap) => {
        if (cancelled) {
          bitmap.close()
          return
        }
        drawToCanvas(bitmap)
        bitmap.close()
      },
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
      }, 8000)
      return () => {
        clearTimeout(fallbackTimer)
        cancelled = true
        ac.abort()
        parser.dispose()
        parserWorkerRef.current = null
      }
    }

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
    <div className="fixed inset-0 z-50 bg-bg overflow-hidden flex flex-col animate-fadeIn">
      <div className="h-full flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border/40 bg-card/85 backdrop-blur-md shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${camera.online ? 'bg-emerald-400' : 'bg-red-500'}`} />
            <h2 className="text-base font-bold text-text truncate">{formatCameraName(camera.name, camera.source)}</h2>
            <span className="text-xs text-text-muted shrink-0">({isWebcam ? 'Webcam' : 'IP / RTSP'})</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onToggleEditZone ? (
              <button
                type="button"
                onClick={onToggleEditZone}
                className={`text-xs font-semibold rounded-lg px-3 py-1.5 transition-all flex items-center gap-1.5 shadow-sm active:scale-95 border ${
                  isEditingZone
                    ? 'bg-sky-500 text-white border-sky-400 ring-2 ring-sky-400/40'
                    : 'bg-input hover:bg-card border-border/50 text-text'
                }`}
                title={
                  isEditingZone
                    ? 'Concluir ou cancelar demarcação da área'
                    : zone && zone.length >= 3
                      ? 'Editar área de monitoramento (zona ativa)'
                      : 'Definir área de monitoramento'
                }
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
                <span>{isEditingZone ? 'Editando área...' : zone && zone.length >= 3 ? 'Área ativa' : 'Definir área'}</span>
              </button>
            ) : null}
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
              className="text-text-muted hover:text-text rounded-lg p-1.5 hover:bg-input transition-colors"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div ref={frameBoxRef} className="flex-1 min-h-0 relative bg-bg overflow-hidden flex items-center justify-center">
          <canvas
            ref={frameCanvasRef}
            className="w-full h-full object-contain"
          />

          {/* Bounding boxes — SVG overlay with object-contain letterbox (filtrado por zona) */}
          <SvgBoxOverlay boxes={myDetections} frameDims={frameDimsRef.current} fit="contain" zone={zone} />

          {/* Camada interativa de seleção de área (polígono) */}
          <ZoneOverlay
            zone={zone}
            draftPoints={draftPoints}
            isEditing={isEditingZone}
            frameDims={frameDimsRef.current}
            fit="contain"
            onAddPoint={handleAddDraftPoint}
            onSetPoints={handleSetDraftPoints}
            onSave={handleSaveDraftZone}
            onClear={handleClearDraftZone}
            onCancel={handleCancelDraftZone}
            onUndo={handleUndoDraftPoint}
          />

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
            {formatCameraName(alert.cameraName, 'webcam') || 'Câmera'}
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
      if (
        !t.type ||
        t.type === 'momai-vision.vision_alert' ||
        t.type === 'vision_alert' ||
        t.type === 'vision:detection'
      ) {
        return ''
      }
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
    if (['motion', 'object', 'person', 'animal', 'presence', 'absence'].includes(firstTrigger.type || '')) {
      return firstTrigger.type
    }
    return 'motion'
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
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="vision-edit-monitor-title"
        className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/75 backdrop-blur-sm animate-fadeIn overflow-y-auto"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
      >
        <div
          className="w-full max-w-xl bg-card border border-border/50 rounded-2xl shadow-2xl flex flex-col max-h-[min(88dvh,720px)] overflow-hidden my-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-border/40 bg-sidebar shrink-0">
            <h2 id="vision-edit-monitor-title" className="text-sm font-bold text-text flex items-center gap-2.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
              <span className="truncate">{initialMonitor ? 'Editar Monitoramento' : 'Novo Monitoramento'}</span>
            </h2>
            <button
              type="button"
              onClick={onClose}
              className="text-text-muted hover:text-text rounded-lg p-1.5 hover:bg-input/60 transition-colors shrink-0"
              aria-label="Fechar"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <form onSubmit={handleSubmit} className="px-5 py-6 sm:px-8 space-y-6 overflow-y-auto custom-scrollbar flex-1">
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
                  {cameraId && !cameras.some((c) => c.id === cameraId) && (
                    <option key={cameraId} value={cameraId}>
                      {formatCameraName(initialMonitor?.cameraName || cameraId, 'webcam')} (Câmera do Monitoramento)
                    </option>
                  )}
                  {cameras.map((cam) => (
                    <option key={cam.id} value={cam.id}>
                      {formatCameraName(cam.name, cam.source)} ({cam.source === 'webcam' ? 'Webcam' : 'IP'})
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
  const applyDetections = useCallback((cameraId: string, boxes: Detection[]) => {
    const now = Date.now()
    const prevTs = detLastTs.current[cameraId] || 0
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
  const [confirmClearPrints, setConfirmClearPrints] = useState(false)
  const [confirmClearAlerts, setConfirmClearAlerts] = useState(false)
  const [editingZoneCameraId, setEditingZoneCameraId] = useState<string | null>(null)

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
  // Timestamp da última alteração de seleção feita pelo usuário na tela.
  // Evita que um list_cameras que já estava em trânsito no backend com o
  // selectedCameras antigo reverta a exclusão ou adição do card.
  const lastSelectionChangeAtRef = useRef(0)
  const pollInFlightRef = useRef(false)
  const poll = useCallback(async () => {
    if (pollInFlightRef.current) return
    pollInFlightRef.current = true
    try {
      const [camRes, statusRes, alertsRes, activeTriggersRes] = await Promise.all([
        command<{ cameras: CameraInfo[]; selectedCameras?: string[] | null }>('list_cameras'),
        command<{ monitors: MonitorInfo[]; detectionZones?: Record<string, Point[]> }>('get_status'),
        command<{ alerts: Alert[] }>('list_alerts').catch(() => null),
        fetchActiveAutomationTriggers()
      ])
      if (statusRes?.detectionZones) {
        setConfig((prev) => ({ ...prev, detectionZones: statusRes.detectionZones }))
      }
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
          const cam = rawCam
            ? fetchedCams.find(
                (c) =>
                  c.id === rawCam ||
                  c.name === rawCam ||
                  (rawCam.length >= 3 &&
                    (c.id.toLowerCase().includes(rawCam.toLowerCase()) ||
                      c.name.toLowerCase().includes(rawCam.toLowerCase())))
              )
            : null
          const camId = cam ? cam.id : (rawCam || fetchedCams[0]?.id || 'webcam:0')
          const camName = cam ? cam.name : (rawCam || camId)
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
        // Só aceita o selectedCameras do backend se não houver mutação recente pendente
        if (Date.now() - lastSelectionChangeAtRef.current > 3000) {
          setConfig((prev) => {
            const next = { ...prev, selectedCameras: sel }
            if (typeof localStorage !== 'undefined') {
              localStorage.setItem(`${EXT_ID}:config`, JSON.stringify(next))
            }
            return next
          })
        }
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
    setConfirmClearPrints(false)
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
    setConfirmClearAlerts(false)
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

  const handleDeleteAlert = useCallback(
    async (alert: Alert) => {
      const key = alertKey(alert)
      setAlerts((prev) => prev.filter((a) => alertKey(a) !== key))
      try {
        await command('delete_alert', { alertId: key, ts: alert.ts, cameraId: alert.cameraId })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    []
  )

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

  const handleToggleEditZone = useCallback((cameraId: string) => {
    setEditingZoneCameraId((prev) => (prev === cameraId ? null : cameraId))
  }, [])

  const handleSaveCameraZone = useCallback(
    async (cameraId: string, points: Point[]) => {
      const current = config.detectionZones || {}
      const updated = { ...current, [cameraId]: points }
      await saveSettings({ detectionZones: updated })
      setEditingZoneCameraId(null)
    },
    [config.detectionZones, saveSettings]
  )

  const handleClearCameraZone = useCallback(
    async (cameraId: string) => {
      const current = { ...(config.detectionZones || {}) }
      delete current[cameraId]
      await saveSettings({ detectionZones: current })
      setEditingZoneCameraId(null)
    },
    [config.detectionZones, saveSettings]
  )

  const toggleCameraSelection = useCallback(
    async (cameraId: string) => {
      lastSelectionChangeAtRef.current = Date.now()
      const currentSelected = config.selectedCameras ?? []
      const isRemoving = currentSelected.includes(cameraId)
      const nextSelected = isRemoving
        ? currentSelected.filter((id) => id !== cameraId)
        : [...currentSelected, cameraId]

      // Atualização otimista imediata na UI
      setConfig((prev) => {
        const next = { ...prev, selectedCameras: nextSelected }
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(`${EXT_ID}:config`, JSON.stringify(next))
        }
        return next
      })

      // Se for remoção de câmera IP, remove também da lista de câmeras da tela imediatamente
      if (cameraId.startsWith('ip:')) {
        setCameras((prev) => prev.filter((c) => c.id !== cameraId))
        delete knownCamerasRef.current[cameraId]
      }

      // Se a câmera foi fechada/removida, pausa automaticamente os monitoramentos ativos associados a ela
      if (isRemoving) {
        const targetCam = cameras.find((c) => c.id === cameraId)
        const camName = targetCam?.name || cameraId
        const monitorsToPause = monitors.filter(
          (m) =>
            !m.paused &&
            (m.cameraId === cameraId ||
              m.cameraName === camName ||
              m.cameraName === cameraId ||
              m.cameraId === camName)
        )

        if (monitorsToPause.length > 0) {
          setMonitors((prev) =>
            prev.map((m) =>
              monitorsToPause.some((p) => p.id === m.id) ? { ...m, paused: true } : m
            )
          )
          for (const m of monitorsToPause) {
            void command('pause_monitoring', { monitorId: m.id }).catch(() => {})
          }
        }
      }

      try {
        const isRemovingIp = cameraId.startsWith('ip:') && isRemoving
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
    [config.selectedCameras, cameras, monitors]
  )

  const handleRemoveCamera = useCallback(
    (id: string) => {
      void toggleCameraSelection(id)
    },
    [toggleCameraSelection]
  )

  const handleExpandCamera = useCallback((cam: CameraInfo) => {
    setExpandedCamera(cam)
  }, [])

  const handleReloadCamera = useCallback(() => {
    void poll()
  }, [poll])

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
      lastSelectionChangeAtRef.current = Date.now()
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
            : { id, name: 'Câmera', source: id.startsWith('ip:') ? 'ip' : 'webcam', online: false, monitors: 0 }
        )
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

  const tabClass = (tab: string) =>
    `px-3.5 py-1.5 text-xs font-medium rounded-full transition-all ${activeTab === tab
      ? 'bg-emerald-600 text-white shadow-md'
      : 'bg-input text-text-muted hover:text-text hover:bg-card border border-border/30'
    }`

  return (
    <div className="relative w-full h-full min-h-screen max-h-screen overflow-y-auto p-4 md:p-6 text-text space-y-5 custom-scrollbar">
      <header className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2 text-text">
            <span className="text-emerald-400">
              <VisionIcon />
            </span>{' '}
            MomAI Vision
          </h1>
          <p className="text-xs text-text-muted mt-0.5">
            Visão e monitoramento 100% locais — nada sai da sua máquina.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">
            {activeMonitors.length} monitor{activeMonitors.length !== 1 ? 'es' : ''} ativo{activeMonitors.length !== 1 ? 's' : ''}
            {pausedMonitors.length > 0
              ? ` · ${pausedMonitors.length} pausado${pausedMonitors.length !== 1 ? 's' : ''}`
              : ''}
          </span>
          <button
            disabled={isRefreshing}
            onClick={() => void refresh()}
            className="text-xs rounded-lg bg-input hover:bg-card border border-border/40 text-text-muted hover:text-text px-3 py-1.5 transition-all flex items-center gap-1.5 active:scale-95 disabled:opacity-60"
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
                boxes={detections[camera.id] || EMPTY_DETECTIONS}
                zone={config.detectionZones?.[camera.id]}
                isEditingZone={editingZoneCameraId === camera.id}
                onToggleEditZone={() => handleToggleEditZone(camera.id)}
                onSaveZone={(points) => void handleSaveCameraZone(camera.id, points)}
                onClearZone={() => void handleClearCameraZone(camera.id)}
                onDetections={handleDetections}
                onSnapshot={takeSnapshot}
                onRemove={handleRemoveCamera}
                onExpand={handleExpandCamera}
                onReload={handleReloadCamera}
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
                hasMonitor={monitors.some((m) => m.cameraId === camera.id && !m.paused)}
                suppressPump={expandedCamera?.id === camera.id}
              />
            ))}
            <AddCameraCard onClick={() => setIsModalOpen(true)} />
          </div>

{!expandedCamera && (
          <div className="mt-8 pt-4">
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_10px_rgba(52,211,153,0.5)]" />
              <h3 className="text-lg font-bold text-text tracking-tight">
                Monitoramento Ativo
              </h3>
              {monitors.length > 0 && (
                <span className="text-xs text-text-muted font-medium">
                  ({activeMonitors.length})
                </span>
              )}
            </div>

            {monitors.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/50 bg-card p-8 flex flex-col items-center justify-center text-center gap-3 shadow-sm">
                <div className="w-12 h-12 rounded-2xl bg-input/60 border border-border/40 flex items-center justify-center text-emerald-400">
                  <VisionIcon className="w-6 h-6" />
                </div>
                <div className="space-y-1">
                  <h4 className="text-sm font-semibold text-text">Nenhum monitoramento configurado</h4>
                  <p className="text-xs text-text-muted max-w-sm">
                    Configure monitoramentos inteligentes para receber alertas de movimento, pessoas ou objetos.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const evt = new CustomEvent('momai:open_automation_modal', {
                      detail: { triggerProvider: 'momai-vision' }
                    })
                    window.dispatchEvent(evt)
                    if (window.parent && window.parent !== window) {
                      window.parent.dispatchEvent(evt)
                    }
                  }}
                  className="mt-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl px-4 py-2.5 transition-all shadow-md flex items-center gap-2 active:scale-95 cursor-pointer"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  <span>Adicionar Monitoramento</span>
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3">
                  {activeMonitors.map((m) => {
                    const formattedTriggers = m.triggers.map(formatTriggerPortuguese).filter(Boolean)
                    return (
                      <div
                        key={m.id}
                        className="flex items-center justify-between p-4 gap-4 rounded-xl bg-card border border-border/40 shadow-sm hover:border-border transition-all"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-text truncate">
                              {m.label || m.cameraName || m.cameraId}
                            </span>
                            {m.cameraName && m.label && (
                              <span className="text-xs text-text-muted font-normal">
                                · {formatCameraName(m.cameraName, 'webcam')}
                              </span>
                            )}
                          </div>
                          {(formattedTriggers.length > 0 || m.cooldownSec) && (
                            <p className="text-xs text-text-muted mt-1">
                              {formattedTriggers.join(' · ')}
                              {m.cooldownSec ? `${formattedTriggers.length > 0 ? ' · ' : ''}Cooldown: ${m.cooldownSec}s` : ''}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => {
                              setEditingMonitor(m)
                              setIsMonitorModalOpen(true)
                            }}
                            className="text-xs font-medium text-text-muted hover:text-text px-2.5 py-1.5 rounded-lg bg-input hover:bg-card border border-border/30 transition-all"
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
                            className="text-xs font-medium text-amber-400 hover:text-amber-300 px-2.5 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 transition-all"
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
                            className="text-xs text-red-400 hover:text-red-300 p-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 transition-all"
                          >
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                              <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2 2v2" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    )
                  })}

                  {/* Card Tracejado para Adicionar Monitoramento Abaixo */}
                  <button
                    type="button"
                    onClick={() => {
                      const evt = new CustomEvent('momai:open_automation_modal', {
                        detail: { triggerProvider: 'momai-vision' }
                      })
                      window.dispatchEvent(evt)
                      if (window.parent && window.parent !== window) {
                        window.parent.dispatchEvent(evt)
                      }
                    }}
                    className="group flex items-center justify-center gap-2 p-3.5 rounded-xl border border-dashed border-border/50 hover:border-emerald-500/50 bg-input/20 hover:bg-input/50 transition-all duration-200 cursor-pointer text-text-muted hover:text-text"
                  >
                    <div className="w-6 h-6 rounded-lg bg-card border border-border/40 text-emerald-400 flex items-center justify-center group-hover:scale-105 transition-transform">
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                    </div>
                    <span className="text-xs font-semibold">Adicionar Monitoramento</span>
                  </button>
                </div>

                {pausedMonitors.length > 0 && (
                  <div className="pt-4 border-t border-border/20">
                    <h4 className="text-xs font-semibold text-text-muted mb-2.5 uppercase tracking-wider">
                      Pausados ({pausedMonitors.length})
                    </h4>
                    <div className="grid grid-cols-1 gap-2.5 opacity-80">
                      {pausedMonitors.map((m) => {
                        const formattedTriggers = m.triggers.map(formatTriggerPortuguese).filter(Boolean)
                        return (
                          <div
                            key={m.id}
                            className="flex items-center justify-between p-3.5 gap-4 rounded-xl bg-card/60 border border-border/30"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-text truncate">
                                  {m.label || m.cameraName || m.cameraId}
                                </span>
                                {m.cameraName && m.label && (
                                  <span className="text-xs text-text-muted">
                                    · {formatCameraName(m.cameraName, 'webcam')}
                                  </span>
                                )}
                              </div>
                              {formattedTriggers.length > 0 && (
                                <p className="text-xs text-text-muted mt-0.5">
                                  {formattedTriggers.join(' · ')}
                                </p>
                              )}
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
                                className="text-xs font-medium text-emerald-400 hover:text-emerald-300 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 transition-all"
                              >
                                Retomar
                              </button>
                              <button
                                onClick={() => {
                                  setEditingMonitor(m)
                                  setIsMonitorModalOpen(true)
                                }}
                                className="text-xs font-medium text-text-muted hover:text-text px-2.5 py-1.5 rounded-lg bg-input hover:bg-card border border-border/30 transition-all"
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
                                className="text-xs text-red-400 hover:text-red-300 p-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 transition-all"
                              >
                                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                  <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2 2v2" />
                                </svg>
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          )}
        </section>
      ) : null}

      {/* Tab: Alerts Feed */}
      {activeTab === 'alerts' ? (
        <section className="space-y-3">
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-sm font-semibold text-text">Histórico de Alertas</h3>
            {alerts.length > 0 ? (
              confirmClearAlerts ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-red-400 font-medium">Limpar todos os alertas?</span>
                  <button
                    onClick={() => void handleClearAlerts()}
                    className="text-xs px-2.5 py-1 rounded-lg bg-red-600 text-white font-medium hover:bg-red-500 transition-colors shadow-sm"
                  >
                    Sim, limpar
                  </button>
                  <button
                    onClick={() => setConfirmClearAlerts(false)}
                    className="text-xs px-2.5 py-1 rounded-lg bg-card text-text-muted hover:text-text border border-border/40 transition-colors"
                  >
                    Cancelar
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmClearAlerts(true)}
                  className="text-xs text-red-400/80 hover:text-red-300 transition-colors flex items-center gap-1"
                >
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                  limpar alertas
                </button>
              )
            ) : null}
          </div>
          {alerts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/40 bg-card/30 p-8 text-center text-sm text-text-muted">
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
                  className="flex gap-3.5 items-center justify-between rounded-2xl border border-border/40 bg-card p-3.5 hover:border-border/80 transition-all shadow-md"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-text truncate max-w-[70%]">
                        {formatCameraName(alert.cameraName, 'webcam') || 'Câmera'}
                        {alert.className ? ` · ${ptLabel(alert.className)}` : ''}
                        {alert.confidence ? ` ${Math.round(alert.confidence * 100)}%` : ''}
                      </p>
                      {alert.ts ? (
                        <span className="text-[11px] text-text-muted font-medium shrink-0 bg-input px-2 py-0.5 rounded-md border border-border/30">
                          {formatTime(alert.ts)}
                        </span>
                      ) : null}
                    </div>
                    {alert.description || alert.triggeredBy ? (
                      <p className="text-xs text-text-muted mt-1">
                        {alert.description ? `${alert.description} ` : ''}
                        {alert.triggeredBy ? (
                          <span className="text-text-muted/80">{triggerLabel(alert)}</span>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2.5 shrink-0">
                    {imgSrc ? (
                      <div
                        className="group relative w-32 h-20 rounded-xl bg-black shrink-0 overflow-hidden cursor-pointer border border-border/40 hover:border-emerald-500/60 transition-all shadow-sm"
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
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleDeleteAlert(alert)
                      }}
                      title="Excluir este alerta"
                      className="p-1.5 text-text-muted hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors shrink-0"
                    >
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
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
            <h3 className="text-sm font-semibold text-text">Prints da Câmera</h3>
            <div className="flex items-center gap-3">
              <button onClick={() => void refreshGallery()} className="text-xs text-text-muted hover:text-text transition-colors">
                atualizar
              </button>
              {snapshots.length > 0 ? (
                confirmClearPrints ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-red-400 font-medium">Excluir todos os prints?</span>
                    <button
                      onClick={() => void handleClearAllPrints()}
                      className="text-xs px-2.5 py-1 rounded-lg bg-red-600 text-white font-medium hover:bg-red-500 transition-colors shadow-sm"
                    >
                      Sim, excluir
                    </button>
                    <button
                      onClick={() => setConfirmClearPrints(false)}
                      className="text-xs px-2.5 py-1 rounded-lg bg-card text-text-muted hover:text-text border border-border/40 transition-colors"
                    >
                      Cancelar
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmClearPrints(true)}
                    className="text-xs text-red-400/80 hover:text-red-300 transition-colors flex items-center gap-1"
                  >
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                    excluir todos
                  </button>
                )
              ) : null}
            </div>
          </div>
          {snapshots.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/40 bg-card/30 p-8 text-center text-sm text-text-muted">
              Galeria de prints vazia. Print por print, a MomAI monta seu histórico visual.
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 auto-rows-fr">
              {snapshots.map((snap: Snapshot) => (
                <figure
                  key={snap.id}
                  onClick={() => setExpandedPrint(snap)}
                  onContextMenu={(e) => handleContextMenu(e, snap)}
                  className="group rounded-xl overflow-hidden border border-border/40 bg-card cursor-pointer hover:border-emerald-500/50 transition-all shadow-md flex flex-col h-full"
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
                    <p className="text-[11px] text-text font-medium truncate">{snap.description || formatTime(snap.ts)}</p>
                    <div className="flex items-center justify-between mt-1 pt-1 border-t border-border/20">
                      <span className="text-[10px] text-text-muted">{formatTime(snap.ts)}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleDeletePrint(snap.id)
                        }}
                        title="Excluir print"
                        className="p-1 text-text-muted hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
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
            <h2 className="text-lg font-bold text-text flex items-center justify-center gap-2">
              <svg className="w-5 h-5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              Configurações do Vision
            </h2>
            <p className="text-xs text-text-muted mt-1">
              Ajuste suas preferências de câmeras, retenção de prints e modos de rastreamento local.
            </p>
          </div>

          <div className="rounded-2xl border border-border/40 bg-card backdrop-blur-md p-6 shadow-xl space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-text flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                Retenção de Prints
              </h3>
              <p className="text-xs text-text-muted mt-0.5">
                Defina o limite de armazenamento local para galeria de prints e histórico.
              </p>
            </div>
            <div className="space-y-3">
              <label className="flex items-center justify-between text-xs text-text bg-input/50 p-3 rounded-xl border border-border/30">
                <span>Dias de armazenamento (padrão: 7)</span>
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={config.retentionDays ?? 7}
                  onChange={(e) => void saveSettings({ retentionDays: Number(e.target.value) || 7 })}
                  className="w-20 bg-input border border-border/40 rounded-lg px-2.5 py-1.5 text-sm text-right text-text focus:outline-none focus:border-emerald-500"
                />
              </label>
              <label className="flex items-center justify-between text-xs text-text bg-input/50 p-3 rounded-xl border border-border/30">
                <span>Máximo de arquivos armazenados (padrão: 200)</span>
                <input
                  type="number"
                  min={20}
                  max={1000}
                  value={config.maxSnapshots ?? 200}
                  onChange={(e) => void saveSettings({ maxSnapshots: Number(e.target.value) || 200 })}
                  className="w-20 bg-input border border-border/40 rounded-lg px-2.5 py-1.5 text-sm text-right text-text focus:outline-none focus:border-emerald-500"
                />
              </label>
            </div>
            <p className="text-[11px] text-text-muted">
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
        onClose={() => {
          setExpandedCamera(null)
          setEditingZoneCameraId(null)
        }}
        onSnapshot={takeSnapshot}
        mode={config.trackingMode || 'balanced'}
        zone={expandedCamera ? config.detectionZones?.[expandedCamera.id] : null}
        isEditingZone={expandedCamera ? editingZoneCameraId === expandedCamera.id : false}
        onToggleEditZone={() => expandedCamera && handleToggleEditZone(expandedCamera.id)}
        onSaveZone={(points) => expandedCamera && void handleSaveCameraZone(expandedCamera.id, points)}
        onClearZone={() => expandedCamera && void handleClearCameraZone(expandedCamera.id)}
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
