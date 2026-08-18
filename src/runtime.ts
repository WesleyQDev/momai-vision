/**
 * MomAI Vision — extension worker runtime.
 *
 * Runs inside the extension host sandbox (persistent worker, reset:false).
 * Owns: camera sources (webcam via host bridge, IP/MJPEG via fetch), the CV
 * engine subprocess, the trigger engine, snapshots, alerts and overlays.
 * All camera/detection logic lives HERE — never in the host app.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decode, encode } from 'jpeg-js'
import { MotionGate } from './vision/motion'
import { ptLabel } from './vision/labels'
import { LatestWinsQueue } from './vision/detect-queue'
import { assertCameraUrlSafe, validateCameraUrl } from './vision/camera-url'
import {
  createMonitorState,
  evaluateMonitor,
  applySceneAnswer,
  inSchedule,
  normalizeClassName,
  type MonitorConfig,
  type MonitorState,
  type MonitorAction,
  type Trigger,
  type Detection,
  type SceneAnswer
} from './vision/triggers'

const SKILL_ID = process.env.MOMAI_EXTENSION_ID || 'momai-vision'
// A porta padrão do node-core do host é 8050 (não 8000).
const API_URL = process.env.MOMAI_API_URL || 'http://127.0.0.1:8050'
const SESSION_TOKEN = process.env.MOMAI_SESSION_TOKEN || ''
// Engine lives in cv/ next to runtime.js (installed layout) or in dist/cv/
// (repo layout mirrored by build for the .dev junction workflow).
const workerDir = path.dirname(fileURLToPath(import.meta.url))
const ENGINE_DIR = path.join(workerDir, 'cv', 'engine.cjs')
const ENGINE_DIR_FALLBACK = path.join(workerDir, 'dist', 'cv', 'engine.cjs')

interface MomaiBridge {
  log: (msg: string) => void
  sendEvent: (eventType: string, data: unknown) => void
  sendStructuredResponse: (data: unknown) => void
  storage: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
  }
  loadAsset: (relativePath: string) => Promise<{ bytes: Uint8Array; text: string }>
  saveFile: (relativePath: string, content: Uint8Array | { bytes: Uint8Array } | string) => Promise<{ ok: boolean; path: string }>
}

let bridge: MomaiBridge | null = null

// ---------------------------------------------------------------------------
// Host HTTP API
// ---------------------------------------------------------------------------

async function hostFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-extension-id': SKILL_ID
  }
  if (SESSION_TOKEN) headers['Authorization'] = `Bearer ${SESSION_TOKEN}`
  if (init.headers) {
    Object.assign(headers, init.headers as Record<string, string>)
  }
  return fetch(`${API_URL}${pathname}`, { ...init, headers })
}

async function hostJson<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const res = await hostFetch(pathname, init)
  if (!res.ok) {
    throw new Error(`host request failed: ${pathname} (${res.status})`)
  }
  return (await res.json()) as T
}

// Limita qualquer chamada ao host (fetch/IPC) com um timeout firme. O host
// (node-core → bridge da câmera → hidden window) tem timeouts internos de 30s
// por operação de hardware; esperar isso no worker bloqueia o fluxo de UI
// (ex.: o modal "Adicionar câmera" espera o list_cameras). Com este limite,
// nenhuma chamada ao host segura a resposta de um comando por mais que o
// valor configurado — a operação continua no fundo e converge pelos retries
// do sync (5s) / reconnect, mas nunca mais trava o caller.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

interface CameraEntry {
  id: string
  name: string
  source: 'webcam' | 'ip'
  deviceId?: string
  url?: string
}

const ipCameras: CameraEntry[] = []
let webcamCache: CameraEntry[] = []

interface StoredConfig {
  retentionDays?: number
  maxSnapshots?: number
  trackingMode?: 'fluid' | 'balanced' | 'economy'
  ipCameras?: Array<{ id: string; name: string; url: string }>
  selectedCameras?: string[]
  sendActions?: MonitorAction[]
}

// Cache da config: o bridge.storage.get lê o config.json do DISCO a cada
// chamada. O toolGetFrame chamava loadConfig a cada frame (66ms × N câmeras),
// saturando o worker com I/O de disco e atrasando cada resposta (~2s por
// frame). Agora a leitura real acontece no máximo a cada 2s; o toolConfigure
// invalida o cache para a mudança valer na hora.
let _configCache: StoredConfig | null = null
let _configCacheAt = 0

async function loadConfig(): Promise<StoredConfig> {
  const now = Date.now()
  if (_configCache && now - _configCacheAt < 2000) return _configCache
  const config = ((await bridge!.storage.get('config')) || {}) as StoredConfig
  _configCache = config || {}
  _configCacheAt = now
  return _configCache
}

function invalidateConfigCache(): void {
  _configCacheAt = 0
}

// Serializa read-modify-write do config: toolConfigure, reload_camera e o
// remap de webcam escrevem concorrentemente (poll 5s + ações do usuário); um
// merge ingênuo lê o arquivo antigo e a última gravação vence, perdendo
// campos escritos no meio. A promise chain faz cada escrita ler o estado mais
// recente antes de gravar.
let configWriteChain: Promise<void> = Promise.resolve()

function withConfigWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const result = configWriteChain.then(task, task)
  configWriteChain = result.then(
    () => {},
    () => {}
  )
  return result
}

/** Lê o config atual, aplica `mutator` e persiste (serializado). */
async function updateConfig(mutator: (config: StoredConfig) => void): Promise<StoredConfig> {
  return withConfigWriteLock(async () => {
    const current = ((await bridge!.storage.get('config')) || {}) as StoredConfig
    mutator(current)
    await bridge!.storage.set('config', current)
    invalidateConfigCache()
    return current
  })
}

async function syncIpCameras(): Promise<void> {
  const config = await loadConfig()
  ipCameras.length = 0
  for (const cam of config.ipCameras || []) {
    if (cam && cam.url && typeof cam.url === 'string') {
      ipCameras.push({ id: `ip:${cam.url}`, name: cam.name || 'Câmera IP', source: 'ip', url: cam.url })
    }
  }
}

async function refreshWebcams(): Promise<void> {
  await syncIpCameras()
  // O /media/camera/* valida a permissão contra o registry do host. No boot,
  // o worker pode chamar ANTES do skill ser indexado (403 transitório) —
  // retries com backoff garantem que o cache de webcams seja populado assim
  // que o registry do host estiver pronto.
  // CADA tentativa é limitada (2.5s): o bridge da câmera tem timeout interno
  // de 30s por operação e, sem este limite, o pior caso aqui era 8×30s = 4
  // minutos segurando o boot (restoreMonitors) e os comandos list_cameras.
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const data = await withTimeout(
        hostJson<{ cameras: Array<{ deviceId: string; label: string }> }>('/media/camera/list'),
        2500,
        'camera list'
      )
      if (Array.isArray(data?.cameras)) {
        webcamCache = data.cameras.map((cam) => ({
          id: `webcam:${cam.deviceId}`,
          name: cam.label || 'Webcam',
          source: 'webcam',
          deviceId: cam.deviceId
        }))
        return
      }
    } catch (err) {
      lastErr = err
      if (attempt < 7) {
        const delay = Math.min(2000, 300 * (attempt + 1))
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }
  bridge?.log(`[vision] webcam list failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
  webcamCache = []
}

function listCameras(): CameraEntry[] {
  return [...webcamCache, ...ipCameras]
}

function findCamera(id: string): CameraEntry | undefined {
  if (!id) return undefined
  const cameras = listCameras()
  const direct = cameras.find((c) => c.id === id)
  if (direct) return direct
  const norm = id.trim().toLowerCase()
  return (
    cameras.find((c) => c.name.trim().toLowerCase() === norm) ||
    cameras.find((c) => c.name.trim().toLowerCase().includes(norm))
  )
}

// MJPEG stream client — keeps the latest frame in memory, nothing on disk.
// O frame é guardado como Buffer BINÁRIO; o encode base64 (caro, ~24x/s por
// câmera) só acontece sob demanda quando getCameraFrame() é chamado (ticker
// de monitor 1/s), nunca no caminho quente do stream.
interface StreamEntry {
  controller: AbortController
  latest: Buffer | null
  latestTs: number
  /** Última vez que um consumidor (ticker/get_frame/snapshot) leu o frame. */
  lastConsumerTs: number
}
const mjpegStreams = new Map<string, StreamEntry>()
function parseCameraUrl(rawUrl: string): { urlsToTry: string[]; headers: Record<string, string> } {
  const headers: Record<string, string> = {}
  let urlStr = rawUrl.trim()
  const urlsToTry: string[] = []

  if (urlStr.startsWith('rtsp://')) {
    try {
      const match = urlStr.match(/^rtsp:\/\/(?:([^:@]+):([^@]+)@)?([^:/]+)(?::(\d+))?(.*)$/)
      if (match) {
        const [, user, pass, host, port, path] = match
        const creds = user && pass ? `${user}:${pass}` : ''
        const authPrefix = creds ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : ''
        const baseHost = host
        urlsToTry.push(`http://${authPrefix}${baseHost}:5000/onvif/snapshot`)
        urlsToTry.push(`http://${authPrefix}${baseHost}:8080/video`)
        urlsToTry.push(`http://${authPrefix}${baseHost}:8080/snapshot.jpg`)
        urlsToTry.push(`http://${authPrefix}${baseHost}/snapshot.jpg`)
        urlsToTry.push(`http://${authPrefix}${baseHost}:${port || 554}${path || '/onvif1'}`)
      }
    } catch {}
    if (urlsToTry.length === 0) {
      urlsToTry.push(urlStr.replace(/^rtsp:\/\//, 'http://'))
    }
  } else {
    urlsToTry.push(urlStr)
  }

  return { urlsToTry, headers }
}

const ipInFlight = new Map<string, number>()

