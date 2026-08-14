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
import { decode } from 'jpeg-js'
import { MotionGate } from './vision/motion'
import { ptLabel } from './vision/labels'
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
const API_URL = process.env.MOMAI_API_URL || 'http://127.0.0.1:8000'
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
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const data = await hostJson<{ cameras: Array<{ deviceId: string; label: string }> }>(
        '/media/camera/list'
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
const mjpegStreams = new Map<string, { controller: AbortController; latest: string | null; latestTs: number }>()
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

  if (camera.url && camera.url.startsWith('rtsp://')) {
    await startRtspStream(camera)
    return
  }

  const controller = new AbortController()
  const entry: { controller: AbortController; latest: string | null; latestTs: number } = {
    controller,
    latest: null,
    latestTs: 0
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
            entry.latest = Buffer.from(arrayBuffer).toString('base64')
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
                  entry.latest = Buffer.from(buf).toString('base64')
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
          let streamBuf = Buffer.alloc(0)
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) {
              streamBuf = Buffer.concat([streamBuf, Buffer.from(value)])
              while (true) {
                const soi = streamBuf.indexOf(Buffer.from([0xff, 0xd8]))
                if (soi === -1) break
                const eoi = streamBuf.indexOf(Buffer.from([0xff, 0xd9]), soi + 2)
                if (eoi === -1) break
                const frame = streamBuf.subarray(soi, eoi + 2)
                streamBuf = streamBuf.subarray(eoi + 2)
                entry.latest = frame.toString('base64')
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
  const entry: { controller: AbortController; latest: string | null; latestTs: number } = {
    controller: new AbortController(),
    latest: null,
    latestTs: 0
  }
  mjpegStreams.set(camera.id, entry)

  const { spawn } = await import('node:child_process')
  bridge?.log(`[vision] RTSP: connecting via FFmpeg to ${camera.name}...`)

  // FFmpeg handles RTSP demuxing directly (UDP, TCP, Digest/Basic auth, H.264/H.265)
  // and pipes MJPEG frames continuously to stdout.
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'fatal',
    '-fflags', '+nobuffer+genpts+discardcorrupt',
    '-flags', 'low_delay',
    '-i', url,
    '-vf', 'fps=24,scale=640:-2',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-q:v', '6',
    'pipe:1'
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  const session: RtspSession = { ffmpeg, alive: true }
  rtspSessions.set(camera.id, session)

  let jpegBuf = Buffer.alloc(0)
  ffmpeg.stdout!.on('data', (chunk: Buffer) => {
    jpegBuf = Buffer.concat([jpegBuf, chunk])
    while (true) {
      const soi = jpegBuf.indexOf(Buffer.from([0xff, 0xd8]))
      if (soi === -1) break
      const eoi = jpegBuf.indexOf(Buffer.from([0xff, 0xd9]), soi + 2)
      if (eoi === -1) break
      const frame = jpegBuf.subarray(soi, eoi + 2)
      jpegBuf = jpegBuf.subarray(eoi + 2)
      entry.latest = frame.toString('base64')
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

async function getCameraFrame(camera: CameraEntry): Promise<{ jpegBase64: string; width?: number; height?: number } | null> {
  if (camera.source === 'ip') {
    const entry = mjpegStreams.get(camera.id)
    if (!entry || !entry.latest) return null
    return { jpegBase64: entry.latest }
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

async function ensureEngine(): Promise<EngineProcess> {
  if (engine && engine.child.connected) return engine
  const { spawn } = await import('node:child_process')
  const enginePath = await requireEnginePath()
  const child = spawn(process.execPath, [enginePath], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env }
  })
  const pending = new Map<string, { resolve: (v: EngineResult) => void; reject: (e: Error) => void }>()
  const engineProcess: EngineProcess = { child, pending, nextId: 1, ready: Promise.resolve() }
  engineProcess.ready = new Promise<void>((resolve) => {
    child.on('message', (msg: unknown) => {
      if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'ready') resolve()
    })
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
  })
  child.on('error', (err) => {
    for (const [, entry] of pending) entry.reject(err)
    pending.clear()
    engine = null
  })
  engine = engineProcess
  await engineProcess.ready
  return engineProcess
}

async function engineDetect(jpegBase64: string): Promise<EngineResult> {
  const eng = await ensureEngine()
  const id = `d${eng.nextId++}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      eng.pending.delete(id)
      reject(new Error('CV engine detect timed out'))
    }, 30000)
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

// Semáforo global para o engine: o sidecar é WASM single-thread, então
// inferências concorrentes (N frame_pump da página + M monitors) se
// acumulam no WASM, o motor fica a 100% de CPU e o sistema inteiro
// (frames incluídos) engasga conforme o uso. Serializar para 1 inferência
// por vez elimina o acúmulo; a detecção fica mais lenta, mas o preview
// continua fluido.
let engineQueue: Promise<unknown> = Promise.resolve()
function engineDetectSerial(jpegBase64: string): Promise<EngineResult> {
  const run = engineQueue.then(() => engineDetect(jpegBase64))
  engineQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
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

// ---------------------------------------------------------------------------
// Vision (local LLM)
// ---------------------------------------------------------------------------

async function describeImage(jpegBase64: string, prompt: string): Promise<string> {
  const res = await hostFetch('/extensions/llm/vision', {
    method: 'POST',
    body: JSON.stringify({ image_base64: jpegBase64, prompt, max_tokens: 256 })
  })
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
    const storageDir = path.join(process.env.MOMAI_DATA_DIR || '', 'extensions', SKILL_ID, 'snapshots')
    for (const id of ids) {
      try {
        await fs.unlink(path.join(storageDir, `${id}.jpg`))
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

function ensureCameraTicker(cameraId: string): void {
  if (cameraTickers.has(cameraId)) return
  const timer = setInterval(() => {
    void tickCamera(cameraId)
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
    void hostFetch('/media/camera/stop-watch', {
      method: 'POST',
      body: JSON.stringify({ deviceId: camera.deviceId })
    }).catch(() => {})
  }
  motionGates.delete(cameraId)
}

interface TickFrame {
  jpegBase64: string
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
      const result = await engineDetectSerial(frame.jpegBase64)
      detections = result.boxes || []
      if (result.error) bridge?.log(`[vision] detect error: ${result.error}`)
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

  const imageDataUri = `data:image/jpeg;base64,${jpegBase64}`
  const alertPayload: PersistedAlert = {
    cameraId: config.cameraId,
    cameraName: config.cameraName || config.cameraId,
    monitorId: config.id,
    monitorLabel: config.label,
    triggeredBy: alert.triggeredBy,
    confidence: alert.confidence,
    className: alert.className,
    boxes: alert.boxes || [],
    snapshotId: snapshot?.id,
    ts: alert.ts,
    description,
    imageDataUri,
    actions: mergedActions
  }

  const data = {
    type: 'vision_alert',
    data: {
      ...alertPayload,
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
const WEB_FRAME_STALE_MS = 5000
const WEB_RECONNECT_MIN_MS = 20000
const webcamLastReconnectTs = new Map<string, number>() // deviceId -> ts

async function stopWebcamWatch(camera: CameraEntry): Promise<void> {
  if (!camera || camera.source !== 'webcam' || !camera.deviceId) return
  webcamWatches.delete(camera.id)
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
  await hostFetch('/media/camera/stop-watch', {
    method: 'POST',
    body: JSON.stringify({ deviceId })
  }).catch(() => {})
}

async function isWebcamOnline(camera: CameraEntry): Promise<boolean> {
  if (!camera || camera.source !== 'webcam' || !camera.deviceId) return false
  try {
    const data = await hostJson<{ ts?: number }>(
      `/media/camera/frame/${encodeURIComponent(camera.deviceId)}`
    )
    return !!data?.ts && Date.now() - data.ts < WEB_FRAME_STALE_MS
  } catch {
    return false
  }
}

// Re-acquire a selected webcam's host stream when it stopped delivering
// frames (e.g. after an unplug/replug), but at most once per
// WEB_RECONNECT_MIN_MS. A healthy camera that IS producing frames is never
// touched �?" this is what keeps it from blinking/toggling.
const webcamLastOnlineCheck = new Map<string, number>() // deviceId -> ts
async function reconnectWebcamIfStale(camera: CameraEntry): Promise<void> {
  if (!camera || camera.source !== 'webcam' || !camera.deviceId) return
  // O isWebcamOnline baixa o FRAME INTEIRO do node-core só para checar o ts.
  // Rodava a cada get_frame (66ms × N câmeras) — agora no máximo 1x/3s por
  // câmera. Isso corta quase metade do tráfego de frames do preview.
  const lastCheck = webcamLastOnlineCheck.get(camera.deviceId) || 0
  if (Date.now() - lastCheck < 3000) return
  webcamLastOnlineCheck.set(camera.deviceId, Date.now())
  if (await isWebcamOnline(camera)) return
  const lastTry = webcamLastReconnectTs.get(camera.deviceId) || 0
  if (Date.now() - lastTry < WEB_RECONNECT_MIN_MS) return
  webcamLastReconnectTs.set(camera.deviceId, Date.now())
  await stopWebcamWatch(camera)
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
    await hostFetch('/media/camera/start-watch', {
      method: 'POST',
      body: JSON.stringify({ deviceId: camera.deviceId, fps })
    })
    webcamWatches.add(cameraId)
  } catch {
    // device busy (e.g. page preview) — retried by syncWebcamWatches
  }
}

// A USB webcam replug can change its deviceId while keeping the same label.
// Remap a selected/monitored `webcam:<oldId>` to the new `webcam:<newId>` when
// exactly one selected webcam went missing and exactly one unselected webcam
// appeared — the "replugged the same camera" case. Ambiguous cases are skipped.
function remapRepluggedWebcamIds(config: StoredConfig): void {
  const selected = (config.selectedCameras || []).filter((id) => id.startsWith('webcam:'))
  const missing = selected.filter((id) => !webcamCache.some((c) => c.id === id))
  const unselectedNew = webcamCache.filter((c) => c.source === 'webcam' && !selected.includes(c.id))
  if (missing.length !== 1 || unselectedNew.length !== 1) return
  const newId = unselectedNew[0].id
  if (!missing[0] || newId === missing[0]) return
  const remap = new Map<string, string>([[missing[0], newId]])
  config.selectedCameras = (config.selectedCameras || []).map((id) => remap.get(id) || id)
  for (const m of monitors.values()) {
    if (remap.has(m.config.cameraId)) m.config.cameraId = remap.get(m.config.cameraId)!
  }
  void saveMonitors()
  void bridge!.storage.set('config', config)
}

// Keep host watches alive for webcams that are selected in the dashboard or
// being monitored, so cameras stay on even after the Vision page closes.
async function syncWebcamWatches(): Promise<void> {
  const config = await loadConfig()
  // Se a lista de webcams está vazia (ex.: 403 transitório no boot, antes de o
  // skill ser carregado), re-tenta a listagem — senão os watches nunca
  // iniciam e a webcam fica sem preview até reiniciar o app.
  if (webcamCache.length === 0) {
    await refreshWebcams().catch(() => {})
  }
  // If the user replugged a USB webcam (deviceId changed, label stable), remap
  // the persisted selection so the card reconnects to the new device.
  remapRepluggedWebcamIds(config)
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
    // change). A healthy camera is left untouched — no start/stop churn, so it
    // does not blink. A camera being manually reloaded right now is also left
    // alone: the reload is already rebuilding its stream.
    const cam = findCamera(id)
    if (cam && cam.source === 'webcam' && !reloadingCameras.has(id)) await reconnectWebcamIfStale(cam)
  }
}

async function toolListCameras(): Promise<unknown> {
  await refreshWebcams()
  await syncIpCameras().catch(() => {})
  for (const cam of ipCameras) {
    await startMjpeg(cam).catch(() => {})
  }
  await syncWebcamWatches().catch(() => {})
  const cameras = listCameras()
  const status = await getStatusData()
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
      imageDataUri: `data:image/jpeg;base64,${frame.jpegBase64}`
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
  const description = await describeImage(
    jpegBase64,
    'Descreva a cena nesta imagem em 1-2 frases, em portugues.'
  ).catch((err) => (err as Error).message === 'vision_unavailable' ? '' : '')
  return { ok: true, snapshotId: args.snapshotId, description }
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
    notify: args.notify,
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

  if (args.notify !== undefined) {
    entry.config.notify = args.notify
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

async function getStatusData(): Promise<Record<string, { online: boolean; monitors: number; since?: number }>> {
  const status: Record<string, { online: boolean; monitors: number; since?: number }> = {}
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
          ? reloadingCameras.has(camera.id) || await isWebcamOnline(camera)
          : mjpegStreams.has(camera.id)
      status[camera.id] = {
        online,
        monitors: active.length,
        since: active[0]?.config.createdAt
      }
    })
  )
  return status
}

async function fetchHostActiveTriggers(): Promise<any[]> {
  const configured = [
    process.env.MOMAI_API_URL,
    process.env.MOMAI_NODE_CORE_PORT ? `http://127.0.0.1:${process.env.MOMAI_NODE_CORE_PORT}` : null
  ].filter(Boolean) as string[]

  const candidateUrls = configured.length > 0
    ? configured
    : (process.env.VITEST
        ? []
        : [
            'http://127.0.0.1:8050',
            'http://127.0.0.1:8100',
            'http://127.0.0.1:8000',
            'http://127.0.0.1:8200'
          ])

  for (const baseUrl of candidateUrls) {
    try {
      const cleanUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
      const res = await fetch(`${cleanUrl}/automations/active-triggers?provider=vision`)
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data)) return data
      }
    } catch {}
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
  const items = await Promise.all(
    index.slice(0, limit).map(async (s) => {
      const base64 = await readSnapshotBase64(s.id)
      return {
        id: s.id,
        cameraId: s.cameraId,
        ts: s.ts,
        trigger: s.trigger,
        description: s.description,
        imageDataUri: base64 ? `data:image/jpeg;base64,${base64}` : null
      }
    })
  )
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
    config.selectedCameras = (config.selectedCameras || []).map((id) =>
      id === args.cameraId ? camera.id : id
    )
    for (const m of monitors.values()) {
      if (m.config.cameraId === args.cameraId) m.config.cameraId = camera.id
    }
    void saveMonitors()
    await bridge?.storage?.set('config', config).catch(() => {})
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

// POST /extensions/momai-vision/frame — the dashboard page pumps webcam & IP camera
// frames for live bounding boxes.
async function toolFramePump(args: { jpegBase64?: string; cameraId?: string }): Promise<unknown> {
  if (!args.jpegBase64) return { ok: false, error: 'jpegBase64 required' }
  const cameraId = args.cameraId || 'page'
  try {
    const result = await engineDetectSerial(args.jpegBase64)
    if (result.error) return { ok: false, error: result.error }
    const detections = result.boxes || []
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
    return { ok: true, detections }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
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
  const current = ((await bridge!.storage.get('config')) || {}) as Record<string, unknown>
  const config = {
    ...current,
    ...(args.retentionDays !== undefined ? { retentionDays: args.retentionDays } : {}),
    ...(args.maxSnapshots !== undefined ? { maxSnapshots: args.maxSnapshots } : {}),
    ...(args.trackingMode !== undefined ? { trackingMode: args.trackingMode } : {}),
    ...(args.ipCameras !== undefined ? { ipCameras: args.ipCameras } : {}),
    ...(args.selectedCameras !== undefined ? { selectedCameras: args.selectedCameras } : {}),
    ...(args.sendActions !== undefined ? { sendActions: args.sendActions } : {})
  }
  await bridge!.storage.set('config', config)
  invalidateConfigCache()
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
  await refreshWebcams()
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
  configure: toolConfigure
}

let initPromise: Promise<void> | null = null

function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      // Restore blocks the first call so status/planning see restored monitors
      // immediately (no race between restore and get_status).
      await restoreMonitors().catch((err) => {
        bridge?.log(`[vision] restore failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      // Recovery net: keep webcam watches and automation monitors in sync even when the page is closed.
      void syncAutomationMonitors().catch(() => {})
      setInterval(() => {
        void syncWebcamWatches().catch(() => {})
        void syncAutomationMonitors().catch(() => {})
      }, 5000)
    })()
  }
  return initPromise
}

/**
 * Startup init — called by the worker process right after `ready`, so restored
 * monitors and webcam watches resume even if no page/chat tool call ever comes.
 */
export async function init(momai: MomaiBridge): Promise<void> {
  bridge = momai
  await ensureInitialized()
}

export default {
  async execute(payload: { toolName?: string; args?: Record<string, unknown>; momai?: MomaiBridge }): Promise<unknown> {
    bridge = payload.momai || bridge
    await ensureInitialized()
    const toolName = payload.toolName
    const fn = tools[toolName || '']
    if (!fn) {
      return { ok: false, error: `unknown tool: ${toolName}` }
    }
    try {
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
