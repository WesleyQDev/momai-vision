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
import {
  createMonitorState,
  evaluateMonitor,
  applySceneAnswer,
  inSchedule,
  type MonitorConfig,
  type MonitorState,
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
  defaultCamera?: string | null
  retentionDays?: number
  maxSnapshots?: number
  trackingMode?: 'fluid' | 'balanced' | 'economy'
  ipCameras?: Array<{ id: string; name: string; url: string }>
}

async function loadConfig(): Promise<StoredConfig> {
  const config = ((await bridge!.storage.get('config')) || {}) as StoredConfig
  return config || {}
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
  try {
    const data = await hostJson<{ cameras: Array<{ deviceId: string; label: string }> }>(
      '/media/camera/list'
    )
    webcamCache = (data.cameras || []).map((cam) => ({
      id: `webcam:${cam.deviceId}`,
      name: cam.label || 'Webcam',
      source: 'webcam',
      deviceId: cam.deviceId
    }))
  } catch (err) {
    bridge?.log(`[vision] webcam list failed: ${err instanceof Error ? err.message : String(err)}`)
    webcamCache = []
  }
}

function listCameras(): CameraEntry[] {
  return [...webcamCache, ...ipCameras]
}

function findCamera(id: string): CameraEntry | undefined {
  return listCameras().find((c) => c.id === id)
}