function pushIpFrameToHost(cameraId: string, frameData: Buffer | string): void {
  const current = ipInFlight.get(cameraId) || 0
  if (current >= 2) return // descarta frame se pipeline estiver com 2 requisições em voo para manter tempo real
  ipInFlight.set(cameraId, current + 1)

  const buf = Buffer.isBuffer(frameData) ? frameData : Buffer.from(frameData, 'base64')
  hostFetch(`/media/camera/frame/${encodeURIComponent(cameraId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: new Uint8Array(buf)
  })
    .catch(() => {})
    .finally(() => {
      const active = ipInFlight.get(cameraId) || 1
      ipInFlight.set(cameraId, Math.max(0, active - 1))
    })
}

async function startMjpeg(camera: CameraEntry): Promise<void> {
  if (mjpegStreams.has(camera.id)) return
  if (rtspSessions.has(camera.id)) return

  // SSRF: só http/https/rtsp e nunca loopback/link-local/metadata (a
  // validação completa com DNS acontece no toolConfigure; aqui a checagem
  // síncrona pega esquema/literal — configs legadas não validam o stream).
  if (camera.url) {
    const validation = validateCameraUrl(camera.url)
    if (!validation.ok) {
      bridge?.log(`[vision] câmera ${camera.name}: URL bloqueada (${validation.error}) — stream ignorado`)
      return
    }
  }

  if (camera.url && camera.url.startsWith('rtsp://')) {
    await startRtspStream(camera)
    return
  }

  const controller = new AbortController()
  const entry: StreamEntry = {
    controller,
    latest: null,
    latestTs: 0,
    lastConsumerTs: Date.now()
  }
  mjpegStreams.set(camera.id, entry)

  void (async () => {
    try {
      const { urlsToTry } = parseCameraUrl(camera.url!)
      let activeUrl = urlsToTry[0]

      for (const targetUrl of urlsToTry) {
        if (controller.signal.aborted) break
        try {
          let reqUrl = targetUrl
          const reqHeaders: Record<string, string> = {}
          try {
            const parsed = new URL(targetUrl)
            if (parsed.username || parsed.password) {
              const creds = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
              reqHeaders['Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`
              parsed.username = ''
              parsed.password = ''
              reqUrl = parsed.toString()
            }
          } catch {}

          const res = await fetch(reqUrl, { headers: reqHeaders, signal: controller.signal })
          if (!res.ok || !res.body) continue

          const contentType = res.headers.get('content-type') || ''
          
          // Single JPEG snapshot endpoint
          if (contentType.toLowerCase().includes('image/jpeg')) {
            const arrayBuffer = await res.arrayBuffer()
            entry.latest = Buffer.from(arrayBuffer)
            entry.latestTs = Date.now()
            pushIpFrameToHost(camera.id, Buffer.from(arrayBuffer))
            activeUrl = targetUrl

            // Poll snapshot with adaptive throttle for 20-24 fps (42ms = ~24fps).
            while (!controller.signal.aborted) {
              const started = Date.now()
              try {
                const snapRes = await fetch(reqUrl, { headers: reqHeaders, signal: controller.signal })
                if (snapRes.ok) {
                  const buf = await snapRes.arrayBuffer()
                  entry.latest = Buffer.from(buf)
                  entry.latestTs = Date.now()
                  pushIpFrameToHost(camera.id, Buffer.from(buf))
                }
              } catch {}
              if (controller.signal.aborted) break
              const wait = Math.max(0, 42 - (Date.now() - started))
              if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
            }
            return
          }

          // MJPEG Stream binary reader — scans raw Uint8Array chunks for JPEG SOI (0xFFD8) and EOI (0xFFD9)
          // without string decoding (which corrupts non-ASCII binary bytes).
          const reader = res.body.getReader()
          // Constantes fora do loop: recriar o Buffer do SOI/EOI a cada chunk
          // de rede (~24fps × N câmeras) era alocação desnecessária.
          const SOI = Buffer.from([0xff, 0xd8])
          const EOI = Buffer.from([0xff, 0xd9])
          let streamBuf = Buffer.alloc(0)
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) {
              // Buffer.concat aceita Uint8Array direto — o Buffer.from extra
              // copiava o chunk uma vez à toa.
              streamBuf = Buffer.concat([streamBuf, value])
              while (true) {
                const soi = streamBuf.indexOf(SOI)
                if (soi === -1) break
                const eoi = streamBuf.indexOf(EOI, soi + 2)
                if (eoi === -1) break
                const frame = streamBuf.subarray(soi, eoi + 2)
                streamBuf = streamBuf.subarray(eoi + 2)
                // Buffer.from copia o frame: o subarray reteria o ArrayBuffer
                // inteiro do concat (até 5MB) vivo para sempre.
                entry.latest = Buffer.from(frame)
                entry.latestTs = Date.now()
                pushIpFrameToHost(camera.id, frame)
              }
              if (streamBuf.length > 5 * 1024 * 1024) {
                streamBuf = Buffer.alloc(0)
              }
            }
          }
          return
        } catch {
          // try next URL candidate
        }
      }
      // All HTTP fallback URLs failed — if the original URL was rtsp://,
      // try the raw RTSP client with Digest auth + H.265 depacketization.
      if (camera.url && camera.url.startsWith('rtsp://')) {
        mjpegStreams.delete(camera.id) // release slot for startRtspStream
        bridge?.log(`[vision] HTTP fallbacks failed for ${camera.name}, trying raw RTSP…`)
        await startRtspStream(camera)
        return
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        bridge?.log(`[vision] Camera stream ${camera.name} stopped: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      // Only delete if no RTSP session took over
      if (!rtspSessions.has(camera.id)) {
        mjpegStreams.delete(camera.id)
      }
    }
  })()
}

function stopMjpeg(cameraId: string): void {
  const entry = mjpegStreams.get(cameraId)
  if (entry) {
    entry.controller.abort()
    mjpegStreams.delete(cameraId)
  }
  stopRtsp(cameraId)
}

// TTL dos streams MJPEG/RTSP: um stream sem consumidor ativo (monitor ativo,
// câmera selecionada na página ou leitura recente de frame) é derrubado após
// STREAM_TTL_MS. Antes, toolListCameras iniciava stream para TODAS as câmeras
// IP e nenhum caminho os parava sem ticker — leaks de ffmpeg/fetch contínuo
// que consumiam CPU/banda para sempre.
const STREAM_TTL_MS = 60000

async function sweepMjpegStreams(): Promise<void> {
  const now = Date.now()
  const config = await loadConfig().catch(() => ({} as StoredConfig))
  const selected = new Set(config.selectedCameras || [])

  // 1) Câmeras IP com monitor ativo: garante o stream de pé (restart se
  //    morreu — ffmpeg caiu, câmera reiniciou etc.).
  const activeMonitorIds = new Set<string>()
  for (const m of monitors.values()) {
    if (!m.config.paused) activeMonitorIds.add(m.config.cameraId)
  }
  for (const m of autoMonitorsCache) {
    if (!m.config.paused) activeMonitorIds.add(m.config.cameraId)
  }
  for (const cameraId of activeMonitorIds) {
    const cam = findCamera(cameraId)
    if (cam && cam.source === 'ip' && !mjpegStreams.has(cameraId) && !rtspSessions.has(cameraId)) {
      void startMjpeg(cam).catch(() => {})
    }
  }

  // 2) Streams sem consumidor ativo (sem monitor, sem câmera selecionada,
  //    sem leitura recente de frame): derruba após o TTL.
  for (const [id, entry] of [...mjpegStreams]) {
    if (activeMonitorIds.has(id)) continue
    if (selected.has(id)) continue
    const lastActive = Math.max(entry.latestTs, entry.lastConsumerTs || 0)
    if (now - lastActive > STREAM_TTL_MS) {
      bridge?.log(`[vision] stream de ${id} ocioso — encerrando`)
      stopMjpeg(id)
    }
  }
}

// ---------------------------------------------------------------------------
// RTSP client — raw TCP with Digest auth, TCP interleaved RTP, H.265→JPEG
// via FFmpeg. For cameras (e.g. Yoosee/HiChip) that don't expose HTTP
// snapshot endpoints and whose RTSP implementation is too non-standard for
// FFmpeg's own RTSP demuxer.
// ---------------------------------------------------------------------------

interface RtspSession {
  ffmpeg: import('node:child_process').ChildProcess | null
  alive: boolean
}

const rtspSessions = new Map<string, RtspSession>()

function stopRtsp(cameraId: string): void {
  const session = rtspSessions.get(cameraId)
  if (!session) return
  session.alive = false
  try { session.ffmpeg?.kill() } catch {}
  rtspSessions.delete(cameraId)
}

async function startRtspStream(camera: CameraEntry): Promise<void> {
  if (rtspSessions.has(camera.id)) return
  if (mjpegStreams.has(camera.id)) return

  const url = camera.url!
  const entry: StreamEntry = {
    controller: new AbortController(),
    latest: null,
    latestTs: 0,
    lastConsumerTs: Date.now()
  }
  mjpegStreams.set(camera.id, entry)

  const { spawn } = await import('node:child_process')
  bridge?.log(`[vision] RTSP: connecting via FFmpeg to ${camera.name}...`)

  // FFmpeg handles RTSP demuxing directly (UDP, TCP, Digest/Basic auth, H.264/H.265)
  // and pipes MJPEG frames continuously to stdout.
  // scale=640:-2: resolução que o YOLO 640x640 usa como entrada.
  // -q:v 1 = JPEG máxima qualidade (escala FFmpeg 1-31, onde 1 = melhor).
  // Frames nítidos maximizam detecção de objetos pequenos/distantes.
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'fatal',
    '-fflags', '+nobuffer+genpts+discardcorrupt',
    '-flags', 'low_delay',
    '-i', url,
    '-vf', 'fps=24,scale=640:-2',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-q:v', '1',
    'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  const session: RtspSession = { ffmpeg, alive: true }
  rtspSessions.set(camera.id, session)

  let jpegBuf = Buffer.alloc(0)
  // Constantes fora do handler de data (o handler roda a cada chunk).
  const SOI = Buffer.from([0xff, 0xd8])
  const EOI = Buffer.from([0xff, 0xd9])
  ffmpeg.stdout!.on('data', (chunk: Buffer) => {
    jpegBuf = Buffer.concat([jpegBuf, chunk])
    while (true) {
      const soi = jpegBuf.indexOf(SOI)
      if (soi === -1) break
      const eoi = jpegBuf.indexOf(EOI, soi + 2)
      if (eoi === -1) break
      const frame = jpegBuf.subarray(soi, eoi + 2)
      jpegBuf = jpegBuf.subarray(eoi + 2)
      entry.latest = Buffer.from(frame)
      entry.latestTs = Date.now()
      pushIpFrameToHost(camera.id, frame)
    }
    if (jpegBuf.length > 5 * 1024 * 1024) {
      jpegBuf = Buffer.alloc(0)
    }
  })

  ffmpeg.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString()
    // Ignore benign decoder warnings when joining live H.264/H.265 stream before first keyframe
    if (msg.includes('POC') || msg.includes('RPS') || msg.includes('NALU')) return
    if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('failed') || msg.toLowerCase().includes('fatal')) {
      bridge?.log(`[vision] RTSP FFmpeg (${camera.name}): ${msg.slice(0, 150)}`)
    }
  })

  ffmpeg.on('exit', () => {
    if (session.alive) {
      bridge?.log(`[vision] RTSP: FFmpeg stream exited for ${camera.name}`)
      session.alive = false
      rtspSessions.delete(camera.id)
      mjpegStreams.delete(camera.id)
    }
  })

  entry.controller.signal.addEventListener('abort', () => {
    session.alive = false
    try { ffmpeg.kill() } catch {}
    rtspSessions.delete(camera.id)
    mjpegStreams.delete(camera.id)
  })
}

// ---------------------------------------------------------------------------
// Webcam stream subscription — same MJPEG-in-memory pattern as IP cameras.
// A webcam monitored/ticked asks the host to keep it streaming; instead of a
// GET /media/camera/frame/:deviceId round-trip (which re-encodes the JPEG to
// base64 in node-core on EVERY read) per 1s tick, the worker subscribes once to
// /media/camera/stream/:deviceId and keeps the latest frame in memory. This
// removes the per-tick node-core trip and its base64 encode, so a busy CPU
// (YOLO running) no longer delays each webcam tick the way it used to.
// O frame é guardado binário; base64 só sob demanda em getCameraFrame().
// `latestTs` permite checar frescura do stream sem GET /frame no node-core.
// ---------------------------------------------------------------------------

interface WebcamStreamEntry {
  controller: AbortController
  latest: Buffer | null
  latestTs: number
}
const webcamStreams = new Map<string, WebcamStreamEntry>()

async function startWebcamStream(camera: CameraEntry): Promise<void> {
  if (!camera || camera.source !== 'webcam' || !camera.deviceId) return
  if (webcamStreams.has(camera.id)) return

  const controller = new AbortController()
  const entry: WebcamStreamEntry = { controller, latest: null, latestTs: 0 }
  webcamStreams.set(camera.id, entry)

  void (async () => {
    const deviceId = encodeURIComponent(camera.deviceId!)
    try {
      const res = await hostFetch(`/media/camera/stream/${deviceId}`, {
        headers: { Accept: 'image/jpeg' },
        signal: controller.signal
      })
      if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`)
      const reader = res.body.getReader()
      const SOI = Buffer.from([0xff, 0xd8])
      const EOI = Buffer.from([0xff, 0xd9])
      let buf = Buffer.alloc(0)
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          buf = Buffer.concat([buf, value])
          while (true) {
            const soi = buf.indexOf(SOI)
            if (soi === -1) break
            const eoi = buf.indexOf(EOI, soi + 2)
            if (eoi === -1) break
            const frame = buf.subarray(soi, eoi + 2)
            buf = buf.subarray(eoi + 2)
            entry.latest = Buffer.from(frame)
            entry.latestTs = Date.now()
          }
          if (buf.length > 5 * 1024 * 1024) buf = Buffer.alloc(0)
        }
      }
    } catch {
      // stream died (e.g. watch stopped); cleared by caller
    } finally {
      webcamStreams.delete(camera.id)
    }
  })()
}

function stopWebcamStream(cameraId: string): void {
  const entry = webcamStreams.get(cameraId)
  if (entry) {
    entry.controller.abort()
    webcamStreams.delete(cameraId)
  }
}

async function getCameraFrame(camera: CameraEntry): Promise<{ jpegBase64: string; width?: number; height?: number } | null> {
  if (camera.source === 'ip') {
    const entry = mjpegStreams.get(camera.id)
    if (!entry || !entry.latest || entry.latest.length === 0) return null
    // Base64 sob demanda: o frame é mantido binário no stream (~24x/s) e só é
    // encoded aqui quando alguém consome (ticker 1/s / snapshot / get_frame).
    entry.lastConsumerTs = Date.now()
    return { jpegBase64: entry.latest.toString('base64') }
  }
  // Webcam: prefer the in-memory subscribed frame (no per-tick round-trip).
  if (camera.source === 'webcam' && camera.deviceId) {
    const entry = webcamStreams.get(camera.id)
    if (entry && entry.latest && entry.latest.length > 0) {
      return { jpegBase64: entry.latest.toString('base64') }
    }
    // Fallback: pull the latest stored frame from node-core (cold start).
    try {
      const data = await hostJson<{ jpegBase64: string; width?: number; height?: number; ts?: number }>(
        `/media/camera/frame/${encodeURIComponent(camera.deviceId)}`
      )
      return data
    } catch {
      return null
    }
  }
  if (!camera.deviceId) return null
  try {
    const data = await hostJson<{ jpegBase64: string; width?: number; height?: number; ts?: number }>(
      `/media/camera/frame/${encodeURIComponent(camera.deviceId)}`
    )
    return data
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// CV engine subprocess
// ---------------------------------------------------------------------------

interface EngineProcess {
  child: import('node:child_process').ChildProcess
  pending: Map<string, { resolve: (v: EngineResult) => void; reject: (e: Error) => void }>
  nextId: number
  ready: Promise<void>
}

interface EngineResult {
  boxes: Detection[]
  ms?: number
  error?: string
}

let engine: EngineProcess | null = null
let lastEngineSpawnTs = 0

async function ensureEngine(): Promise<EngineProcess> {
  if (engine && engine.child.connected) return engine
  const { spawn } = await import('node:child_process')
  const enginePath = await requireEnginePath()
  lastEngineSpawnTs = Date.now()
  const child = spawn(process.execPath, [enginePath], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env }
  })
  const pending = new Map<string, { resolve: (v: EngineResult) => void; reject: (e: Error) => void }>()
  const engineProcess: EngineProcess = { child, pending, nextId: 1, ready: Promise.resolve() }
  // O child manda 'ready' SOMENTE APÓS carregar o WASM (~13MB) + modelo ONNX
  // (~10MB) via readFileSync síncrono (ver src/engine.ts: init assíncrono).
  // Logo, aguardar 'ready' aqui garante que o primeiro 'detect' só é enviado
  // com o modelo de fato carregado — era a causa dos boxes só aparecerem
  // "depois de muito tempo": o ack precoce (top-level do módulo) fazia o
  // detect chegar a um child ainda bloqueado no load, ficar enfileirado no IPC
  // e estourar o timeout de 60s (com a resposta pós-timeout descartada).
  engineProcess.ready = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error('CV engine ready timeout (WASM/model load)'))
    }, 90000)
    const onReady = (msg: unknown) => {
      if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'ready') {
        clearTimeout(t)
        child.removeListener('message', onReady)
        resolve()
      }
    }
    const onDied = () => {
      clearTimeout(t)
      reject(new Error('CV engine died before ready'))
    }
    child.on('message', onReady)
    child.once('exit', onDied)
    child.once('error', onDied)
  })
  child.on('message', (msg: unknown) => {
    const m = msg as { type?: string; id?: string }
    if (m.type === 'detect-result' && m.id) {
      const entry = pending.get(m.id)
      if (!entry) return
      pending.delete(m.id)
      const r = msg as { boxes?: Detection[]; error?: string }
      entry.resolve({ boxes: r.boxes || [], error: r.error })
    }
  })
  child.on('exit', () => {
    for (const [, entry] of pending) {
      entry.reject(new Error('CV engine exited'))
    }
    pending.clear()
    engine = null
    // Re-aquece um child novo para pré-carregar o modelo (rate-limited para
    // não entrar em loop de respawn se o engine morrer durante o load). O
    // ensureEngine só spawna sob demanda; este warmup antecipa o load para o
    // próximo detect não esperar os 10-60s no meio do uso.
    if (Date.now() - lastEngineSpawnTs > 30000) {
      lastEngineSpawnTs = Date.now()
      void warmupEngine().catch(() => {})
    }
  })
  child.on('error', (err) => {
    for (const [, entry] of pending) entry.reject(err)
    pending.clear()
    engine = null
  })
  child.stderr?.on('data', (data: Buffer) => {
    const s = data.toString().trim()
    if (s && (s.toLowerCase().includes('error') || s.toLowerCase().includes('fail') || s.toLowerCase().includes('exception'))) {
      bridge?.log(`[vision] engine stderr: ${s.slice(0, 200)}`)
    }
  })
  engine = engineProcess
  try {
    await engineProcess.ready
  } catch (err) {
    // O child não ficou pronto — derruba para não deixar um processo órfão.
    try { child.kill() } catch {}
    engine = null
    throw err
  }
  bridge?.log(`[vision] CV engine ready (${enginePath})`)
  return engineProcess
}

