/**
 * Sandbox integration test: the built runtime.js runs inside the REAL
 * extension host worker sandbox (apps/momai extension-host-worker.js) and
 * survives tool calls (reset:false), restores monitors after restart and
 * runs the CV engine end-to-end via frame_pump.
 *
 * Requires: `pnpm build` first; the host repo present (MOMAI_HOST_DIR).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, cpSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { encode } from 'jpeg-js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const hostDir = process.env.MOMAI_HOST_DIR || 'C:/Users/wesle/dev/momai/apps/momai'
const HOST_WORKER = path.join(hostDir, 'scripts/node-core/services/extension-host-worker.js')
const SKILL_ID = 'momai-vision-test'

const hasHost = existsSync(HOST_WORKER)
const describeHost = hasHost ? describe : describe.skip

function makeFixtureJpeg(): string {
  const width = 320
  const height = 240
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = (x / width) * 255
      data[i + 1] = 128
      data[i + 2] = 255 - (x / width) * 255
      data[i + 3] = 255
    }
  }
  return Buffer.from(encode({ data, width, height }, 85).data).toString('base64')
}

describeHost('runtime.js in the real host worker sandbox', () => {
  let skillDir: string
  let dataDir: string
  let child: ChildProcess
  let mockApi: Server
  let apiUrl = 'http://127.0.0.1:1'
  let nextId = 1
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const events: Array<{ eventType: string; data: unknown }> = []

  function spawnWorker(): Promise<void> {
    events.length = 0
    child = spawn(
      process.execPath,
      [HOST_WORKER, SKILL_ID, skillDir],
      {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, MOMAI_DATA_DIR: dataDir, MOMAI_API_URL: apiUrl, MOMAI_SESSION_TOKEN: 'test-token' }
      }
    )
    child.on('message', (msg: unknown) => {
      const m = msg as { type?: string; id?: string; requestId?: string }
      if (m.type === 'event') {
        events.push({ eventType: (msg as { eventType: string }).eventType, data: (msg as { data: unknown }).data })
      }
      const pendingId = m.id ?? m.requestId
      if (pendingId && pending.has(pendingId)) {
        const entry = pending.get(pendingId)!
        pending.delete(pendingId)
        entry.resolve((msg as { result?: unknown }).result)
      }
    })
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker ready timeout')), 30000)
      child.on('message', (msg: unknown) => {
        if ((msg as { type?: string }).type === 'ready') {
          clearTimeout(timer)
          resolve()
        }
      })
    })
  }

  function execute(payload: Record<string, unknown>, reset = false): Promise<unknown> {
    const requestId = `r${nextId++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('execute timeout')), 60000)
      pending.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        }
      })
      child.send({ type: 'execute', requestId, payload, reset })
    })
  }

  beforeAll(async () => {
    skillDir = mkdtempSync(path.join(tmpdir(), 'momai-vision-skill-'))
    dataDir = mkdtempSync(path.join(tmpdir(), 'momai-vision-data-'))
    cpSync(path.join(root, 'dist', 'runtime.js'), path.join(skillDir, 'runtime.js'))
    mkdirSync(path.join(skillDir, 'cv'), { recursive: true })
    mkdirSync(path.join(skillDir, 'models'), { recursive: true })
    cpSync(path.join(root, 'dist', 'cv', 'engine.cjs'), path.join(skillDir, 'cv', 'engine.cjs'))
    cpSync(path.join(root, 'dist', 'cv', 'ort-wasm-simd-threaded.wasm'), path.join(skillDir, 'cv', 'ort-wasm-simd-threaded.wasm'))
    cpSync(path.join(root, 'dist', 'cv', 'ort-wasm-simd-threaded.mjs'), path.join(skillDir, 'cv', 'ort-wasm-simd-threaded.mjs'))
    cpSync(path.join(root, 'dist', 'models', 'yolo11n.onnx'), path.join(skillDir, 'models', 'yolo11n.onnx'))

    // Minimal host API mock: no cameras configured, vision reports unavailable.
    mockApi = createServer((req, res) => {
      const url = req.url || ''
      if (url === '/media/camera/list' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ cameras: [{ deviceId: 'test-cam', label: 'Test Webcam' }] }))
        return
      }
      if (url.startsWith('/media/camera/') && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (url === '/extensions/llm/vision') {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ visionAvailable: false, error: 'vision_unavailable' }))
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ detail: 'Not found' }))
    })
    await new Promise<void>((resolve) => mockApi.listen(0, '127.0.0.1', resolve))
    const address = mockApi.address()
    if (address && typeof address === 'object') {
      apiUrl = `http://127.0.0.1:${address.port}`
    }
    await spawnWorker()
  }, 40000)

  afterAll(() => {
    try {
      child.kill()
    } catch {}
    try {
      mockApi.close()
    } catch {}
    try {
      rmSync(skillDir, { recursive: true, force: true })
      rmSync(dataDir, { recursive: true, force: true })
    } catch {}
  })

  it(
    'starts and stops monitoring via tool calls, surviving tool calls',
    async () => {
      const start1 = (await execute({
        toolName: 'start_monitoring',
        args: { cameraId: 'webcam:test-cam', triggers: [{ type: 'motion', sensitivity: 'med' }], label: 'Garagem' }
      })) as { ok: boolean; monitorId?: string; plan?: string }
      expect(start1.ok).toBe(true)
      expect(start1.monitorId).toBeTruthy()
      expect(start1.plan).toContain('Test Webcam')

      const start2 = (await execute({
        toolName: 'start_monitoring',
        args: { cameraId: 'webcam:test-cam', triggers: [{ type: 'object', className: 'person', minConfidence: 0.4 }], label: 'Entrada' }
      })) as { ok: boolean; monitorId?: string }
      expect(start2.ok).toBe(true)

      const status = (await execute({ toolName: 'get_status', args: {} })) as {
        ok: boolean
        monitors: Array<{ id: string; label?: string; cameraId: string }>
      }
      expect(status.ok).toBe(true)
      expect(status.monitors).toHaveLength(2)

      const stop = (await execute({
        toolName: 'stop_monitoring',
        args: { monitorId: start1.monitorId }
      })) as { ok: boolean; stopped?: string[] }
      expect(stop.ok).toBe(true)

      // State survived the tool calls: the stopped monitor stays gone.
      const status2 = (await execute({ toolName: 'get_status', args: {} })) as {
        monitors: Array<{ id: string }>
      }
      expect(status2.monitors).toHaveLength(1)
    },
    120000
  )

  it(
    'rejects start_monitoring with invalid triggers',
    async () => {
      const result = (await execute({
        toolName: 'start_monitoring',
        args: { cameraId: 'webcam:test-cam', triggers: [{ type: 'teleport' }] }
      })) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/invalid trigger/)
    },
    60000
  )

  it(
    'runs the CV engine end-to-end via frame_pump inside the sandbox',
    async () => {
      const result = (await execute({
        toolName: 'frame_pump',
        args: { jpegBase64: makeFixtureJpeg() }
      })) as { ok: boolean; detections?: unknown[]; error?: string }
      expect(result.ok).toBe(true)
      expect(Array.isArray(result.detections)).toBe(true)
      const detectionEvent = events.find((e) => e.eventType === 'vision_detections')
      expect(detectionEvent).toBeTruthy()
    },
    120000
  )

  it(
    'restores monitors after a worker restart',
    async () => {
      try {
        child.kill()
      } catch {}
      await new Promise((r) => setTimeout(r, 500))
      await spawnWorker()
      const status = (await execute({ toolName: 'get_status', args: {} })) as {
        ok: boolean
        monitors: Array<{ id: string; label?: string }>
      }
      expect(status.ok).toBe(true)
      expect(status.monitors).toHaveLength(1)
      expect(status.monitors[0].label).toBe('Entrada')
    },
    120000
  )
})