// MJPEG stream client — keeps the latest frame in memory, nothing on disk.
const mjpegStreams = new Map<string, { controller: AbortController; latest: string | null; latestTs: number }>()
async function startMjpeg(camera: CameraEntry): Promise<void> {
  if (mjpegStreams.has(camera.id)) return
  const controller = new AbortController()
  const entry: { controller: AbortController; latest: string | null; latestTs: number } = {
    controller,
    latest: null,
    latestTs: 0
  }
  mjpegStreams.set(camera.id, entry)
  void (async () => {
    try {
      const res = await fetch(camera.url!, { signal: controller.signal })
      if (!res.ok || !res.body) throw new Error(`MJPEG ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let boundary = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        if (!boundary) {
          const match = buffer.match(/^--[a-zA-Z0-9-]+/)
          if (match) boundary = match[0]
          if (!boundary) {
            const marker = buffer.indexOf('\r\n')
            if (marker === -1) continue
            const line = buffer.slice(0, marker)
            buffer = buffer.slice(marker + 2)
            if (line.startsWith('--')) boundary = line
          }
        }
        if (!boundary) continue
        const parts = buffer.split(boundary)
        buffer = parts.pop() || ''
        for (const part of parts) {
          const headerEnd = part.indexOf('\r\n\r\n')
          if (headerEnd === -1) continue
          const header = part.slice(0, headerEnd)
          const body = part.slice(headerEnd + 4)
          if (header.toLowerCase().includes('content-type: image/jpeg') && body.length > 100) {
            entry.latest = Buffer.from(body, 'binary').toString('base64')
            entry.latestTs = Date.now()
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        bridge?.log(`[vision] MJPEG ${camera.name} stopped: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      mjpegStreams.delete(camera.id)
    }
  })()
}

function stopMjpeg(cameraId: string): void {
  const entry = mjpegStreams.get(cameraId)
  if (entry) {
    entry.controller.abort()
    mjpegStreams.delete(cameraId)
  }
}

async function getCameraFrame(camera: CameraEntry): Promise<{ jpegBase64: string; width?: number; height?: number } | null> {
  if (camera.source === 'ip') {
    const entry = mjpegStreams.get(camera.id)
    if (!entry || !entry.latest) return null
    return { jpegBase64: entry.latest }
  }
  if (!camera.deviceId) return null
  try {
    const data = await hostJson<{ jpegBase64: string; width?: number; height?: number }>(
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

function stopCameraTickerIfIdle(cameraId: string): void {
  const active = [...monitors.values()].some((m) => m.config.cameraId === cameraId)
  if (active) return
  const timer = cameraTickers.get(cameraId)
  if (timer) {
    clearInterval(timer)
    cameraTickers.delete(cameraId)
  }
  const camera = findCamera(cameraId)
  if (camera && camera.source === 'ip') stopMjpeg(cameraId)
  if (camera && camera.source === 'webcam' && camera.deviceId) {
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
  const active = [...monitors.values()].filter((m) => m.config.cameraId === cameraId)
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
      const result = await engineDetect(frame.jpegBase64)
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

  let description = alert.description
  try {
    if (alert.triggeredBy.startsWith('periodic') || alert.triggeredBy.startsWith('scene')) {
      // description already set by the scene/periodic flow
    } else {
      const visionText = await describeImage(
        jpegBase64,
        `Descreva em uma frase o que esta acontecendo na cena (movimento/deteccao de ${alert.className || 'objeto'}):`
      )
      if (visionText && visionText !== 'vision_unavailable') description = visionText
    }
  } catch {}

  const imageDataUri = `data:image/jpeg;base64,${jpegBase64}`
  const data = {
    type: 'vision_alert',
    data: {
      cameraId: config.cameraId,
      cameraName: config.cameraName || config.cameraId,
      monitorId: config.id,
      monitorLabel: config.label,
      triggeredBy: alert.triggeredBy,
      confidence: alert.confidence,
      className: alert.className,
      snapshotId: snapshot?.id,
      ts: alert.ts,
      description,
      imageDataUri,
      actions: ['open_momai', 'stop_monitoring']
    }
  }

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

async function ensureWebcamWatch(cameraId: string): Promise<void> {
  const camera = findCamera(cameraId)
  if (!camera || camera.source !== 'webcam' || !camera.deviceId) return
  await hostFetch('/media/camera/start-watch', {
    method: 'POST',
    body: JSON.stringify({ deviceId: camera.deviceId, fps: 1 })
  }).catch(() => {})
}

async function toolListCameras(): Promise<unknown> {
  await refreshWebcams()
  const cameras = listCameras()
  const status = await getStatusData()
  const config = await loadConfig()
  return {
    ok: true,
    cameras: cameras.map((c) => ({
      id: c.id,
      name: c.name,
      source: c.source,
      online: status[c.id]?.online ?? false,
      monitors: status[c.id]?.monitors ?? 0
    })),
    defaultCamera: config.defaultCamera || null
  }
}

async function toolCaptureSnapshot(args: { cameraId?: string }): Promise<unknown> {
  const config = await loadConfig()
  const cameraId = args.cameraId || config.defaultCamera || undefined
  if (!cameraId) {
    return { ok: false, error: 'no camera specified' }
  }
  await refreshWebcams()
  const camera = findCamera(cameraId)
  if (!camera) return { ok: false, error: `unknown camera: ${cameraId}` }
  if (camera.source === 'webcam' && camera.deviceId) {
    await hostFetch('/media/camera/start-watch', {
      method: 'POST',
      body: JSON.stringify({ deviceId: camera.deviceId, fps: 1 })
    }).catch(() => {})
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
  const snapshot = await saveSnapshot(frame.jpegBase64, { cameraId })
  const description = await describeImage(
    frame.jpegBase64,
    'Descreva a cena nesta imagem em 1-2 frases, em portugues.'
  ).catch(() => '')
  bridge?.sendStructuredResponse({
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
  })
  return { ok: true, snapshotId: snapshot.id, description, cameraId, cameraName: camera.name }
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
  cameraId: string
  triggers: Trigger[]
  schedule?: { days?: number[]; start?: string; end?: string }
  cooldownSec?: number
  notify?: { native?: boolean; chat?: boolean }
  confirm?: boolean
  label?: string
}

async function toolStartMonitoring(args: StartMonitoringArgs): Promise<unknown> {
  if (!args.cameraId) return { ok: false, error: 'cameraId required' }
  if (!Array.isArray(args.triggers) || args.triggers.length === 0) {
    return { ok: false, error: 'at least one trigger required' }
  }
  const validTypes = ['motion', 'object', 'presence', 'absence', 'scene', 'periodic']
  for (const trigger of args.triggers) {
    if (!validTypes.includes(trigger.type)) {
      return { ok: false, error: `invalid trigger type: ${(trigger as { type: string }).type}` }
    }
  }
  await refreshWebcams()
  const camera = findCamera(args.cameraId)
  if (!camera) return { ok: false, error: `unknown camera: ${args.cameraId}` }

  const plan = describePlan(camera, args.triggers)
  if (args.confirm === true) {
    return { ok: false, requiresConfirmation: true, plan }
  }

  const id = `mon-${Date.now()}`
  const config: MonitorConfig = {
    id,
    cameraId: args.cameraId,
    cameraName: camera.name,
    triggers: args.triggers,
    schedule: args.schedule,
    cooldownSec: Math.min(Math.max(args.cooldownSec ?? 120, 30), 3600),
    notify: args.notify,
    label: args.label,
    createdAt: Date.now()
  }
  monitors.set(id, { config, state: createMonitorState() })
  await saveMonitors()

  if (camera.source === 'webcam') await ensureWebcamWatch(camera.id)
  if (camera.source === 'ip') await startMjpeg(camera)
  ensureCameraTicker(camera.id)

  bridge?.log(`[vision] monitoring started: ${id} on ${camera.id}`)
  return { ok: true, monitorId: id, plan }
}

async function toolStopMonitoring(args: { monitorId?: string; all?: boolean }): Promise<unknown> {
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
  return { ok: true, stopped: ids }
}

async function getStatusData(): Promise<Record<string, { online: boolean; monitors: number; since?: number }>> {
  const status: Record<string, { online: boolean; monitors: number; since?: number }> = {}
  const byCamera = new Map<string, ActiveMonitor[]>()
  for (const m of monitors.values()) {
    const list = byCamera.get(m.config.cameraId) || []
    list.push(m)
    byCamera.set(m.config.cameraId, list)
  }
  for (const camera of listCameras()) {
    const active = byCamera.get(camera.id) || []
    const online =
      camera.source === 'webcam'
        ? active.length > 0 || true
        : mjpegStreams.has(camera.id)
    status[camera.id] = {
      online,
      monitors: active.length,
      since: active[0]?.config.createdAt
    }
  }
  return status
}

async function toolGetStatus(): Promise<unknown> {
  const status = await getStatusData()
  return {
    ok: true,
    monitors: [...monitors.values()].map(({ config, state }) => ({
      id: config.id,
      cameraId: config.cameraId,
      cameraName: config.cameraName,
      triggers: config.triggers,
      schedule: config.schedule,
      cooldownSec: config.cooldownSec,
      label: config.label,
      createdAt: config.createdAt,
      lastAlertTs: state.lastAlertTs
    })),
    cameras: status
  }
}

async function toolListSnapshots(args: { limit?: number }): Promise<unknown> {
  const index = await loadIndex()
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200)
  return {
    ok: true,
    snapshots: index.slice(0, limit).map((s) => ({
      id: s.id,
      cameraId: s.cameraId,
      ts: s.ts,
      trigger: s.trigger,
      description: s.description
    }))
  }
}

// POST /extensions/momai-vision/frame — the dashboard page pumps webcam
// frames (getUserMedia in the renderer) for live bounding boxes.
async function toolFramePump(args: { jpegBase64?: string }): Promise<unknown> {
  if (!args.jpegBase64) return { ok: false, error: 'jpegBase64 required' }
  try {
    const result = await engineDetect(args.jpegBase64)
    if (result.error) return { ok: false, error: result.error }
    const detections = result.boxes || []
    bridge?.sendEvent('vision_detections', {
      cameraId: 'page',
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
  defaultCamera?: string
  retentionDays?: number
  maxSnapshots?: number
  trackingMode?: 'fluid' | 'balanced' | 'economy'
  ipCameras?: Array<{ id: string; name: string; url: string }>
}): Promise<unknown> {
  const current = ((await bridge!.storage.get('config')) || {}) as Record<string, unknown>
  const config = {
    ...current,
    ...(args.defaultCamera !== undefined ? { defaultCamera: args.defaultCamera } : {}),
    ...(args.retentionDays !== undefined ? { retentionDays: args.retentionDays } : {}),
    ...(args.maxSnapshots !== undefined ? { maxSnapshots: args.maxSnapshots } : {}),
    ...(args.trackingMode !== undefined ? { trackingMode: args.trackingMode } : {}),
    ...(args.ipCameras !== undefined ? { ipCameras: args.ipCameras } : {})
  }
  await bridge!.storage.set('config', config)
  if (args.ipCameras !== undefined) {
    await syncIpCameras()
    // Start MJPEG streams for IP cameras that have active monitors.
    for (const cam of ipCameras) {
      const hasMonitor = [...monitors.values()].some((m) => m.config.cameraId === cam.id)
      if (hasMonitor) await startMjpeg(cam)
    }
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

// ---------------------------------------------------------------------------
// Restore & lifecycle
// ---------------------------------------------------------------------------

async function restoreMonitors(): Promise<void> {
  const saved = (await bridge!.storage.get('monitors')) as MonitorConfig[] | null
  if (!Array.isArray(saved)) return
  for (const config of saved) {
    if (!config.id || !config.cameraId) continue
    monitors.set(config.id, { config, state: createMonitorState() })
  }
  const cameras = new Set([...monitors.values()].map((m) => m.config.cameraId))
  await refreshWebcams()
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
  start_monitoring: toolStartMonitoring,
  stop_monitoring: toolStopMonitoring,
  get_status: toolGetStatus,
  list_snapshots: toolListSnapshots,
  frame_pump: toolFramePump,
  configure: toolConfigure
}

let initialized = false

export default {
  async execute(payload: { toolName?: string; args?: Record<string, unknown>; momai?: MomaiBridge }): Promise<unknown> {
    bridge = payload.momai || bridge
    if (!initialized) {
      initialized = true
      // Restore blocks the first tool call so status/planning see restored
      // monitors immediately (no race between restore and get_status).
      await restoreMonitors().catch((err) => {
        bridge?.log(`[vision] restore failed: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
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