async function engineDetect(jpegBase64: string): Promise<EngineResult> {
  const eng = await ensureEngine()
  const id = `d${eng.nextId++}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      eng.pending.delete(id)
      reject(new Error('CV engine detect timed out'))
    }, 60000)
    eng.pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      }
    })
    eng.child.send({ type: 'detect', id, jpegBase64 })
  })
}

// Pré-carrega o session YOLO do engine (WASM 13MB + ONNX 10MB) sem inferir.
// Chamado no boot do worker para que o primeiro frame_pump não espere a carga
// síncrona (~10-60s) que bloqueia o event loop do child.
async function warmupEngine(): Promise<void> {
  const eng = await ensureEngine()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('CV engine warmup timed out'))
    }, 90000)
    const onMsg = (msg: unknown) => {
      const m = msg as { type?: string; ok?: boolean; error?: string }
      if (m.type === 'warmup-result') {
        clearTimeout(timer)
        eng.child.removeListener('message', onMsg)
        if (m.ok) resolve()
        else reject(new Error(m.error || 'CV engine warmup failed'))
      }
    }
    eng.child.on('message', onMsg)
    eng.child.send({ type: 'warmup' })
  })
}

// Inferência YOLO por-câmera com drop-oldest (evita o lock global).
//
// O sidecar é WASM (single/multi-thread mas limitado), então inferências
// concorrentes de N câmeras + N pumps disputam a mesma CPU e o motor chega a
// 100%. A abordagem antiga serializava tudo numa ÚNICA fila global
// (engineDetectSerial): quando o YOLO ficava ocupado, as inferências de todas
// as câmeras se acumulavam na mesma promise chain e UMA câmera bloqueava as
// outras — era isso que fazia as 3 câmeras congelarem juntas.
//
// Agora cada câmera tem sua própria fila latest-wins (LatestWinsQueue) que
// guarda APENAS o frame mais recente. Quando um novo frame chega durante uma
// inferência em andamento, ele substitui o pendente (drop-oldest) — o YOLO
// sempre processa o último frame, nunca acumula backlog e nenhuma câmera
// espera a vez de outra. Durante o load do modelo (child bloqueado), os
// submits seguintes substituem o pendente em vez de enfileirar dezenas de
// detects no IPC do child.
const detectionSlots = new Map<string, LatestWinsQueue>()

function ensureDetectionSlot(cameraId: string): LatestWinsQueue {
  let slot = detectionSlots.get(cameraId)
  if (!slot) {
    slot = new LatestWinsQueue()
    detectionSlots.set(cameraId, slot)
  }
  return slot
}

/**
 * Submete um frame para detecção YOLO com prioridade ao frame mais recente.
 * Retorna a Promise do resultado correspondente ao frame que for processado.
 * Frames intermediários são descartados (drop-oldest); nunca há fila longa.
 */
async function engineDetectSerial(cameraId: string, jpegBase64: string): Promise<EngineResult> {
  return ensureDetectionSlot(cameraId).submit(jpegBase64, (payload) => runDetectionFor(cameraId, payload))
}

// Inferências aguardando OU segurando o mutex global. Contador observacional:
// NÃO altera a lógica do acquireEngine — apenas expõe "mutex indisponível"
// para o frame_pump responder IMEDIATAMENTE com o cache (engineBusy: true)
// quando o engine está ocupado por outra câmera/RTSP, em vez de bloquear no
// grace do primeiro frame.
let engineInferenceCount = 0

/** Roda UMA inferência (mutex global + métricas) para o payload dado. */
async function runDetectionFor(cameraId: string, jpegBase64: string): Promise<EngineResult> {
  engineInferenceCount++
  const release = await acquireEngine()
  const t0 = Date.now()
  metricFor(cameraId).yoloAt = t0
  metricFor(cameraId).framesYolo++
  try {
    return await engineDetect(jpegBase64)
  } finally {
    metricFor(cameraId).yoloMs.push(Date.now() - t0)
    if (metricFor(cameraId).yoloMs.length > 30) metricFor(cameraId).yoloMs.shift()
    release()
    engineInferenceCount--
  }
}

// ---------------------------------------------------------------------------
// Instrumentação de performance por câmera (FPS de captura / YOLO / render /
// descarte). Permite identificar em qual etapa os frames são perdidos,
// exatamente como o pedido pede:
//   Camera X: Capture 21 FPS | YOLO 12 FPS | Dropped 9 FPS
// As métricas são expostas em GET /extensions/momai-vision/command get_status.
// ---------------------------------------------------------------------------

interface CameraMetrics {
  captureAt: number
  yoloAt: number
  yoloMs: number[]
  renderAt: number
  framesIn: number
  framesYolo: number
  framesDropped: number
}

const cameraMetrics = new Map<string, CameraMetrics>()

function metricFor(cameraId: string): CameraMetrics {
  let m = cameraMetrics.get(cameraId)
  if (!m) {
    m = { captureAt: 0, yoloAt: 0, yoloMs: [], renderAt: 0, framesIn: 0, framesYolo: 0, framesDropped: 0 }
    cameraMetrics.set(cameraId, m)
  }
  return m
}

function fpsBetween(from: number, to: number): number {
  if (!from || !to || to <= from) return 0
  return Math.round(1000 / (to - from))
}

function summaryMetrics(cameraId: string): Record<string, number> {
  const m = metricFor(cameraId)
  const yoloFps = fpsBetween(m.yoloAt, Date.now())
  const capFps = fpsBetween(m.captureAt, Date.now())
  const avgYoloMs = m.yoloMs.length
    ? Math.round(m.yoloMs.reduce((a, b) => a + b, 0) / m.yoloMs.length)
    : 0
  return {
    captureFps: capFps,
    yoloFps,
    renderFps: fpsBetween(m.renderAt, Date.now()),
    framesIn: m.framesIn,
    framesYolo: m.framesYolo,
    framesDropped: m.framesDropped,
    yoloAvgMs: avgYoloMs,
    queue: 0
  }
}

// Mutex GLOBAL do engine: mesmo com filas por-câmera, se 3 câmeras + 3 pumps
// submeterem inferências ao mesmo tempo, o WASM fica a 100% de CPU e trava
// TUDO (o MJPEG das 3 câmeras e o encode da webcam disputam a mesma CPU que
// o YOLO). Com no máximo 1 inferência por vez no sistema inteiro, a CPU nunca
// satura, mas cada câmera continua independente para ENVIAR o frame mais
// recente (drop-oldest por câmera) — a inferência em si é serializada.
let engineLock: Promise<unknown> = Promise.resolve()

function acquireEngine(): Promise<() => void> {
  let release: () => void = () => {}
  const prev = engineLock
  engineLock = new Promise((r) => (release = r as () => void))
  return prev.then(() => release)
}

async function requireEnginePath(): Promise<string> {
  const fs = await import('node:fs')
  try {
    if (fs.existsSync(ENGINE_DIR)) return ENGINE_DIR
  } catch {}
  return ENGINE_DIR_FALLBACK
}

function stopEngine(): void {
  try {
    engine?.child.send({ type: 'shutdown' })
  } catch {}
}

export { stopEngine }
export { resizeJpegBase64 }

// ---------------------------------------------------------------------------
// Vision (local LLM)
// ---------------------------------------------------------------------------

async function describeImage(jpegBase64: string, prompt: string): Promise<string> {
  // Timeout firme: o LLM de visão pode travar (modelo local lento, host sem
  // resposta); sem isto describe_snapshot e runSceneCheck ficavam pendurados
  // para sempre. 30s cobre um modelo local razoável; scene/periodic re-tentam
  // no próximo ciclo.
  const res = await withTimeout(
    hostFetch('/extensions/llm/vision', {
      method: 'POST',
      body: JSON.stringify({ image_base64: jpegBase64, prompt, max_tokens: 256 })
    }),
    30000,
    'llm vision'
  )
  const data = (await res.json().catch(() => ({}))) as { text?: string; visionAvailable?: boolean; error?: string }
  if (!res.ok || data.visionAvailable === false) {
    throw new Error(data.error === 'vision_unavailable' ? 'vision_unavailable' : 'vision_failed')
  }
  return (data.text || '').trim()
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

interface SnapshotMeta {
  id: string
  cameraId: string
  ts: number
  trigger?: string
  description?: string
}

const MAX_SNAPSHOTS = 200

async function loadIndex(): Promise<SnapshotMeta[]> {
  const index = (await bridge!.storage.get('snapshots_index')) as SnapshotMeta[] | null
  return Array.isArray(index) ? index : []
}

async function saveIndex(index: SnapshotMeta[]): Promise<void> {
  await bridge!.storage.set('snapshots_index', index)
}

async function saveSnapshot(jpegBase64: string, meta: Omit<SnapshotMeta, 'id' | 'ts'>): Promise<SnapshotMeta> {
  const config = await loadConfig()
  const maxSnapshots = Math.min(Math.max(Number(config.maxSnapshots) || MAX_SNAPSHOTS, 20), 1000)
  const maxAgeMs = Math.min(Math.max(Number(config.retentionDays) || 7, 1), 90) * 24 * 60 * 60 * 1000
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const bytes = Uint8Array.from(Buffer.from(jpegBase64, 'base64'))
  await bridge!.saveFile(`snapshots/${id}.jpg`, bytes)
  const entry: SnapshotMeta = { id, ts: Date.now(), ...meta }
  const index = await loadIndex()
  index.unshift(entry)
  // Prune: keep newest N / age limit, then delete files that fell out of the index.
  const pruned = index.filter((s) => s.ts >= Date.now() - maxAgeMs).slice(0, maxSnapshots)
  const removedIds = index.filter((s) => !pruned.includes(s)).map((s) => s.id)
  await saveIndex(pruned)
  if (removedIds.length > 0) {
    void deleteSnapshotFiles(removedIds)
  }
  return entry
}

async function deleteSnapshotFiles(ids: string[]): Promise<void> {
  try {
    const fs = await import('node:fs/promises')
    // O saveFile do worker resolve DENTRO de skillPath (process.argv[3] =
    // caminho do skill passado pelo host no spawn; ver src/worker.ts). Calcular
    // via MOMAI_DATA_DIR divergia no layout dev (junction no repositório) e os
    // arquivos de snapshot vazavam. Fallback antigo preservado para segurança.
    const skillPath = process.argv[3]
    const snapshotsDir = skillPath
      ? path.join(skillPath, 'snapshots')
      : path.join(process.env.MOMAI_DATA_DIR || '', 'extensions', SKILL_ID, 'snapshots')
    for (const id of ids) {
      try {
        await fs.unlink(path.join(snapshotsDir, `${id}.jpg`))
      } catch {}
    }
  } catch {}
}

async function readSnapshotBase64(snapshotId: string): Promise<string | null> {
  try {
    const asset = await bridge!.loadAsset(`snapshots/${snapshotId}.jpg`)
    return Buffer.from(asset.bytes).toString('base64')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Embed de imagens em payloads (SSE / structuredResponse / overlay)
// ---------------------------------------------------------------------------
// O frame full-res (1080p/4K) vira ~1-3MB em base64 — embutir isso em cada
// structuredResponse/overlay incha o IPC e, no histórico de alertas, estourava
// a quota de 1MB do bridge de storage. Reduzimos para no máximo 640px de
// largura (qualidade ~0.7) antes de embutir. O caminho do pump do card não
// muda: ele já redimensiona para 640 na origem (webcam via canvas) e o YOLO
// recebe 640x640 internamente.
const MAX_EMBED_WIDTH = 640
const EMBED_JPEG_QUALITY = 85

function resizeJpegBase64(jpegBase64: string): string | null {
  try {
    const jpeg = Buffer.from(jpegBase64, 'base64')
    const raw = decode(new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength), {
      useTArray: true,
      maxMemoryUsageInMB: 128
    })
    const { width, height } = raw
    if (!width || !height) return null
    if (width <= MAX_EMBED_WIDTH) return jpegBase64
    const scale = MAX_EMBED_WIDTH / width
    const newWidth = MAX_EMBED_WIDTH
    const newHeight = Math.max(1, Math.round(height * scale))
    const src = raw.data
    const dst = Buffer.alloc(newWidth * newHeight * 4)
    for (let y = 0; y < newHeight; y++) {
      const sy = Math.min(Math.floor(y / scale), height - 1)
      for (let x = 0; x < newWidth; x++) {
        const sx = Math.min(Math.floor(x / scale), width - 1)
        const si = (sy * width + sx) * 4
        const di = (y * newWidth + x) * 4
        dst[di] = src[si]
        dst[di + 1] = src[si + 1]
        dst[di + 2] = src[si + 2]
        dst[di + 3] = src[si + 3]
      }
    }
    const out = encode({ data: dst, width: newWidth, height: newHeight }, EMBED_JPEG_QUALITY)
    return Buffer.from(out.data).toString('base64')
  } catch {
    return null
  }
}

function toEmbeddedDataUri(jpegBase64: string): string {
  const resized = resizeJpegBase64(jpegBase64)
  return `data:image/jpeg;base64,${resized || jpegBase64}`
}

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

interface ActiveMonitor {
  config: MonitorConfig
  state: MonitorState
}

const monitors = new Map<string, ActiveMonitor>()
const cameraTickers = new Map<string, ReturnType<typeof setInterval>>()
const motionGates = new Map<string, MotionGate>()
let lastOverlayMonitorId: string | null = null

function saveMonitors(): Promise<void> {
  return bridge!.storage.set(
    'monitors',
    [...monitors.values()].map((m) => m.config)
  )
}

/** Avisa as UIs (página/overlay) que o conjunto de monitoramentos mudou. */
function notifyMonitorsChanged(): void {
  bridge?.sendEvent('vision_status', { changedAt: Date.now() })
}

function needsDetection(config: MonitorConfig): boolean {
  return config.triggers.some((t) => t.type === 'object' || t.type === 'presence' || t.type === 'absence')
}

function needsMotion(config: MonitorConfig): boolean {
  return config.triggers.some((t) => t.type === 'motion' || t.type === 'scene')
}

function needsVision(config: MonitorConfig): boolean {
  return config.triggers.some((t) => t.type === 'scene' || t.type === 'periodic')
}

function decodeJpeg(jpegBase64: string): { rgb: Uint8Array; width: number; height: number } {
  const jpeg = Buffer.from(jpegBase64, 'base64')
  const raw = decode(new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength), {
    useTArray: true,
    maxMemoryUsageInMB: 128
  })
  return { rgb: new Uint8Array(raw.data), width: raw.width, height: raw.height }
}

const cameraTickInFlight = new Set<string>()

function ensureCameraTicker(cameraId: string): void {
  if (cameraTickers.has(cameraId)) return
  const timer = setInterval(() => {
    // Guarda de reentrância: se o tick anterior ainda está pendente (frame
    // carregando, YOLO ocupado, host lento), pula este ciclo — o próximo
    // tick não empilha um detect atrás do anterior (backlog de frames stale).
    if (cameraTickInFlight.has(cameraId)) return
    cameraTickInFlight.add(cameraId)
    void tickCamera(cameraId)
      .catch(() => {})
      .finally(() => {
        cameraTickInFlight.delete(cameraId)
      })
  }, 1000)
  cameraTickers.set(cameraId, timer)
}

let autoMonitorsCache: ActiveMonitor[] = []
let lastAutomationSyncTs = 0
let lastAutomationSyncOkTs = 0

async function syncAutomationMonitors(): Promise<ActiveMonitor[]> {
  const now = Date.now()
  if (now - lastAutomationSyncTs < 3000) {
    return autoMonitorsCache
  }
  lastAutomationSyncTs = now

  try {
    const activeTriggers = await fetchHostActiveTriggers()
    if (!Array.isArray(activeTriggers)) {
      autoMonitorsCache = []
      lastAutomationSyncOkTs = now
      return []
    }

    const allCams = listCameras()
    const synced: ActiveMonitor[] = []

    for (const auto of activeTriggers) {
      if (!auto || auto.enabled === false) continue
      const trig = auto.trigger || {}
      const camCond = (auto.global_conditions || []).find(
        (c: any) => c.field?.toLowerCase().includes('camera') || c.field?.toLowerCase().includes('câmera')
      )
      const rawCam = String(
        trig.trigger_config?.camera || trig.params?.camera || trig.camera || camCond?.value || ''
      ).trim()

      let cam = rawCam
        ? allCams.find(
            (c) =>
              c.id === rawCam ||
              c.name === rawCam ||
              (rawCam.length >= 3 &&
                (c.id.toLowerCase().includes(rawCam.toLowerCase()) ||
                  c.name.toLowerCase().includes(rawCam.toLowerCase())))
          )
        : null

      if (!cam) {
        // Fallback: se a câmera não for especificada ou não for encontrada pelo nome, usa a primeira selecionada ou disponível
        const config = await loadConfig()
        const selectedList = config.selectedCameras || []
        cam = allCams.find((c) => selectedList.includes(c.id)) || allCams[0]
      }
      if (!cam) continue

      const objCond = (auto.global_conditions || []).find(
        (c: any) =>
          c.field?.toLowerCase().includes('objeto') ||
          c.field?.toLowerCase().includes('class') ||
          c.field?.toLowerCase().includes('pessoa') ||
          c.field?.toLowerCase().includes('carro')
      )
      let rawObj = String(
        trig.trigger_config?.className ||
          trig.params?.className ||
          trig.className ||
          trig.object ||
          objCond?.value ||
          ''
      ).trim()

      const rawType = String(trig.type || trig.id || '').toLowerCase()
      const isMotion = rawType.includes('motion') || rawType.includes('movimento')

      if (!isMotion && !rawObj) {
        rawObj = 'person'
      }

      const normType = isMotion
        ? 'motion'
        : rawType.includes('presence') || rawType.includes('presenca') || rawType.includes('presença')
        ? 'presence'
        : 'object'

      const triggerObj: Trigger = isMotion
        ? { type: 'motion' }
        : normType === 'presence'
        ? { type: 'presence', className: normalizeClassName(rawObj), event: 'entered' }
        : { type: 'object', className: normalizeClassName(rawObj) }

      const id = `auto-${auto.automationId}`
      const existing = autoMonitorsCache.find((m) => m.config.id === id)
      const state = existing?.state || createMonitorState()

      const config: MonitorConfig = {
        id,
        cameraId: cam.id,
        cameraName: cam.name,
        triggers: [triggerObj],
        label: `⚡ ${auto.automationName || 'Automação Hub'}`,
        createdAt: Date.now(),
        paused: false,
        actions: auto.actions || []
      }

      synced.push({ config, state })

      if (cam.source === 'webcam') void ensureWebcamWatch(cam.id).catch(() => {})
      if (cam.source === 'ip') void startMjpeg(cam).catch(() => {})
      ensureCameraTicker(cam.id)
    }

    // Automação pausada/excluída direto no hub (sem passar pelas tools):
    // se o monitor sumiu do sync, fecha o overlay dele se estiver aberto —
    // senão a janela flutuante continua na tela com o último alerta.
    const removed = autoMonitorsCache.filter((m) => !synced.some((s) => s.config.id === m.config.id))
    for (const gone of removed) {
      if (lastOverlayMonitorId === gone.config.id) {
        bridge?.sendEvent('close_overlay', {})
        lastOverlayMonitorId = null
      }
    }

    autoMonitorsCache = synced
    lastAutomationSyncOkTs = now
    return synced
  } catch {
    // Backend inacessível: expira o cache 10s após o último sync bem-sucedido
    // para não deixar monitores de automação fantasma (ex.: automação pausada
    // no hub) disparando alertas/overlay com estado desatualizado.
    if (now - lastAutomationSyncOkTs > 10000) {
      autoMonitorsCache = []
    }
    return autoMonitorsCache
  }
}

function getActiveMonitorsForCamera(cameraId: string): ActiveMonitor[] {
  const localActive = [...monitors.values()].filter(
    (m) => m.config.cameraId === cameraId && !m.config.paused
  )
  const autoActive = autoMonitorsCache.filter(
    (m) => m.config.cameraId === cameraId && !m.config.paused
  )
  return [...localActive, ...autoActive]
}

function stopCameraTickerIfIdle(cameraId: string): void {
  const active = getActiveMonitorsForCamera(cameraId)
  if (active.length > 0) return
  const timer = cameraTickers.get(cameraId)
  if (timer) {
    clearInterval(timer)
    cameraTickers.delete(cameraId)
  }
  const camera = findCamera(cameraId)
  if (camera && camera.source === 'ip') stopMjpeg(cameraId)
  if (camera && camera.source === 'webcam' && camera.deviceId) {
    webcamWatches.delete(cameraId)
    stopWebcamStream(cameraId)
    void hostFetch('/media/camera/stop-watch', {
      method: 'POST',
      body: JSON.stringify({ deviceId: camera.deviceId })
    }).catch(() => {})
  }
  motionGates.delete(cameraId)
}

async function tickCamera(cameraId: string): Promise<void> {
  void syncAutomationMonitors().catch(() => {})
  const active = getActiveMonitorsForCamera(cameraId)
  if (active.length === 0) return
  const camera = findCamera(cameraId)
  if (!camera) return

  const frame = await getCameraFrame(camera)
  if (!frame) return
  const now = Date.now()
  metricFor(cameraId).captureAt = now
  metricFor(cameraId).framesIn++
  const anyMotion = active.some((m) => needsMotion(m.config))
  const anyDetect = active.some((m) => needsDetection(m.config))
  const anyVision = active.some((m) => needsVision(m.config))

  // Cheap gate first: motion only matters for monitors with motion/scene triggers.
  let motionDetected = false
  if (anyMotion) {
    const gate = motionGates.get(cameraId) || new MotionGate()
    motionGates.set(cameraId, gate)
    const motionTrigger = active
      .flatMap((m) => m.config.triggers)
      .find((t) => t.type === 'motion') as { sensitivity?: 'low' | 'med' | 'high' } | undefined
    try {
      const { rgb, width, height } = decodeJpeg(frame.jpegBase64)
      motionDetected = gate.check(rgb, width, height, {
        sensitivity: motionTrigger?.sensitivity || 'med'
      })
    } catch {
      // Decode failure (corrupt frame): run expensive stages as a safe default.
      motionDetected = true
    }
  }

  let detections: Detection[] = []
  if (anyDetect) {
    try {
      const result = await engineDetectSerial(cameraId, frame.jpegBase64)
      detections = result.boxes || []
      if (result.error) bridge?.log(`[vision] detect error: ${result.error}`)
      metricFor(cameraId).renderAt = Date.now()
      bridge?.sendEvent('vision_detections', {
        cameraId,
        ts: now,
        detections: detections.map((d) => ({
          className: d.className,
          confidence: d.confidence,
          x1: d.x1,
          y1: d.y1,
          x2: d.x2,
          y2: d.y2
        }))
      })
    } catch (err) {
      bridge?.log(`[vision] detect failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  for (const activeMonitor of active) {
    const { config, state } = activeMonitor
    const { alerts, sceneDue } = evaluateMonitor(config, state, {
      motionDetected,
      detections,
      now,
      frameJpeg: frame.jpegBase64
    })

    for (const alert of alerts) {
      await fireAlert(config, alert, frame.jpegBase64)
    }

    for (const due of sceneDue) {
      void runSceneCheck(config, state, due.triggerIndex, frame.jpegBase64).then((alert) => {
        if (alert) void fireAlert(config, alert, frame.jpegBase64)
      })
    }
  }
}

