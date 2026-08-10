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
            activeUrl = targetUrl

            // Periodically poll snapshot
            while (!controller.signal.aborted) {
              await new Promise((resolve) => setTimeout(resolve, 1000))
              if (controller.signal.aborted) break
              try {
                const snapRes = await fetch(reqUrl, { headers: reqHeaders, signal: controller.signal })
                if (snapRes.ok) {
                  const buf = await snapRes.arrayBuffer()
                  entry.latest = Buffer.from(buf).toString('base64')
                  entry.latestTs = Date.now()
                }
              } catch {}
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
  socket: import('node:net').Socket
  ffmpeg: import('node:child_process').ChildProcess | null
  alive: boolean
}

const rtspSessions = new Map<string, RtspSession>()

function stopRtsp(cameraId: string): void {
  const session = rtspSessions.get(cameraId)
  if (!session) return
  session.alive = false
  try { session.socket.destroy() } catch {}
  try { session.ffmpeg?.kill() } catch {}
  rtspSessions.delete(cameraId)
}

let _cryptoMod: typeof import('node:crypto') | null = null
async function getCrypto(): Promise<typeof import('node:crypto')> {
  if (!_cryptoMod) _cryptoMod = await import('node:crypto')
  return _cryptoMod
}

function rtspMd5(cryptoMod: typeof import('node:crypto'), str: string): string {
  return cryptoMod.createHash('md5').update(str).digest('hex')
}