async function runSceneCheck(
  config: MonitorConfig,
  state: MonitorState,
  triggerIndex: number,
  jpegBase64: string
): Promise<import('./vision/triggers').AlertInfo | null> {
  const trigger = config.triggers[triggerIndex]
  if (!trigger || (trigger.type !== 'scene' && trigger.type !== 'periodic')) return null
  try {
    const prompt =
      trigger.type === 'scene'
        ? `Responda apenas SIM ou NAO. Pergunta sobre a imagem: ${trigger.question}`
        : trigger.task || 'Descreva brevemente o que mudou na cena.'
    const answer = await describeImage(jpegBase64, prompt)
    if (trigger.type === 'periodic') {
      // Periodic is informational: alert with the description.
      return {
        monitorId: config.id,
        monitorLabel: config.label,
        cameraId: config.cameraId,
        cameraName: config.cameraName,
        ts: Date.now(),
        triggeredBy: `periodic:${triggerIndex}`,
        description: answer
      }
    }
    const normalized = /^sim\b/i.test(answer.trim()) ? 'yes' : answer.trim().toLowerCase() === 'sim' ? 'yes' : answer.trim().toLowerCase() === 'não' || answer.trim().toLowerCase() === 'nao' ? 'no' : null
    if (!normalized) return null
    return applySceneAnswer(config, state, triggerIndex, normalized as 'yes' | 'no', Date.now())
  } catch (err) {
    if ((err as Error).message === 'vision_unavailable') {
      bridge?.log('[vision] scene check skipped: vision unavailable')
    }
    return null
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Deterministic, model-free alert message built from trigger data — never
 * depends on a vision/multimodal model. Used for the alert text and TTS.
 */
function describeAlert(alert: import('./vision/triggers').AlertInfo): string {
  const cls = ptLabel(alert.className)
  const by = alert.triggeredBy || ''

  if (by === 'motion') return 'Movimento detectado'
  if (by.startsWith('object:')) {
    const absent = alert.description && alert.description.toLowerCase().includes('ausente')
    return absent
      ? `${cap(cls || 'objeto')} não está mais presente`
      : `Detectei ${cls || 'um objeto'}`
  }
  if (by.includes('presence') || by.includes('absence')) {
    const who = cap(cls || 'pessoa')
    if (by.endsWith(':entered')) return `${who} entrou`
    if (by.endsWith(':left')) return `${who} saiu`
    if (by.endsWith(':still_present')) return `${who} está parado(a) há um tempo`
  }
  // scene/periodic already carry a description from their own flow.
  return alert.description || 'Alerta de visão'
}

interface PersistedAlert {
  cameraId?: string
  cameraName?: string
  monitorId?: string
  monitorLabel?: string
  triggeredBy?: string
  className?: string
  confidence?: number
  boxes?: Detection[]
  snapshotId?: string
  ts: number
  description?: string
  imageDataUri?: string
  actions?: MonitorAction[]
}

async function loadAlertsHistory(): Promise<PersistedAlert[]> {
  const history = (await bridge!.storage.get('alerts_history')) as PersistedAlert[] | null
  return Array.isArray(history) ? history : []
}

async function saveAlertsHistory(alerts: PersistedAlert[]): Promise<void> {
  await bridge!.storage.set('alerts_history', alerts)
}

// Serializa as escritas do histórico de alertas. Alertas em rajada (vários
// monitores, tickers de 1s por câmera) chamam saveAlertToHistory de forma
// concorrente via fire-and-forget; um read-modify-write ingênuo perde
// entradas quando duas gravações se sobrepõem (ambas leem o arquivo antigo e
// a última gravação vence). Enfileirar as operações numa promise chain faz
// cada save ler o estado mais recente antes de gravar.
let alertsHistoryWriteChain: Promise<void> = Promise.resolve()

/**
 * Monta a entrada PERSISTIDA do histórico de alertas. NUNCA inclui
 * `imageDataUri`: embutir o base64 full-res no storage estourava a quota de
 * 1MB do bridge (`extension-host-worker.ts`) com 1-2 alertas — o .catch
 * engolia e o histórico sumia após restart. A imagem é servida sob demanda via
 * `snapshotId` (a página/panel montam a URL /storage/snapshots/<id>.jpg; o
 * live event carrega a versão redimensionada). Entradas antigas com
 * `imageDataUri` continuam sendo lidas normalmente (campo opcional).
 */
export function buildPersistedAlert(
  config: MonitorConfig,
  alert: import('./vision/triggers').AlertInfo,
  snapshotId: string | undefined,
  description: string,
  actions: MonitorAction[] | undefined
): PersistedAlert {
  return {
    cameraId: config.cameraId,
    cameraName: config.cameraName || config.cameraId,
    monitorId: config.id,
    monitorLabel: config.label,
    triggeredBy: alert.triggeredBy,
    confidence: alert.confidence,
    className: alert.className,
    boxes: alert.boxes || [],
    snapshotId,
    ts: alert.ts,
    description,
    actions
  }
}

function saveAlertToHistory(alert: PersistedAlert): Promise<void> {
  const task = alertsHistoryWriteChain.then(async () => {
    const history = await loadAlertsHistory()
    history.unshift(alert)
    await saveAlertsHistory(history.slice(0, 200))
  })
  // Uma falha de gravação não pode envenenar a fila dos alertas seguintes.
  alertsHistoryWriteChain = task.catch(() => {})
  return task
}

async function fireAlert(config: MonitorConfig, alert: import('./vision/triggers').AlertInfo, jpegBase64: string): Promise<void> {
  let snapshot: SnapshotMeta | null = null
  try {
    snapshot = await saveSnapshot(jpegBase64, {
      cameraId: config.cameraId,
      trigger: alert.triggeredBy
    })
  } catch (err) {
    bridge?.log(`[vision] snapshot save failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  let description = describeAlert(alert)

  const sysConfig = await loadConfig().catch(() => ({} as StoredConfig))
  const mergedActions = (Array.isArray(config.actions) && config.actions.length > 0)
    ? config.actions
    : (Array.isArray(sysConfig.sendActions) && sysConfig.sendActions.length > 0)
    ? sysConfig.sendActions
    : undefined

  // Histórico persistido: SEM imageDataUri (quota do storage) — a UI monta a
  // imagem via snapshotId. Live event/overlay/chat: imagem EMBUTIDA, porém
  // redimensionada (máx 640px) para não inchar o IPC.
  const alertPayload = buildPersistedAlert(config, alert, snapshot?.id, description, mergedActions)

  const data = {
    type: 'vision_alert',
    data: {
      ...alertPayload,
      imageDataUri: toEmbeddedDataUri(jpegBase64),
      tts: description
    }
  }

  void saveAlertToHistory(alertPayload).catch((err) => {
    bridge?.log(`[vision] failed to save alert history: ${err instanceof Error ? err.message : String(err)}`)
  })

  bridge?.sendEvent('vision_alert', data.data)
  bridge?.sendStructuredResponse(data)

  // Floating overlay is the primary alert channel (host mechanism).
  lastOverlayMonitorId = config.id
  bridge?.sendEvent('open_overlay', {
    skillId: SKILL_ID,
    panel: 'dist/panel.js',
    panelType: 'extension-panel',
    structuredResponse: data,
    overlaySize: { width: 480, height: 560 },
    strategy: 'replace'
  })

  bridge?.log(`[vision] alert fired: ${alert.triggeredBy} on ${config.cameraId}`)
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const webcamWatches = new Set<string>()

// Freshness bookkeeping. A webcam is "online" only while it is actually
// delivering frames — not merely enumerated. `webcamLastReconnectTs`
// rate-limits re-acquisition attempts so a marginal/unplugged camera does not
// loop.
//
// IMPORTANTE (churn do Media Foundation): o stop+start do watch fecha e reabre
// o dispositivo de captura no Windows (getUserMedia → MF). Reabrir com o
// dispositivo recém-liberado/instável gera "Failed to reserve output capture
// buffer" e congela o preview durante a janela de reabertura. Por isso:
//   - WEB_FRAME_STALE_MS  (5s):  "online?" — checagem de frescura (stream/GET)
//   - WEB_RECONNECT_STALE_MS (15s): o watch só é considerado MORTO quando não
//     há frame nenhum há muito mais tempo que uma lentidão transitória do
//     pump da hidden window (toBlob atrasado com CPU ocupada pelo YOLO)
//   - WEB_RECONNECT_MIN_MS (60s): stop+start é destrutivo e deve ser raro
//   - o start-watch do HOST já é idempotente e re-acquire sozinho quando o
//     stream morreu — o worker NUNCA precisa do stop prévio
const WEB_FRAME_STALE_MS = 5000
const WEB_RECONNECT_STALE_MS = 15000
const WEB_RECONNECT_MIN_MS = 60000
// Timeout do worker para o start-watch no host. O bridge da câmera tem 30s
// internos; para o fluxo de UI (list_cameras no modal de adicionar) esperar
// tudo isso é "Adicionando" eterno. 8s cobre o boot da hidden window + o
// getUserMedia de uma webcam saudável com folga, e o retry do sync (5s)
// recupera se o dispositivo demorar a "acordar".
const START_WATCH_TIMEOUT_MS = 8000
const webcamLastReconnectTs = new Map<string, number>() // deviceId -> ts
// Última vez que um frame REAL foi visto para o deviceId (via stream do worker
// ou GET /frame). Distingue "host entregando (só o worker perdeu o stream)" de
// "host realmente parou".
const webcamLastSeen = new Map<string, number>() // deviceId -> ts

async function stopWebcamWatch(camera: CameraEntry): Promise<void> {
  if (!camera || camera.source !== 'webcam' || !camera.deviceId) return
  webcamWatches.delete(camera.id)
  stopWebcamStream(camera.id)
  await hostFetch('/media/camera/stop-watch', {
    method: 'POST',
    body: JSON.stringify({ deviceId: camera.deviceId })
  }).catch(() => {})
}

// Stop a watch by its `webcam:<deviceId>` id. After a replug the deviceId can
// change, so the OLD id is no longer resolvable through findCamera — but the
// host may still hold a (frozen) stream for it that keeps the physical device
// busy. Stopping by id releases the device so the new id can be acquired.
async function stopWebcamWatchById(cameraId: string): Promise<void> {
  if (!cameraId.startsWith('webcam:')) return
  const deviceId = cameraId.slice('webcam:'.length)
  if (!deviceId) return
  webcamWatches.delete(cameraId)
  stopWebcamStream(cameraId)
  await hostFetch('/media/camera/stop-watch', {
    method: 'POST',
    body: JSON.stringify({ deviceId })
  }).catch(() => {})
}

async function isWebcamOnline(camera: CameraEntry): Promise<boolean> {
  if (!camera || camera.source !== 'webcam' || !camera.deviceId) return false
  try {
    // Checagem BARATA: GET binário (Accept: image/jpeg / format=binary) — o
    // node-core envia o JPEG direto, SEM re-encode base64 no thread único. O
    // timestamp vem no header X-Frame-Ts; o body (~100KB) é descartado via
    // cancel() porque só precisamos do status. Antes, cada poll baixava a
    // base64 de TODAS as webcams, saturando o node-core e atrasando até o
    // próprio POST de comando (timeout de 15s na página).
    const res = await withTimeout(
      hostFetch(`/media/camera/frame/${encodeURIComponent(camera.deviceId)}?format=binary`, {
        headers: { Accept: 'image/jpeg' }
      }),
      2000,
      'webcam online check'
    )
    if (!res.ok) return false
    const ts = Number(res.headers.get('x-frame-ts'))
    // Cancela o body — não precisamos dos bytes, só do status/frescor.
    res.body?.cancel().catch(() => {})
    if (ts > 0) {
      return Date.now() - ts < WEB_FRAME_STALE_MS
    }
    // Host sem o header (versão antiga): a presença do frame (200) é aceita.
    return true
  } catch {
    return false
  }
}

// Frescura do frame da webcam SEM rede: o worker já assina o stream da câmera
// (startWebcamStream) e mantém o último frame em memória. Quando o stream está
// entregando, não há motivo para um GET /media/camera/frame no node-core (que
// re-encoda o JPEG em base64 no thread único do host) só para ler o timestamp.
function isWebcamStreamFresh(camera: CameraEntry): boolean {
  if (!camera || camera.source !== 'webcam' || !camera.deviceId) return false
  const sub = webcamStreams.get(camera.id)
  return !!sub && sub.latest !== null && sub.latestTs > 0 && Date.now() - sub.latestTs < WEB_FRAME_STALE_MS
}

// Re-acquire a selected webcam's host stream when it stopped delivering
// frames (e.g. after an unplug/replug), but at most once per
// WEB_RECONNECT_MIN_MS. A healthy camera that IS producing frames is never
// touched — this is what keeps it from blinking/toggling.
const webcamLastOnlineCheck = new Map<string, number>() // deviceId -> ts
async function reconnectWebcamIfStale(camera: CameraEntry): Promise<void> {
  if (!camera || camera.source !== 'webcam' || !camera.deviceId) return
  const deviceId = camera.deviceId
  // Rate-limit a checagem: no máximo 1x/5s por câmera (mesmo ritmo do
  // syncWebcamWatches). Antes era 3s — com o GET /frame de fallback (que
  // re-encoda o JPEG em base64 no thread único do node-core) rodando a cada
  // 3s para a webcam sem stream, o node-core sofria micro-pausas periódicas
  // que travavam os 3 vídeos juntos a cada ~3 segundos.
  const lastCheck = webcamLastOnlineCheck.get(deviceId) || 0
  if (Date.now() - lastCheck < 5000) return
  webcamLastOnlineCheck.set(deviceId, Date.now())

  // 1) Frescura via stream em memória (sem rede) — o caso saudável.
  if (isWebcamStreamFresh(camera)) {
    webcamLastSeen.set(deviceId, Date.now())
    return
  }

  // 2) Stream do worker morto/atrasado, mas o GET confirma que o HOST está
  //    entregando frames (a hidden window posta a ~24fps): o dispositivo está
  //    saudável — apenas re-assina o stream do worker. ZERO impacto no MF:
  //    não faz stop/start do watch (que fecharia e reabriria a captura).
  if (await isWebcamOnline(camera)) {
    webcamLastSeen.set(deviceId, Date.now())
    if (!webcamStreams.has(camera.id)) {
      void startWebcamStream(camera).catch(() => {})
    }
    return
  }

  // 3) Nenhum frame visto há muito tempo (staleness REAL, não lentidão
  //    transitória) + backoff longo. Re-acquire via start-watch idempotente do
  //    host — ele reabre sozinho se o stream morreu. NUNCA stop+start aqui:
  //    o stop forçaria fechar o MF e reabrir, que é o que gera
  //    "Failed to reserve output capture buffer" e o stutter do preview.
  const sub = webcamStreams.get(camera.id)
  const lastSeen = Math.max(sub?.latestTs || 0, webcamLastSeen.get(deviceId) || 0)
  if (Date.now() - lastSeen < WEB_RECONNECT_STALE_MS) return
  const lastTry = webcamLastReconnectTs.get(deviceId) || 0
  if (Date.now() - lastTry < WEB_RECONNECT_MIN_MS) return
  webcamLastReconnectTs.set(deviceId, Date.now())
  await ensureWebcamWatch(camera.id, 24, true)
}

async function ensureWebcamWatch(cameraId: string, fps = 24, force = false): Promise<void> {
  const camera = findCamera(cameraId)
  if (!camera || camera.source !== 'webcam' || !camera.deviceId) return
  // `force` lets syncWebcamWatches re-issue start-watch even when we already
  // asked the host before. The host start-watch is idempotent for a live
  // stream (just resets the pump timer) and re-acquires if the stream died
  // (e.g. device unplugged/replugged). Without this, a dead watch is never
  // restarted because the `webcamWatches` set still lists the camera.
  if (webcamWatches.has(cameraId) && !force) return
  try {
    // Bounded: o bridge da câmera no host tem timeout interno de 30s por
    // operação (getUserMedia pode travar no Windows/MF). Esperar isso aqui
    // bloqueia toolListCameras/get_status — e o modal "Adicionar" da página
    // fica preso em "Adicionando" por 30-60s. O start-watch é idempotente no
    // host e re-issued pelos retries do syncWebcamWatches (5s), então falhar
    // rápido aqui não perde nada: a câmera é recuperada no próximo ciclo.
    await withTimeout(
      hostFetch('/media/camera/start-watch', {
        method: 'POST',
        body: JSON.stringify({ deviceId: camera.deviceId, fps })
      }),
      START_WATCH_TIMEOUT_MS,
      'start-watch'
    )
    webcamWatches.add(cameraId)
  } catch {
    // device busy / bridge lento — retried by syncWebcamWatches
  }
  // Subscribe to the host stream so ticks read the latest frame from memory
  // instead of a per-tick GET + base64 re-encode in node-core.
  void startWebcamStream(camera).catch(() => {})
}

// A USB webcam replug can change its deviceId while keeping the same label.
// Remap a selected/monitored `webcam:<oldId>` to the new `webcam:<newId>` when
// exactly one selected webcam went missing and exactly one unselected webcam
// appeared — the "replugged the same camera" case. Ambiguous cases are skipped.
async function remapRepluggedWebcamIds(): Promise<void> {
  const config = await loadConfig()
  const selected = (config.selectedCameras || []).filter((id) => id.startsWith('webcam:'))
  const missing = selected.filter((id) => !webcamCache.some((c) => c.id === id))
  const unselectedNew = webcamCache.filter((c) => c.source === 'webcam' && !selected.includes(c.id))
  if (missing.length !== 1 || unselectedNew.length !== 1) return
  const newId = unselectedNew[0].id
  if (!missing[0] || newId === missing[0]) return
  const oldId = missing[0]
  // Escrita serializada + invalidação do cache: sem isto, o loadConfig de 2s
  // continuava devolvendo o config antigo (seleção remapeada não refletida).
  await updateConfig((cfg) => {
    cfg.selectedCameras = (cfg.selectedCameras || []).map((id) => (id === oldId ? newId : id))
  })
  for (const m of monitors.values()) {
    if (m.config.cameraId === oldId) m.config.cameraId = newId
  }
  void saveMonitors()
}

// Keep host watches alive for webcams that are selected in the dashboard or
// being monitored, so cameras stay on even after the Vision page closes.
async function syncWebcamWatches(): Promise<void> {
  // Se a lista de webcams está vazia (ex.: 403 transitório no boot, antes de o
  // skill ser carregado), re-tenta a listagem — senão os watches nunca
  // iniciam e a webcam fica sem preview até reiniciar o app. Limitado: o
  // bridge pode demorar e este sync roda a cada 5s no intervalo.
  if (webcamCache.length === 0) {
    await withTimeout(refreshWebcams(), 3000, 'watch sync refresh').catch(() => {})
  }
  // If the user replugged a USB webcam (deviceId changed, label stable), remap
  // the persisted selection so the card reconnects to the new device.
  await remapRepluggedWebcamIds().catch(() => {})
  // Re-lê após o remap (o updateConfig invalida o cache; a seleção remapeada
  // tem que valer já neste ciclo, senão o watch antigo é derrubado).
  const config = await loadConfig()
  // `wanted` is derived from the PERSISTED selection/monitors (stable), not the
  // transient webcamCache. If we built it from webcamCache, a camera that
  // momentarily drops out of the enumerateDevices list would leave `wanted`,
  // its watch would be stopped here and restarted on the next sync — a
  // stop/start churn that makes the webcam LED physically toggle on Windows.
  const wanted = new Set<string>()
  for (const id of config.selectedCameras || []) {
    if (id.startsWith('webcam:')) wanted.add(id)
  }
  for (const m of monitors.values()) {
    // Paused monitors do not keep the webcam alive by themselves.
    if (!m.config.paused && m.config.cameraId.startsWith('webcam:')) wanted.add(m.config.cameraId)
  }
  // Only stop watches when we have a valid device list — otherwise a
  // transient refresh failure would kill cameras that are still present.
  if (webcamCache.length > 0) {
    for (const id of [...webcamWatches]) {
      if (!wanted.has(id)) {
        // Stop by id, not by findCamera: an orphaned watch whose deviceId
        // changed on replug is no longer resolvable, but its frozen host
        // stream still holds the device — releasing it unblocks the new id.
        await stopWebcamWatchById(id)
      }
    }
  }
  for (const id of wanted) {
    // Re-acquire only if the stream stopped delivering frames (replug/device
    // change). A healthy camera is left untouched — no start/start churn, so it
    // does not blink. A camera being manually reloaded right now is also left
    // alone: the reload is already rebuilding its stream.
    const cam = findCamera(id)
    if (!cam || cam.source !== 'webcam' || reloadingCameras.has(id)) continue
    if (!webcamWatches.has(id)) {
      // COLD START: o watch nunca iniciou (ex.: câmera USB 2.0 que demora a
      // "acordar" — o primeiro start-watch pode falhar com o dispositivo ainda
      // subindo). Tenta iniciar AGORA, sem o backoff do reconnect: o retry a
      // cada ciclo do sync (5s) recupera a câmera sozinho, sem o usuário
      // precisar fechar/reabrir a página. O start-watch é idempotente no host
      // (não gera churn MF se já estiver ativo).
      await ensureWebcamWatch(id)
    }
    await reconnectWebcamIfStale(cam)
  }
}

async function toolListCameras(): Promise<unknown> {
  // Enumeração SEM bloquear o comando. Com cache existente (o dropdown já
  // enumerou), refresca em background e devolve o cache atual; sem cache
  // (boot), espera no máximo 3s. list_cameras roda no poll de 5s e dentro do
  // fluxo de "Adicionar câmera" (modal "Adicionando") — o bridge da câmera
  // pode demorar (timeout interno de 30s) e NENHUM comando pode segurar a UI.
  if (webcamCache.length === 0) {
    await withTimeout(refreshWebcams(), 3000, 'camera list refresh').catch(() => {})
  } else {
    void refreshWebcams().catch(() => {})
  }
  await syncIpCameras().catch(() => {})
  // NÃO inicia stream de todas as câmeras IP aqui (vazava streams sem
  // consumidor): o stream sobe sob demanda (get_frame/capture_snapshot), para
  // câmeras com monitor ativo, ou para câmeras selecionadas — e o sweep de
  // TTL encerra streams ociosos. A página inicia o stream do card via get_frame.
  // Fire-and-forget de propósito: o start-watch da webcam no host pode
  // demorar (bridge 30s no pior caso) e NENHUM comando de status/lista deve
  // bloquear nisso — a página aguarda list_cameras dentro do fluxo de
  // "Adicionar câmera" (modal preso em "Adicionando") e no poll de 5s. O
  // watch é estabelecido em segundo plano e o sync (intervalo de 5s) +
  // reconnect re-tentam até a câmera subir; o status "Conectado" aparece no
  // próximo poll assim que o frame fluir.
  void syncWebcamWatches().catch(() => {})
  const cameras = listCameras()
  const statusStart = Date.now()
  const status = await getStatusData()
  const statusMs = Date.now() - statusStart
  if (statusMs > 1000) bridge?.log(`[vision] list_cameras: getStatusData took ${statusMs}ms (${cameras.length} cams)`)
  const config = await loadConfig()
  const selectedSet = new Set(config.selectedCameras || [])
  return {
    ok: true,
    cameras: cameras.map((c) => ({
      id: c.id,
      name: c.name,
      source: c.source,
      online: status[c.id]?.online ?? false,
      monitors: status[c.id]?.monitors ?? 0,
      selected: selectedSet.has(c.id)
    })),
    selectedCameras: config.selectedCameras || []
  }
}

async function toolCaptureSnapshot(args: { cameraId?: string; camera?: string; name?: string }): Promise<unknown> {
  const config = await loadConfig()
  const selectedList = config.selectedCameras || []

  let cameraId = args.cameraId || args.camera || args.name
  if (!cameraId) {
    if (selectedList.length === 1) {
      cameraId = selectedList[0]
    }
  }

  if (!cameraId) {
    if (selectedList.length === 0) {
      return {
        ok: false,
        error: 'Nenhuma câmera está selecionada/ativa no painel da MomAI Vision. Peça ao usuário para abrir o painel da visão e ativar a câmera desejada (botão +).'
      }
    }
    return { ok: false, error: 'no camera specified' }
  }

  await refreshWebcams()
  const camera = findCamera(cameraId)
  if (!camera) return { ok: false, error: `unknown camera: ${cameraId}` }

  if (!selectedList.includes(camera.id)) {
    return {
      ok: false,
      error: `A câmera "${camera.name}" (id: ${camera.id}) não foi selecionada pelo usuário no painel da MomAI Vision. Peça ao usuário para ativá-la no painel (botão +) antes de tirar um print.`
    }
  }

  if (camera.source === 'webcam' && camera.deviceId) {
    await ensureWebcamWatch(camera.id)
  }
  if (camera.source === 'ip') {
    await startMjpeg(camera)
  }
  // Give the source a moment to produce a frame.
  let frame: { jpegBase64: string } | null = null
  for (let i = 0; i < 10; i++) {
    frame = await getCameraFrame(camera)
    if (frame) break
    await new Promise((r) => setTimeout(r, 300))
  }
  if (!frame) return { ok: false, error: 'no frame available' }
  const snapshot = await saveSnapshot(frame.jpegBase64, { cameraId: camera.id })
  const description = ''
  const structuredResponse = {
    type: 'vision_alert',
    data: {
      cameraId,
      cameraName: camera.name,
      monitorId: 'snapshot',
      triggeredBy: 'snapshot',
      snapshotId: snapshot.id,
      ts: snapshot.ts,
      description,
      imageDataUri: toEmbeddedDataUri(frame.jpegBase64)
    }
  }
  bridge?.sendStructuredResponse(structuredResponse)
  return {
    ok: true,
    snapshotId: snapshot.id,
    description,
    cameraId,
    cameraName: camera.name,
    directResponse: `Print capturado (${camera.name}).`,
    structuredResponse
  }
}

async function toolDescribeSnapshot(args: { snapshotId: string }): Promise<unknown> {
  if (!args.snapshotId) return { ok: false, error: 'snapshotId required' }
  const jpegBase64 = await readSnapshotBase64(args.snapshotId)
  if (!jpegBase64) return { ok: false, error: `snapshot not found: ${args.snapshotId}` }
  try {
    const description = await describeImage(
      jpegBase64,
      'Descreva a cena nesta imagem em 1-2 frases, em portugues.'
    )
    return { ok: true, snapshotId: args.snapshotId, description }
  } catch (err) {
    // Não engolir: falha real retorna ok:false com motivo (a página mostra o
    // erro no lugar de "descrição vazia").
    return {
      ok: false,
      snapshotId: args.snapshotId,
      error: (err as Error).message === 'vision_unavailable' ? 'vision_unavailable' : 'vision_failed'
    }
  }
}

interface StartMonitoringArgs {
  cameraId?: string
  triggers: Trigger[]
  schedule?: { days?: number[]; start?: string; end?: string }
  cooldownSec?: number
  notify?: { native?: boolean; chat?: boolean }
  confirm?: boolean
  label?: string
  actions?: MonitorAction[]
}

interface UpdateMonitoringArgs {
  monitorId: string
  cameraId?: string
  triggers?: Trigger[]
  schedule?: { days?: number[]; start?: string; end?: string }
  cooldownSec?: number
  notify?: { native?: boolean; chat?: boolean }
  label?: string
  actions?: MonitorAction[]
}

async function toolStartMonitoring(
  args: StartMonitoringArgs & { camera?: string; name?: string; content?: string; query?: string; input?: string; prompt?: string }
): Promise<unknown> {
  const config = await loadConfig()
  const selectedList = config.selectedCameras || []

  await refreshWebcams()
  const allCameras = listCameras()
  const rawText = (args.content || args.query || args.input || args.prompt || '').trim()
  const rawArgs = args as unknown as Record<string, unknown>

  let targetId = args.cameraId?.trim() || args.camera?.trim() || args.name?.trim()

  if (!targetId && rawText) {
    for (const cam of allCameras) {
      if (selectedList.includes(cam.id)) {
        if (
          rawText.includes(cam.id) ||
          rawText.toLowerCase().includes(cam.name.toLowerCase()) ||
          (cam.source === 'webcam' && /usb2?\.?0?/i.test(rawText) && /usb2?\.?0?/i.test(cam.name))
        ) {
          targetId = cam.id
          break
        }
      }
    }
    if (!targetId) {
      for (const cam of allCameras) {
        if (
          rawText.includes(cam.id) ||
          rawText.toLowerCase().includes(cam.name.toLowerCase()) ||
          (cam.source === 'webcam' && /usb2?\.?0?/i.test(rawText) && /usb2?\.?0?/i.test(cam.name))
        ) {
          targetId = cam.id
          break
        }
      }
    }
  }

  if (!targetId) {
    if (selectedList.length === 0) {
      return {
        ok: false,
        error: 'Nenhuma câmera está selecionada no painel da MomAI Vision. Peça ao usuário para abrir a página da visão e selecionar a câmera desejada (botão +).'
      }
    }
    bridge?.log(
      `[vision] start_monitoring failed: no camera provided (args: ${JSON.stringify(args).slice(0, 300)})`
    )
    return { ok: false, error: 'Nenhuma câmera foi informada. Pergunte ao usuário em qual câmera ele deseja iniciar o monitoramento.' }
  }

  const camera = findCamera(targetId)
  if (!camera) {
    bridge?.log(`[vision] start_monitoring failed: unknown camera "${targetId}"`)
    const available = allCameras.map((c) => `"${c.name}" (id: ${c.id})`).join(', ')
    return { ok: false, error: `Câmera não encontrada: "${targetId}". Câmeras disponíveis: ${available}` }
  }

  if (!selectedList.includes(camera.id)) {
    return {
      ok: false,
      error: `A câmera "${camera.name}" (id: ${camera.id}) não está selecionada pelo usuário no painel da MomAI Vision. Peça ao usuário para ativá-la no painel (botão +) antes de iniciar o monitoramento.`
    }
  }

  let triggers = args.triggers
  if ((!triggers || triggers.length === 0) && (rawArgs.detect || rawArgs.detection || rawArgs.trigger)) {
    const dt = String(rawArgs.detect || rawArgs.detection || rawArgs.trigger).toLowerCase()
    if (dt.includes('human') || dt.includes('pessoa') || dt.includes('presen')) {
      triggers = [{ type: 'presence', className: 'person', event: 'entered' }]
    } else if (dt.includes('moviment') || dt.includes('motion')) {
      triggers = [{ type: 'motion', sensitivity: 'med' }]
    } else {
      triggers = [{ type: 'object', className: normalizeClassName(dt) }]
    }
  }

  if (!Array.isArray(triggers) || triggers.length === 0) {
    if (rawText) {
      const textLower = rawText.toLowerCase()
      if (textLower.includes('humano') || textLower.includes('pessoa') || textLower.includes('presen')) {
        triggers = [{ type: 'presence', className: 'person', event: 'entered' }]
      } else if (textLower.includes('movimento')) {
        triggers = [{ type: 'motion', sensitivity: 'med' }]
      } else if (textLower.includes('ausên') || textLower.includes('ausen')) {
        triggers = [{ type: 'absence', className: 'person', event: 'entered' }]
      }
    }
    if (!Array.isArray(triggers) || triggers.length === 0) {
      bridge?.log(
        `[vision] start_monitoring: no triggers provided, defaulting to person-entered (args: ${JSON.stringify(args).slice(0, 300)})`
      )
      triggers = [{ type: 'presence', event: 'entered' }]
    }
  }
  const validTypes = ['motion', 'object', 'presence', 'absence', 'scene', 'periodic']
  for (const trigger of triggers) {
    if (!validTypes.includes(trigger.type)) {
      bridge?.log(
        `[vision] start_monitoring invalid trigger type "${(trigger as { type: string }).type}" (args: ${JSON.stringify(args).slice(0, 300)})`
      )
      return { ok: false, error: `invalid trigger type: ${(trigger as { type: string }).type}` }
    }
    // Normalize PT synonyms to the English COCO label the detector emits.
    if (
      (trigger.type === 'object' || trigger.type === 'presence' || trigger.type === 'absence') &&
      trigger.className
    ) {
      trigger.className = normalizeClassName(trigger.className)
    }
  }

  const requestedCooldown =
    typeof args.cooldownSec === 'number'
      ? args.cooldownSec
      : typeof rawArgs.interval_seconds === 'number'
      ? Number(rawArgs.interval_seconds)
      : typeof rawArgs.cooldown_seconds === 'number'
      ? Number(rawArgs.cooldown_seconds)
      : typeof rawArgs.cooldown === 'number'
      ? Number(rawArgs.cooldown)
      : 300

  const plan = describePlan(camera, triggers) + await describeSendActionsSuffix(args.actions)
  // NOTE: no confirmation gate — the host has no requiresConfirmation flow,
  // so blocking here would silently fail to start monitoring. Monitoring
  // starts immediately; the plan is returned in the response text.

  const id = `mon-${Date.now()}`
  const monitorConfig: MonitorConfig = {
    id,
    cameraId: camera.id, // canonical id — args.cameraId may be a name/label
    cameraName: camera.name,
    triggers,
    schedule: args.schedule,
    cooldownSec: Math.min(Math.max(requestedCooldown, 10), 3600),
    label: args.label,
    actions: Array.isArray(args.actions) ? args.actions : undefined,
    createdAt: Date.now()
  }
  monitors.set(id, { config: monitorConfig, state: createMonitorState() })
  await saveMonitors()
  notifyMonitorsChanged()

  if (camera.source === 'webcam') await ensureWebcamWatch(camera.id)
  if (camera.source === 'ip') await startMjpeg(camera)
  ensureCameraTicker(camera.id)

  bridge?.log(`[vision] monitoring started: ${id} on ${camera.id}`)
  return { ok: true, monitorId: id, plan }
}

async function toolUpdateMonitoring(args: UpdateMonitoringArgs): Promise<unknown> {
  if (!args.monitorId) {
    return { ok: false, error: 'monitorId required' }
  }
  const entry = monitors.get(args.monitorId)
  if (!entry) {
    return { ok: false, error: `monitorId not found: ${args.monitorId}` }
  }

  const oldCameraId = entry.config.cameraId
  let camera = findCamera(oldCameraId)

  if (args.cameraId && args.cameraId.trim()) {
    await refreshWebcams()
    const newCamera = findCamera(args.cameraId.trim())
    if (!newCamera) {
      return { ok: false, error: `unknown camera: ${args.cameraId}` }
    }
    const config = await loadConfig()
    const selectedList = config.selectedCameras || []
    if (!selectedList.includes(newCamera.id)) {
      return {
        ok: false,
        error: `A câmera "${newCamera.name}" não foi selecionada pelo usuário no painel da MomAI Vision.`
      }
    }
    camera = newCamera
    entry.config.cameraId = newCamera.id
    entry.config.cameraName = newCamera.name
  }

  if (Array.isArray(args.triggers) && args.triggers.length > 0) {
    const validTypes = ['motion', 'object', 'presence', 'absence', 'scene', 'periodic']
    for (const trigger of args.triggers) {
      if (!validTypes.includes(trigger.type)) {
        return { ok: false, error: `invalid trigger type: ${(trigger as { type: string }).type}` }
      }
      if (
        (trigger.type === 'object' || trigger.type === 'presence' || trigger.type === 'absence') &&
        trigger.className
      ) {
        trigger.className = normalizeClassName(trigger.className)
      }
    }
    entry.config.triggers = args.triggers
  }

  if (args.schedule !== undefined) {
    entry.config.schedule = args.schedule
  }

  if (args.cooldownSec !== undefined) {
    entry.config.cooldownSec = Math.min(Math.max(args.cooldownSec, 10), 3600)
  }

  if (args.label !== undefined) {
    entry.config.label = args.label
  }

  if (Array.isArray(args.actions)) {
    entry.config.actions = args.actions
  }

  await saveMonitors()
  notifyMonitorsChanged()

  if (oldCameraId !== entry.config.cameraId) {
    stopCameraTickerIfIdle(oldCameraId)
  }
  // A paused monitor must not (re)activate camera resources when edited.
  if (camera && !entry.config.paused) {
    if (camera.source === 'webcam') await ensureWebcamWatch(camera.id)
    if (camera.source === 'ip') await startMjpeg(camera)
    ensureCameraTicker(camera.id)
  }

  const plan =
    (camera ? describePlan(camera, entry.config.triggers) : 'Monitor atualizado.') +
    (await describeSendActionsSuffix(entry.config.actions))
  bridge?.log(`[vision] monitoring updated: ${args.monitorId}`)

  return { ok: true, monitorId: args.monitorId, plan, config: entry.config }
}

/**
 * Pausa monitoramento(s) sem excluir: interrompe a execução, mas mantém os
 * dados/configurações salvos para gerenciar depois (retomar ou excluir).
 */
async function toolPauseMonitoring(args: { monitorId?: string; all?: boolean }): Promise<unknown> {
  if (args.monitorId?.startsWith('auto-')) {
    const autoId = args.monitorId.replace('auto-', '')
    try {
      const res = await hostFetch(`/automations/${autoId}/toggle`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: false })
      })
      if (!res.ok) {
        bridge?.log(`[vision] pause_monitoring: toggle failed for automation ${autoId} (HTTP ${res.status})`)
        return { ok: false, error: `Falha ao pausar a automação (HTTP ${res.status}).` }
      }
    } catch (err) {
      bridge?.log(`[vision] pause_monitoring: toggle error for automation ${autoId}: ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false, error: 'Falha ao pausar a automação. Backend inacessível.' }
    }
    // Remove do cache imediatamente: o ticker não pode disparar alertas/overlay
    // enquanto a automação está pausada (o próximo sync também a excluiria).
    autoMonitorsCache = autoMonitorsCache.filter((m) => m.config.id !== args.monitorId)
    if (lastOverlayMonitorId === args.monitorId) {
      bridge?.sendEvent('close_overlay', {})
      lastOverlayMonitorId = null
    }
    notifyMonitorsChanged()
    return { ok: true }
  }
  const ids = args.all ? [...monitors.keys()] : args.monitorId ? [args.monitorId] : []
  if (ids.length === 0) return { ok: false, error: 'monitorId required (or all: true)' }
  for (const id of ids) {
    const entry = monitors.get(id)
    if (!entry) continue
    entry.config.paused = true
    stopCameraTickerIfIdle(entry.config.cameraId)
    if (lastOverlayMonitorId === id) {
      bridge?.sendEvent('close_overlay', {})
      lastOverlayMonitorId = null
    }
  }
  await saveMonitors()
  notifyMonitorsChanged()
  return { ok: true, paused: ids }
}

/**
 * Retoma monitoramento(s) pausado(s), reativando a execução e os recursos
 * de câmera necessários.
 */
async function toolResumeMonitoring(args: { monitorId?: string; all?: boolean }): Promise<unknown> {
  if (args.monitorId?.startsWith('auto-')) {
    const autoId = args.monitorId.replace('auto-', '')
    try {
      const res = await hostFetch(`/automations/${autoId}/toggle`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled: true })
      })
      if (!res.ok) {
        bridge?.log(`[vision] resume_monitoring: toggle failed for automation ${autoId} (HTTP ${res.status})`)
        return { ok: false, error: `Falha ao retomar a automação (HTTP ${res.status}).` }
      }
    } catch (err) {
      bridge?.log(`[vision] resume_monitoring: toggle error for automation ${autoId}: ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false, error: 'Falha ao retomar a automação. Backend inacessível.' }
    }
    // Força o próximo sync a rodar já no próximo tick, reativando o monitor o
    // quanto antes (o rate-limit do cache é de 3s).
    lastAutomationSyncTs = 0
    notifyMonitorsChanged()
    return { ok: true }
  }
  const ids = args.all ? [...monitors.keys()] : args.monitorId ? [args.monitorId] : []
  if (ids.length === 0) return { ok: false, error: 'monitorId required (or all: true)' }
  for (const id of ids) {
    const entry = monitors.get(id)
    if (!entry) continue
    entry.config.paused = false
    const camera = findCamera(entry.config.cameraId)
    if (camera) {
      if (camera.source === 'webcam') await ensureWebcamWatch(camera.id)
      if (camera.source === 'ip') await startMjpeg(camera)
      ensureCameraTicker(camera.id)
    }
  }
  await saveMonitors()
  notifyMonitorsChanged()
  return { ok: true, resumed: ids }
}

/** Exclui monitoramento(s) definitivamente, removendo dados e configurações. */
async function toolStopMonitoring(args: { monitorId?: string; all?: boolean }): Promise<unknown> {
  if (args.monitorId?.startsWith('auto-')) {
    const autoId = args.monitorId.replace('auto-', '')
    try {
      const res = await hostFetch(`/automations/${autoId}`, { method: 'DELETE' })
      if (!res.ok) {
        bridge?.log(`[vision] stop_monitoring: delete failed for automation ${autoId} (HTTP ${res.status})`)
        return { ok: false, error: `Falha ao excluir a automação (HTTP ${res.status}).` }
      }
    } catch (err) {
      bridge?.log(`[vision] stop_monitoring: delete error for automation ${autoId}: ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false, error: 'Falha ao excluir a automação. Backend inacessível.' }
    }
    autoMonitorsCache = autoMonitorsCache.filter((m) => m.config.id !== args.monitorId)
    if (lastOverlayMonitorId === args.monitorId) {
      bridge?.sendEvent('close_overlay', {})
      lastOverlayMonitorId = null
    }
    notifyMonitorsChanged()
    return { ok: true }
  }
  const ids = args.all ? [...monitors.keys()] : args.monitorId ? [args.monitorId] : []
  if (ids.length === 0) return { ok: false, error: 'monitorId required (or all: true)' }
  for (const id of ids) {
    const entry = monitors.get(id)
    if (!entry) continue
    monitors.delete(id)
    stopCameraTickerIfIdle(entry.config.cameraId)
    if (lastOverlayMonitorId === id) {
      bridge?.sendEvent('close_overlay', {})
      lastOverlayMonitorId = null
    }
  }
  await saveMonitors()
  notifyMonitorsChanged()
  return { ok: true, stopped: ids }
}

async function getStatusData(): Promise<
  Record<string, { online: boolean; monitors: number; since?: number; metrics?: Record<string, number> }>
> {
  const status: Record<string, { online: boolean; monitors: number; since?: number; metrics?: Record<string, number> }> = {}
  const byCamera = new Map<string, ActiveMonitor[]>()
  for (const m of monitors.values()) {
    if (m.config.paused) continue
    const list = byCamera.get(m.config.cameraId) || []
    list.push(m)
    byCamera.set(m.config.cameraId, list)
  }
  await Promise.all(
    listCameras().map(async (camera) => {
      const active = byCamera.get(camera.id) || []
      const online =
        camera.source === 'webcam'
          ? reloadingCameras.has(camera.id) || isWebcamStreamFresh(camera) || await isWebcamOnline(camera)
          : mjpegStreams.has(camera.id)
      status[camera.id] = {
        online,
        monitors: active.length,
        since: active[0]?.config.createdAt,
        metrics: summaryMetrics(camera.id)
      }
    })
  )
  return status
}

async function fetchHostActiveTriggers(): Promise<any[]> {
  // Usa o mesmo padrão de hostFetch do worker: base MOMAI_API_URL + token
  // MOMAI_SESSION_TOKEN + header x-extension-id. Antes era um fetch puro sem
  // Authorization (o node-core rejeitava sem sessão) e, sem env, varria
  // portas fixas 8050/8100/8000/8200 — o fallback agora é 8050 (node-core).
  try {
    const res = await withTimeout(
      hostFetch('/automations/active-triggers?provider=vision'),
      2500,
      'active-triggers'
    )
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data)) return data
    }
  } catch {
    // Backend inacessível / timeout: lista vazia (sem monitores de automação).
  }
  return []
}