function buildDigestAuthHeader(
  cryptoMod: typeof import('node:crypto'),
  username: string, password: string,
  realm: string, nonce: string,
  method: string, uri: string
): string {
  const ha1 = rtspMd5(cryptoMod, `${username}:${realm}:${password}`)
  const ha2 = rtspMd5(cryptoMod, `${method}:${uri}`)
  const response = rtspMd5(cryptoMod, `${ha1}:${nonce}:${ha2}`)
  return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`
}

async function startRtspStream(camera: CameraEntry): Promise<void> {
  if (rtspSessions.has(camera.id)) return
  if (mjpegStreams.has(camera.id)) return

  const url = camera.url!
  const match = url.match(/^rtsp:\/\/(?:([^:@]+):([^@]+)@)?([^:/]+)(?::(\d+))?(\/.*)?$/)
  if (!match) {
    bridge?.log(`[vision] RTSP: invalid URL for ${camera.name}: ${url}`)
    return
  }

  const [, user, pass, host, portStr, urlPath] = match
  const port = parseInt(portStr || '554', 10)
  const streamPath = urlPath || '/onvif1'
  const username = user || 'admin'
  const password = pass || ''

  const entry: { controller: AbortController; latest: string | null; latestTs: number } = {
    controller: new AbortController(),
    latest: null,
    latestTs: 0
  }
  mjpegStreams.set(camera.id, entry)

  const net = await import('node:net')
  const { spawn } = await import('node:child_process')
  const cryptoMod = await getCrypto()

  const socket = net.createConnection({ host, port }, () => {
    bridge?.log(`[vision] RTSP: connected to ${camera.name} (${host}:${port})`)
  })

  const session: RtspSession = { socket, ffmpeg: null, alive: true }
  rtspSessions.set(camera.id, session)

  // Spawn FFmpeg to decode H.265 NAL units piped via stdin → MJPEG frames on stdout
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'hevc',
    '-i', 'pipe:0',
    '-vf', 'fps=30',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-q:v', '5',
    'pipe:1'
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  session.ffmpeg = ffmpeg

  // Parse MJPEG output from FFmpeg stdout
  let jpegBuf = Buffer.alloc(0)
  ffmpeg.stdout!.on('data', (chunk: Buffer) => {
    jpegBuf = Buffer.concat([jpegBuf, chunk])
    // Scan for complete JPEG frames (SOI 0xFFD8 ... EOI 0xFFD9)
    while (true) {
      const soi = jpegBuf.indexOf(Buffer.from([0xff, 0xd8]))
      if (soi === -1) break
      const eoi = jpegBuf.indexOf(Buffer.from([0xff, 0xd9]), soi + 2)
      if (eoi === -1) break
      const frame = jpegBuf.subarray(soi, eoi + 2)
      jpegBuf = jpegBuf.subarray(eoi + 2)
      entry.latest = frame.toString('base64')
      entry.latestTs = Date.now()
    }
  })

  ffmpeg.on('exit', () => {
    if (session.alive) {
      bridge?.log(`[vision] RTSP: FFmpeg exited for ${camera.name}, restarting...`)
      // Will be restarted on next get_frame call
    }
  })

  // RTSP state machine
  const baseUri = `rtsp://${host}:${port}${streamPath}`
  let cseq = 0
  let realm = ''
  let nonce = ''
  let rtspSessionId = ''
  let rtpBuffer = Buffer.alloc(0)
  let phase: 'describe_unauth' | 'describe_auth' | 'setup' | 'play' | 'streaming' = 'describe_unauth'
  const startCode = Buffer.from([0x00, 0x00, 0x00, 0x01])

  function sendRtsp(method: string, uri: string, extraHeaders: string = ''): void {
    cseq++
    let authLine = ''
    if (realm && nonce) {
      authLine = `Authorization: ${buildDigestAuthHeader(cryptoMod, username, password, realm, nonce, method, uri)}\r\n`
    }
    const req = `${method} ${uri} RTSP/1.0\r\nCSeq: ${cseq}\r\n${authLine}User-Agent: MomAI-Vision\r\n${extraHeaders}\r\n`
    socket.write(req)
  }

  // Start DESCRIBE without auth to get the Digest challenge
  socket.on('connect', () => {
    sendRtsp('DESCRIBE', baseUri, 'Accept: application/sdp\r\n')
  })

  socket.on('data', (chunk: Buffer) => {
    if (!session.alive) return
    rtpBuffer = Buffer.concat([rtpBuffer, chunk])

    // Before streaming, parse text RTSP responses
    if (phase !== 'streaming') {
      const text = rtpBuffer.toString('utf-8')

      if (phase === 'describe_unauth') {
        if (text.includes('401 Unauthorized')) {
          const realmMatch = text.match(/realm="([^"]+)"/)
          const nonceMatch = text.match(/nonce="([^"]+)"/)
          if (realmMatch && nonceMatch) {
            realm = realmMatch[1]
            nonce = nonceMatch[1]
            phase = 'describe_auth'
            rtpBuffer = Buffer.alloc(0)
            sendRtsp('DESCRIBE', baseUri, 'Accept: application/sdp\r\n')
          } else {
            bridge?.log(`[vision] RTSP 401 missing realm/nonce for ${camera.name}`)
            stopRtsp(camera.id)
          }
          return
        } else if (text.includes('RTSP/1.0 200 OK') && text.includes('v=0')) {
          phase = 'setup'
          rtpBuffer = Buffer.alloc(0)
          const setupUri = `${baseUri}/track1`
          sendRtsp('SETUP', setupUri, 'Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n')
          return
        } else if (text.includes('\r\n\r\n')) {
          bridge?.log(`[vision] RTSP DESCRIBE failed for ${camera.name}: ${text.slice(0, 120)}`)
          stopRtsp(camera.id)
          return
        }
        return
      }

      if (phase === 'describe_auth') {
        if (text.includes('RTSP/1.0 200 OK') && text.includes('v=0')) {
          phase = 'setup'
          rtpBuffer = Buffer.alloc(0)
          const setupUri = `${baseUri}/track1`
          sendRtsp('SETUP', setupUri, 'Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n')
          return
        } else if (text.includes('401 Unauthorized')) {
          bridge?.log(`[vision] RTSP Auth FAILED (401) for ${camera.name} — check username/password`)
          stopRtsp(camera.id)
          return
        } else if (text.includes('\r\n\r\n')) {
          bridge?.log(`[vision] RTSP DESCRIBE auth failed for ${camera.name}: ${text.slice(0, 120)}`)
          stopRtsp(camera.id)
          return
        }
        return
      }

      if (phase === 'setup') {
        if (text.includes('Session:')) {
          const sessionMatch = text.match(/Session:\s*([^\r\n;]+)/i)
          if (sessionMatch) {
            rtspSessionId = sessionMatch[1].trim()
            phase = 'play'
            rtpBuffer = Buffer.alloc(0)
            sendRtsp('PLAY', baseUri, `Session: ${rtspSessionId}\r\n`)
            bridge?.log(`[vision] RTSP: streaming ${camera.name} (H.265 → JPEG)`)
            return
          }
        } else if (text.includes('\r\n\r\n')) {
          bridge?.log(`[vision] RTSP SETUP failed for ${camera.name}: ${text.slice(0, 120)}`)
          stopRtsp(camera.id)
          return
        }
        return
      }

      if (phase === 'play') {
        if (text.includes('RTSP/1.0 200 OK')) {
          phase = 'streaming'
          const headerEnd = rtpBuffer.indexOf(Buffer.from([0x0d, 0x0a, 0x0d, 0x0a]))
          if (headerEnd !== -1) {
            rtpBuffer = rtpBuffer.subarray(headerEnd + 4)
          } else {
            rtpBuffer = Buffer.alloc(0)
          }
        } else {
          return
        }
      }
    }

    // Parse interleaved RTP packets ($<channel><length_u16><rtp_data>)
    while (rtpBuffer.length >= 4) {
      if (rtpBuffer[0] === 0x24) { // '$' magic byte
        const channel = rtpBuffer[1]
        const length = rtpBuffer.readUInt16BE(2)
        if (rtpBuffer.length < 4 + length) break // need more data

        const rtpPacket = rtpBuffer.subarray(4, 4 + length)
        rtpBuffer = rtpBuffer.subarray(4 + length)

        // Only process video channel (0)
        if (channel !== 0 || rtpPacket.length <= 12) continue

        // Strip 12-byte RTP header → NAL payload
        const payload = rtpPacket.subarray(12)
        if (payload.length < 2) continue

        // H.265 NAL unit header is 2 bytes: (type >> 1) & 0x3F
        const nalType = (payload[0] >> 1) & 0x3f

        if (nalType === 49) {
          // FU (Fragmentation Unit) — RFC 7798 §4.4.3
          // Byte 0-1: NAL header of the FU indicator
          // Byte 2: FU header (S|E|type)
          if (payload.length < 3) continue
          const fuHeader = payload[2]
          const isStart = !!(fuHeader & 0x80)
          const isEnd = !!(fuHeader & 0x40)
          const fuNalType = fuHeader & 0x3f

          if (isStart) {
            // Reconstruct NAL header: copy the FU indicator header but replace the type
            const nalHeader = Buffer.alloc(2)
            nalHeader[0] = (payload[0] & 0x81) | (fuNalType << 1)
            nalHeader[1] = payload[1]
            try {
              ffmpeg.stdin!.write(startCode)
              ffmpeg.stdin!.write(nalHeader)
              ffmpeg.stdin!.write(payload.subarray(3))
            } catch {}
          } else {
            // Continuation or end fragment — just append the payload (skip FU header bytes)
            try {
              ffmpeg.stdin!.write(payload.subarray(3))
            } catch {}
          }
        } else if (nalType >= 0 && nalType <= 40) {
          // Single NAL unit packet — pass through with start code
          try {
            ffmpeg.stdin!.write(startCode)
            ffmpeg.stdin!.write(payload)
          } catch {}
        } else if (nalType === 48) {
          // AP (Aggregation Packet) — RFC 7798 §4.4.2
          let offset = 2 // skip NAL header
          while (offset + 2 <= payload.length) {
            const nalSize = payload.readUInt16BE(offset)
            offset += 2
            if (offset + nalSize > payload.length) break
            try {
              ffmpeg.stdin!.write(startCode)
              ffmpeg.stdin!.write(payload.subarray(offset, offset + nalSize))
            } catch {}
            offset += nalSize
          }
        }
      } else {
        // Not a '$' byte — skip to next '$'
        const idx = rtpBuffer.indexOf(0x24, 1)
        if (idx !== -1) {
          rtpBuffer = rtpBuffer.subarray(idx)
        } else {
          rtpBuffer = Buffer.alloc(0)
          break
        }
      }
    }
  })

  socket.on('error', (err: Error) => {
    bridge?.log(`[vision] RTSP: socket error for ${camera.name}: ${err.message}`)
  })

  socket.on('close', () => {
    if (session.alive) {
      bridge?.log(`[vision] RTSP: connection closed for ${camera.name}`)
      session.alive = false
      try { ffmpeg.kill() } catch {}
      rtspSessions.delete(camera.id)
      mjpegStreams.delete(camera.id)
    }
  })

  // Keepalive: send GET_PARAMETER every 30s to keep session alive
  const keepaliveInterval = setInterval(() => {
    if (!session.alive) { clearInterval(keepaliveInterval); return }
    try {
      sendRtsp('GET_PARAMETER', baseUri, rtspSessionId ? `Session: ${rtspSessionId}\r\n` : '')
    } catch { clearInterval(keepaliveInterval) }
  }, 30000)

  // Cleanup on abort
  entry.controller.signal.addEventListener('abort', () => {
    session.alive = false
    clearInterval(keepaliveInterval)
    try { socket.destroy() } catch {}
    try { ffmpeg.kill() } catch {}
    rtspSessions.delete(camera.id)
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
}

async function loadAlertsHistory(): Promise<PersistedAlert[]> {
  const history = (await bridge!.storage.get('alerts_history')) as PersistedAlert[] | null
  return Array.isArray(history) ? history : []
}

async function saveAlertsHistory(alerts: PersistedAlert[]): Promise<void> {
  await bridge!.storage.set('alerts_history', alerts)
}

async function saveAlertToHistory(alert: PersistedAlert): Promise<void> {
  const history = await loadAlertsHistory()
  history.unshift(alert)
  await saveAlertsHistory(history.slice(0, 200))
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
    imageDataUri
  }

  const mergedActions = ([] as MonitorAction[])
    .concat(config.actions || [], (await loadConfig().catch(() => ({}) as StoredConfig)).sendActions || [])
    .filter(Boolean)

  const data = {
    type: 'vision_alert',
    data: {
      ...alertPayload,
      tts: description,
      // Actions configuradas no monitor + as ações globais (Opções de envio).
      // O host executa todas (MOM-115).
      actions: mergedActions.length ? mergedActions : undefined
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
// touched — this is what keeps it from blinking/toggling.
async function reconnectWebcamIfStale(camera: CameraEntry): Promise<void> {
  if (!camera || camera.source !== 'webcam' || !camera.deviceId) return
  if (await isWebcamOnline(camera)) return
  const lastTry = webcamLastReconnectTs.get(camera.deviceId) || 0
  if (Date.now() - lastTry < WEB_RECONNECT_MIN_MS) return
  webcamLastReconnectTs.set(camera.deviceId, Date.now())
  await stopWebcamWatch(camera)
  await ensureWebcamWatch(camera.id, 10, true)
}

async function ensureWebcamWatch(cameraId: string, fps = 10, force = false): Promise<void> {
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
    if (m.config.cameraId.startsWith('webcam:')) wanted.add(m.config.cameraId)
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

  if (oldCameraId !== entry.config.cameraId) {
    stopCameraTickerIfIdle(oldCameraId)
  }
  if (camera) {
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
      actions: config.actions,
      createdAt: config.createdAt,
      lastAlertTs: state.lastAlertTs
    })),
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
    await bridge!.storage.set('config', config)
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
      // Arm the reconnect rate-limit BEFORE the fresh stream is created. The
      // card polls get_frame continuously; without this the very next poll
      // would see "no frame yet" and immediately reconnect, racing this
      // rebuild and toggling the device LED while it settles.
      if (camera.deviceId) webcamLastReconnectTs.set(camera.deviceId, Date.now())
      await ensureWebcamWatch(camera.id, 10, true)
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
    const result = await engineDetect(args.jpegBase64)
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
  if (args.ipCameras !== undefined) {
    await syncIpCameras()
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
  const cameras = new Set([...monitors.values()].map((m) => m.config.cameraId))
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
      // Recovery net: keep webcam watches in sync even when the page is closed.
      setInterval(() => {
        void syncWebcamWatches().catch(() => {})
      }, 10000)
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