async function toolGetStatus(): Promise<unknown> {
  const status = await getStatusData()
  let autoMonitors: any[] = []
  try {
    const activeTriggers = await fetchHostActiveTriggers()
    if (Array.isArray(activeTriggers)) {
      autoMonitors = activeTriggers.map((auto) => {
        const trig = auto.trigger || {}
        const camCond = (auto.global_conditions || []).find((c: any) => c.field?.toLowerCase().includes('camera'))
        const rawCam = trig.trigger_config?.camera || trig.params?.camera || trig.camera || camCond?.value || ''
        const allCams = [...webcamCache, ...ipCameras]
        const cam = allCams.find((c) => c.id === rawCam || c.name === rawCam) || allCams[0]
        const camId = cam ? cam.id : (rawCam || 'webcam:0')
        const camName = cam ? cam.name : camId
        const labelName = auto.automationName || 'Automação Hub'

        // Ativa o ticker/watch da câmera se necessário
        if (cam && auto.enabled) {
          if (cam.source === 'webcam') void ensureWebcamWatch(cam.id).catch(() => {})
          if (cam.source === 'ip') void startMjpeg(cam).catch(() => {})
          ensureCameraTicker(cam.id)
        }

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
    }
  } catch (err) {
    bridge?.log(`[vision] failed to fetch active automation triggers: ${err}`)
  }

  const localMonitors = [...monitors.values()].map((m) => m.config)
  const combined = [...localMonitors]
  const existingIds = new Set(localMonitors.map((m) => m.id))
  for (const am of autoMonitors) {
    if (!existingIds.has(am.id)) {
      combined.push(am)
    }
  }

  return {
    ok: true,
    monitors: combined,
    cameras: status
  }
}

async function toolListSnapshots(args: { limit?: number }): Promise<unknown> {
  const index = await loadIndex()
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200)
  // Sem imageDataUri embutido (full-res base64 de N snapshots = payload
  // gigante no IPC): a página monta a URL /storage/snapshots/<id>.jpg a partir
  // do snapshotId (mesma convenção do histórico de alertas — C1/M3).
  const items = index.slice(0, limit).map((s) => ({
    id: s.id,
    cameraId: s.cameraId,
    ts: s.ts,
    trigger: s.trigger,
    description: s.description
  }))
  return {
    ok: true,
    snapshots: items
  }
}

async function toolDeleteSnapshot(args: { snapshotId?: string; id?: string }): Promise<unknown> {
  const id = args.snapshotId || args.id
  if (!id) return { ok: false, error: 'snapshotId required' }
  const index = await loadIndex()
  const updated = index.filter((s) => s.id !== id)
  await saveIndex(updated)
  await deleteSnapshotFiles([id])
  return { ok: true, snapshotId: id }
}

async function toolClearSnapshots(): Promise<unknown> {
  const index = await loadIndex()
  const allIds = index.map((s) => s.id)
  await saveIndex([])
  if (allIds.length > 0) {
    await deleteSnapshotFiles(allIds)
  }
  return { ok: true, deletedCount: allIds.length }
}

async function toolListAlerts(args: { limit?: number }): Promise<unknown> {
  const history = await loadAlertsHistory()
  const limit = Math.min(Math.max(Number(args?.limit) || 100, 1), 200)
  return {
    ok: true,
    alerts: history.slice(0, limit)
  }
}

async function toolClearAlerts(): Promise<unknown> {
  await saveAlertsHistory([])
  return { ok: true }
}

// GET /extensions/momai-vision/command get_frame — fetch latest decoded frame
// from an IP camera or camera source (avoids renderer CSP img-src violations).
async function toolGetFrame(args: { cameraId?: string }): Promise<unknown> {
  if (!args.cameraId) return { ok: false, error: 'cameraId required' }
  const camera = findCamera(args.cameraId)
  if (!camera) return { ok: false, error: `unknown camera: ${args.cameraId}` }
  const config = await loadConfig()
  const selectedList = config.selectedCameras || []
  if (!selectedList.includes(camera.id)) {
    return { ok: false, error: `A câmera "${camera.name}" não está selecionada no painel.` }
  }
  if (camera.source === 'ip') {
    await startMjpeg(camera)
  } else if (camera.source === 'webcam') {
    if (!reloadingCameras.has(camera.id)) {
      await ensureWebcamWatch(camera.id)
      // A visible card polls get_frame frequently — reconnect fast (but
      // rate-limited) when the stream stopped, so replug recovery is near
      // immediate without a steady re-acquire loop.
      await reconnectWebcamIfStale(camera)
    }
  }
  const frame = await getCameraFrame(camera)
  if (frame?.jpegBase64) {
    return { ok: true, jpegBase64: frame.jpegBase64 }
  }
  return { ok: false, error: 'no frame available' }
}

// POST /extensions/momai-vision/command reload_camera — tear down and rebuild
// the camera source (webcam host watch or IP/MJPEG/RTSP stream) so a stuck
// camera comes back, then block until a fresh frame is available.
const reloadingCameras = new Set<string>()

// findCamera after a replug: the device may take a moment to show up in
// enumerateDevices, and a replugged USB webcam can change its deviceId while
// keeping the same label. Retry the enumeration briefly and fall back to a
// label match so the card's stale id still resolves.
async function findCameraForReload(desiredId: string, name?: string): Promise<CameraEntry | undefined> {
  for (let i = 0; i < 10; i++) {
    await refreshWebcams()
    const cam = findCamera(desiredId)
    if (cam) return cam
    if (name) {
      const norm = name.trim().toLowerCase()
      const byName = listCameras().find(
        (c) => c.name.trim().toLowerCase() === norm || c.name.trim().toLowerCase().includes(norm)
      )
      if (byName) return byName
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return undefined
}

async function toolReloadCamera(args: { cameraId?: string; cameraName?: string }): Promise<unknown> {
  if (!args.cameraId) return { ok: false, error: 'cameraId required' }
  const camera = await findCameraForReload(args.cameraId, args.cameraName)
  if (!camera) {
    return { ok: false, error: 'Câmera não encontrada. Verifique se ela está conectada.', cameraId: args.cameraId }
  }
  const config = await loadConfig()
  const selectedList = config.selectedCameras || []
  if (!selectedList.includes(camera.id) && !selectedList.includes(args.cameraId)) {
    return { ok: false, error: `A câmera "${camera.name}" não está selecionada no painel.` }
  }
  // Replugged USB webcam with a new deviceId but the same label: adopt the
  // resolved id so get_frame stops failing and the card reconnects now.
  if (camera.source === 'webcam' && !selectedList.includes(camera.id)) {
    await updateConfig((cfg) => {
      cfg.selectedCameras = (cfg.selectedCameras || []).map((id) =>
        id === args.cameraId ? camera.id : id
      )
    })
    for (const m of monitors.values()) {
      if (m.config.cameraId === args.cameraId) m.config.cameraId = camera.id
    }
    void saveMonitors()
  }
  reloadingCameras.add(camera.id)
  try {
    if (camera.source === 'ip') {
      stopMjpeg(camera.id)
      await startMjpeg(camera)
    } else if (camera.source === 'webcam') {
      // If the card held a stale id (replug changed the deviceId), the host
      // may still hold a frozen stream under the OLD id that keeps the device
      // busy — release it so the new id can actually be acquired.
      if (camera.id !== args.cameraId && args.cameraId.startsWith('webcam:')) {
        await stopWebcamWatchById(args.cameraId)
      }
      await stopWebcamWatch(camera)
      await new Promise((r) => setTimeout(r, 150))
      // Reset rate limit timestamp on explicit reload command so reconnection is immediate
      if (camera.deviceId) webcamLastReconnectTs.delete(camera.deviceId)
      await ensureWebcamWatch(camera.id, 24, true)
    } else {
      return { ok: false, error: 'unsupported camera source' }
    }
    let frame: { jpegBase64: string } | null = null
    for (let i = 0; i < 10; i++) {
      frame = await getCameraFrame(camera)
      if (frame) break
      await new Promise((r) => setTimeout(r, 300))
    }
    if (!frame) {
      return { ok: false, error: 'no frame available after reload', cameraId: camera.id }
    }
    return { ok: true, jpegBase64: frame.jpegBase64, cameraId: camera.id }
  } finally {
    reloadingCameras.delete(camera.id)
  }
}

// Último resultado de detecção por câmera (frame_pump). O pump do card NUNCA
// pode esperar a detecção: com o mutex GLOBAL do engine (acquireEngine)
// disputado por tickers de monitor, pumps de outras câmeras e o poll (uma
// câmera RTSP/FFmpeg pode segurar o child WASM por muito tempo), um frame_pump
// que espera o engine estoura o Promise.race de 8s da página e o card fica sem
// boxes até trocar de aba. Por isso todo frame_pump responde IMEDIATAMENTE com
// o último resultado conhecido (cache) e a detecção nova roda em background,
// atualizando o cache + SSE (vision_detections) quando terminar — o próximo
// frame_pump já devolve boxes frescos.
const lastPumpBoxes = new Map<string, Detection[]>()

// Grace do PRIMEIRO frame_pump de uma câmera (sem cache): aguarda a detecção em
// voo por até este valor para o primeiro frame já abrir com boxes. 1000ms cobre
// uma inferência aquecida (warmup roda no boot); 2.5s deixava o primeiro frame
// sem boxes por tempo demais. Bem abaixo do timeout de 4s do pump — nenhum
// ciclo de pump espera mais que isto. Com YOLO11s (~300-600ms inferência),
// 1000ms garante que o primeiro frame já tenha boxes.
const FRAME_PUMP_FIRST_GRACE_MS = 1000

// POST /extensions/momai-vision/frame — the dashboard page pumps webcam & IP camera
// frames for live bounding boxes.
async function toolFramePump(args: { jpegBase64?: string; cameraId?: string }): Promise<unknown> {
  if (!args.jpegBase64) return { ok: false, error: 'jpegBase64 required' }
  const cameraId = args.cameraId || 'page'
  const cached = lastPumpBoxes.get(cameraId)

  const publish = (result: EngineResult): void => {
    if (result.error) {
      bridge?.log(`[vision] frame_pump detect error: ${result.error}`)
      // Publica detecção vazia via SSE para que a UI saiba limpar os boxes
      // (hold expira após 1.5s e limpa). Sem isso, erros silenciosos
      // congelam os boxes no último estado válido indefinidamente.
      bridge?.sendEvent('vision_detections', {
        cameraId,
        ts: Date.now(),
        detections: []
      })
      return
    }
    const detections = result.boxes || []
    lastPumpBoxes.set(cameraId, detections)
    metricFor(cameraId).renderAt = Date.now()
    metricFor(cameraId).framesIn++
    bridge?.sendEvent('vision_detections', {
      cameraId,
      ts: Date.now(),
      detections: detections.map((d) => ({
        className: d.className,
        confidence: d.confidence,
        x1: d.x1,
        y1: d.y1,
        x2: d.x2,
        y2: d.y2
      }))
    })
  }

  // A detecção nova SEMPRE roda em background (latest-wins por câmera: cada
  // frame_pump substitui o frame pendente e resolve quando a próxima inferência
  // completar). O caller NUNCA espera o engine — o pump não pode ficar preso
  // atrás do mutex global.
  //
  // Mutex global indisponível (outra inferência rodando ou esperando o lock)
  // ANTES desta chamada? Se sim, nem o grace do primeiro frame compensa: a
  // detecção em background fica presa atrás do mutex e o cache nunca popula.
  // Responde IMEDIATAMENTE com o último resultado conhecido (ou []) +
  // engineBusy:true, para a UI manter os boxes atuais e saber que o engine
  // está ocupado — em vez de devolver [] após o grace para sempre.
  const engineBusy = engineInferenceCount > 0

  const pending = engineDetectSerial(cameraId, args.jpegBase64)
    .then(publish)
    .catch((err: unknown) => {
      bridge?.log(`[vision] frame_pump background detect failed: ${err instanceof Error ? err.message : String(err)}`)
    })

  if (engineBusy) {
    bridge?.log('[vision-diag] frame_pump engine busy, returning cache')
    return { ok: true, detections: cached || [], engineBusy: true, stale: true }
  }

  if (cached !== undefined) {
    // Engine NÃO está busy: aguarda a detecção em voo — com o engine livre,
    // a inferência típica 640x640 é ~300ms, abaixo do grace de 1s. Isso garante
    // que a UI receba boxes FRESCOS em vez de cache stale, eliminando o
    // "congelamento" de boxes. Só retorna cache se o engine realmente não
    // respondeu dentro do grace (máquina sobrecarregada).
    const fresh = await Promise.race([
      pending.then(() => lastPumpBoxes.get(cameraId)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FRAME_PUMP_FIRST_GRACE_MS))
    ])
    return { ok: true, detections: fresh ?? cached, stale: fresh === null }
  }

  // Primeiro frame (sem cache): aguarda a detecção em voo por um curto grace.
  // Se o engine estiver frio/ocupado além disso, responde [] (o primeiro frame
  // desenha o vídeo sem boxes; o próximo ciclo já tem cache). Nunca mais que o
  // grace — o timeout de 8s do pump nunca é atingido.
  const first = await Promise.race([
    pending.then(() => lastPumpBoxes.get(cameraId)),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), FRAME_PUMP_FIRST_GRACE_MS))
  ])
  return { ok: true, detections: first || [] }
}

// POST /extensions/momai-vision/configure — settings from the dashboard page.
async function toolConfigure(args: {
  retentionDays?: number
  maxSnapshots?: number
  trackingMode?: 'fluid' | 'balanced' | 'economy'
  ipCameras?: Array<{ id: string; name: string; url: string }>
  selectedCameras?: string[]
  sendActions?: MonitorAction[]
}): Promise<unknown> {
  // SSRF: valida cada URL de câmera IP ANTES de persistir (esquema http/https/
  // rtsp, bloqueia loopback/link-local/metadata + resolução de hostname). Uma
  // URL inválida rejeita o configure inteiro — a página mostra o erro no banner.
  if (Array.isArray(args.ipCameras)) {
    for (const cam of args.ipCameras) {
      if (!cam || typeof cam.url !== 'string') {
        return { ok: false, error: 'URL de câmera IP inválida' }
      }
      const validation = await assertCameraUrlSafe(cam.url)
      if (!validation.ok) {
        return { ok: false, error: `URL de câmera IP bloqueada (${cam.name || cam.url}): ${validation.error}` }
      }
    }
  }

  // Read-modify-write serializado (M8): duas gravações concorrentes do config
  // (configure do modal + poll) não podem perder campos uma da outra.
  const config = await updateConfig((cfg) => {
    if (args.retentionDays !== undefined) cfg.retentionDays = args.retentionDays
    if (args.maxSnapshots !== undefined) cfg.maxSnapshots = args.maxSnapshots
    if (args.trackingMode !== undefined) cfg.trackingMode = args.trackingMode
    if (args.ipCameras !== undefined) cfg.ipCameras = args.ipCameras
    if (args.selectedCameras !== undefined) cfg.selectedCameras = args.selectedCameras
    if (args.sendActions !== undefined) cfg.sendActions = args.sendActions
  })
  if (args.ipCameras !== undefined) {
    const previousIpIds = new Set(ipCameras.map((c) => c.id))
    await syncIpCameras()
    // Stop MJPEG/RTSP streams for IP cameras that were removed from the
    // registry, so they stop consuming the camera once unregistered.
    for (const removedId of previousIpIds) {
      if (!ipCameras.some((c) => c.id === removedId)) stopMjpeg(removedId)
    }
    // Start MJPEG streams for IP cameras that have active monitors.
    for (const cam of ipCameras) {
      const hasMonitor = [...monitors.values()].some((m) => m.config.cameraId === cam.id)
      if (hasMonitor) await startMjpeg(cam)
    }
  }
  if (args.selectedCameras !== undefined || args.ipCameras !== undefined) {
    void syncWebcamWatches().catch(() => {})
  }
  return { ok: true, config }
}

function describePlan(camera: CameraEntry, triggers: Trigger[]): string {
  const parts = triggers.map((t) => {
    switch (t.type) {
      case 'motion':
        return `movimento (sensibilidade ${t.sensitivity || 'med'})`
      case 'object':
        return `${t.present === false ? 'ausência de' : 'detecção de'} ${t.className}`
      case 'presence':
        return `presença de ${t.className || 'pessoa'} (${t.event}${t.windowSec ? `, ${t.windowSec}s` : ''})`
      case 'absence':
        return `ausência de ${t.className || 'pessoa'} (${t.event})`
      case 'scene':
        return `pergunta: "${t.question}"`
      case 'periodic':
        return `resumo periódico a cada ${t.everySec}s`
      default:
        return (t as { type: string }).type
    }
  })
  return `Vou monitorar "${camera.name}" para: ${parts.join('; ')}. Alertas com snapshot.`
}

const SEND_TARGET_NAMES: Record<string, string> = {
  whatsapp: 'WhatsApp',
  momaismarthome: 'casa inteligente',
  'momai-vision': 'MomAI Vision'
}

function describeSendAction(a: MonitorAction): string {
  const args = (a.args || {}) as Record<string, unknown>
  const targetName = SEND_TARGET_NAMES[a.target] || a.target
  const contact = typeof args.contact === 'string' && args.contact.trim() ? args.contact.trim() : null
  const device = typeof args.device_name === 'string' && args.device_name.trim() ? args.device_name.trim() : null
  const action = typeof args.action === 'string' ? args.action : null
  switch (a.tool) {
    case 'send_message':
      return contact
        ? `enviarei uma mensagem para ${contact} no ${targetName}`
        : `enviarei uma mensagem no ${targetName}`
    case 'control_device': {
      const verb =
        action === 'on' ? 'ligarei' : action === 'off' ? 'desligarei' : action === 'toggle' ? 'alternarei' : 'acionarei'
      return device ? `${verb} ${device}` : `${verb} o dispositivo`
    }
    case 'set_light_color':
      return device ? `ajustarei a cor de ${device}` : `ajustarei a cor da luz`
    case 'capture_snapshot':
      return `tirarei um print de registro`
    default:
      return `executarei a ação ${a.tool} em ${targetName}`
  }
}

/**
 * Descreve os envios configurados (actions) em linguagem natural para o LLM
 * anunciar ao criar/editar um monitoramento.
 */
function describeSendActions(actions: MonitorAction[] | undefined): string {
  if (!actions || actions.length === 0) return ''
  const phrases = actions.map(describeSendAction)
  return `\nQuando o alerta disparar, ${phrases.join(' e ')}.`
}

async function describeSendActionsSuffix(actions: MonitorAction[] | undefined): Promise<string> {
  const config = await loadConfig().catch(() => ({}) as StoredConfig)
  const merged = ([] as MonitorAction[]).concat(actions || [], config.sendActions || []).filter(Boolean)
  return describeSendActions(merged)
}

// ---------------------------------------------------------------------------
// Restore & lifecycle
// ---------------------------------------------------------------------------

async function restoreMonitors(): Promise<void> {
  const saved = (await bridge!.storage.get('monitors')) as MonitorConfig[] | null
  if (!Array.isArray(saved)) return
  // Limitado: o restore roda no boot do worker (via ensureInitialized) e não
  // pode segurar os primeiros comandos enquanto o bridge da câmera está lento.
  await withTimeout(refreshWebcams(), 3000, 'restore refresh').catch(() => {})
  for (const config of saved) {
    if (!config.id || !config.cameraId) continue
    // Migrate monitors stored with a raw name/label to the canonical id, so
    // the ticker/status lookups match.
    const cam = findCamera(config.cameraId)
    if (cam) config.cameraId = cam.id
    monitors.set(config.id, { config, state: createMonitorState() })
  }
  const cameras = new Set(
    [...monitors.values()]
      .filter((m) => !m.config.paused)
      .map((m) => m.config.cameraId)
  )
  await syncWebcamWatches().catch(() => {})
  for (const cameraId of cameras) {
    const camera = findCamera(cameraId)
    if (!camera) continue
    if (camera.source === 'webcam') await ensureWebcamWatch(cameraId)
    if (camera.source === 'ip') await startMjpeg(camera)
    ensureCameraTicker(cameraId)
  }
  if (monitors.size > 0) {
    bridge?.log(`[vision] restored ${monitors.size} monitor(s)`)
  }
}

// Pré-aquece uma webcam selecionada no modal "Adicionar câmera": inicia o
// start-watch do host (getUserMedia) ANTES do usuário confirmar, para a
// câmera já estar entregando frames na hora de "Adicionar" — próximo do
// comportamento de um navegador que inicializa a câmera sob demanda.
async function toolWarmWebcam(args: { cameraId?: string }): Promise<unknown> {
  const id = args?.cameraId
  if (!id) return { ok: false, error: 'missing cameraId' }
  const camera = findCamera(id)
  if (!camera || camera.source !== 'webcam') return { ok: false, error: 'not a webcam' }
  void ensureWebcamWatch(id).catch(() => {})
  return { ok: true }
}

const tools: Record<string, (args: any) => Promise<unknown>> = {
  list_cameras: toolListCameras,
  capture_snapshot: toolCaptureSnapshot,
  describe_snapshot: toolDescribeSnapshot,
  delete_snapshot: toolDeleteSnapshot,
  clear_snapshots: toolClearSnapshots,
  start_monitoring: toolStartMonitoring,
  update_monitoring: toolUpdateMonitoring,
  pause_monitoring: toolPauseMonitoring,
  resume_monitoring: toolResumeMonitoring,
  stop_monitoring: toolStopMonitoring,
  get_status: toolGetStatus,
  list_snapshots: toolListSnapshots,
  list_alerts: toolListAlerts,
  clear_alerts: toolClearAlerts,
  get_frame: toolGetFrame,
  reload_camera: toolReloadCamera,
  frame_pump: toolFramePump,
  configure: toolConfigure,
  warm_webcam: toolWarmWebcam
}

let initPromise: Promise<void> | null = null

// Orçamento total do restore: os PRIMEIROS comandos (ex.: configure do modal
// "Adicionar câmera") não podem esperar o restore inteiro — ele roda em
// background e o status/monitores convergem nos polls seguintes. Antes, um
// bridge de câmera lento no boot segurava todo comando por 4+ minutos.
const INIT_BUDGET_MS = 6000

function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    // Recovery net começa IMEDIATAMENTE (não espera o restore): os watches de
    // webcam e os monitores de automação são mantidos mesmo com um restore
    // lento em background.
    void syncAutomationMonitors().catch(() => {})
    setInterval(() => {
      void syncWebcamWatches().catch(() => {})
      void syncAutomationMonitors().catch(() => {})
    }, 5000)
    // TTL dos streams MJPEG/RTSP: derruba streams de câmeras IP sem consumidor
    // ativo (item A2) — não deixa ffmpeg/fetch contínuo vazando para sempre.
    setInterval(() => {
      void sweepMjpegStreams().catch(() => {})
    }, 30000)
    initPromise = withTimeout(
      restoreMonitors().catch((err) => {
        bridge?.log(`[vision] restore failed: ${err instanceof Error ? err.message : String(err)}`)
      }),
      INIT_BUDGET_MS,
      'restoreMonitors'
    ).catch(() => {})
  }
  return initPromise
}

// Warmup do engine YOLO (WASM 13MB + ONNX 10MB). O carregamento síncrono no
// child bloqueia o event loop por ~10-60s na primeira vez. A promise é criada
// no boot, antes do worker anunciar `ready`, para não existir uma janela em
// que o primeiro frame_pump chegue e ainda não tenha warmup para acompanhar.
let warmupDone: Promise<void> | null = null

function startWarmup(): Promise<void> {
  if (!warmupDone) {
    warmupDone = warmupEngine().catch((err: unknown) => {
      bridge?.log(`[vision] engine warmup failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }
  return warmupDone
}

/**
 * Startup init — called by the worker process right after `ready`, so restored
 * monitors and webcam watches resume even if no page/chat tool call ever comes.
 */
export async function init(momai: MomaiBridge): Promise<void> {
  bridge = momai
  // Restore de monitores pode levar até INIT_BUDGET_MS. Ele não deve atrasar o
  // carregamento do modelo: o card já pode enviar seu primeiro frame enquanto
  // esse restore roda em background.
  void ensureInitialized()
  void startWarmup()
}

export default {
  async execute(payload: { toolName?: string; args?: Record<string, unknown>; momai?: MomaiBridge }): Promise<unknown> {
    bridge = payload.momai || bridge
    const toolName = payload.toolName
    const fn = tools[toolName || '']
    if (!fn) {
      return { ok: false, error: `unknown tool: ${toolName}` }
    }
    try {
      if (toolName === 'frame_pump') {
        // O frame_pump já possui grace curto + publicação SSE em background.
        // Bloqueá-lo no restore/warmup faz o timeout de 8 s da página vencer
        // antes de toolFramePump conseguir iniciar a inferência.
        void ensureInitialized()
        void startWarmup()
      } else {
        await ensureInitialized()
        await startWarmup()
      }
      return await fn((payload.args || {}) as any)
    } catch (err) {
      bridge?.log(`[vision] tool ${toolName} error: ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// Worker teardown: stop engine + MJPEG streams when the process exits.
process.on('exit', () => {
  stopEngine()
})
