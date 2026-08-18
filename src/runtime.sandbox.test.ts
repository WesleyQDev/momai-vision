/**
 * Sandbox integration test: the built runtime.js runs as a PERSISTENT
 * worker (forked directly by the host, the real contract) and survives tool
 * calls (reset:false), restores monitors after restart and runs the CV
 * engine end-to-end via frame_pump.
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
// NOTA: este teste é uma integração sandbox que só roda com o monorepo do host
// presente; se precisar de um caminho do host, use a env MOMAI_HOST_DIR.
const SKILL_ID = 'momai-vision-test'

function makeFixtureJpeg(width = 320, height = 240): string {
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

describe('runtime.js as a persistent worker (host contract)', () => {
  let skillDir: string
  let dataDir: string
  let child: ChildProcess
  let mockApi: Server
  let apiUrl = 'http://127.0.0.1:1'
  let nextId = 1
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const events: Array<{ eventType: string; data: unknown }> = []
  const cameraPostLog: string[] = []
  // Mock state: simulates the hidden host window starting to deliver frames
  // for a webcam only after start-watch is called (matching the real contract).
  let webcamWarm = false
  const WEB_FRAME = makeFixtureJpeg()
  // Frames are delivered as binary image/jpeg by the host mock.
  const WEB_FRAME_BUF = Buffer.from(WEB_FRAME, 'base64')

  function spawnWorker(): Promise<void> {
    events.length = 0
    child = spawn(
      process.execPath,
      [path.join(skillDir, 'runtime.js'), SKILL_ID, skillDir],
      {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, MOMAI_DATA_DIR: dataDir, MOMAI_API_URL: apiUrl, MOMAI_SESSION_TOKEN: 'test-token', MOMAI_EXTENSION_ID: SKILL_ID, MOMAI_PERSISTENT: 'true' }
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
        entry.resolve((msg as { result?: unknown }).result ?? msg)
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

  // Aguarda um evento do worker (ex.: vision_detections) aparecer no array
  // `events`, com teto de tempo. O frame_pump responde IMEDIATAMENTE (cache ou
  // grace), mas a detecção roda em background — o SSE chega quando ela
  // completar (pode demorar no primeiro boot, com o engine carregando WASM).
  async function waitForEvent(eventType: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (events.some((e) => e.eventType === eventType)) return true
      await new Promise((r) => setTimeout(r, 250))
    }
    return events.some((e) => e.eventType === eventType)
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
    cpSync(path.join(root, 'dist', 'models', 'yolo11s.onnx'), path.join(skillDir, 'models', 'yolo11s.onnx'))

    // Minimal host API mock: one webcam, vision unavailable.
    mockApi = createServer((req, res) => {
      const url = req.url || ''
      if (url === '/media/camera/list' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ cameras: [{ deviceId: 'test-cam', label: 'Test Webcam' }] }))
        return
      }
      if (url.startsWith('/media/camera/') && req.method === 'POST') {
        cameraPostLog.push(url)
        // start-watch "warms" the mock device: from here on the frame endpoint
        // serves a fresh JPEG, mimicking the real hidden window posting frames.
        if (url.includes('/start-watch')) webcamWarm = true
        if (url.includes('/stop-watch')) webcamWarm = false
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      // GET /media/camera/frame/:id — binary image/jpeg with fresh X-Frame-Ts.
      // Before start-watch it 404s (no frame yet) — the "Sem sinal" case.
      if (url.startsWith('/media/camera/frame/') && req.method === 'GET') {
        if (webcamWarm) {
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Content-Length': String(WEB_FRAME_BUF.length),
            'Cache-Control': 'no-store',
            'X-Frame-Ts': String(Date.now())
          })
          res.end(WEB_FRAME_BUF)
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'no frame available' }))
        }
        return
      }
      if (url === '/extensions/llm/vision') {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ visionAvailable: false, error: 'vision_unavailable' }))
        return
      }
      if (url.startsWith('/automations/') && url.endsWith('/toggle') && req.method === 'PATCH') {
        // A automação autotest existe no hub (aceita o toggle); qualquer outra
        // (ex.: auto-nao-existe) não existe — 404, para validar que o runtime
        // não engole a falha silenciosamente.
        if (url.includes('/autotest/')) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, enabled: false }))
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ detail: 'Not found' }))
        }
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
    'accepts the first frame_pump immediately after ready while startup is still warming',
    async () => {
      // O worker persistente anuncia ready antes de o YOLO terminar de carregar.
      // O primeiro card não pode ficar aguardando restore + warmup, pois a UI
      // abandona o request após 8s e só voltaria a tentar ao remontar a aba.
      const t0 = Date.now()
      const result = (await execute({
        toolName: 'frame_pump',
        args: { cameraId: 'webcam:first-mount', jpegBase64: WEB_FRAME }
      })) as { ok: boolean; detections?: unknown[] }
      const elapsed = Date.now() - t0

      expect(result.ok).toBe(true)
      expect(Array.isArray(result.detections)).toBe(true)
      // O limite de produção é 8s; 5s deixa margem para IPC e ainda falha no
      // comportamento antigo, que esperava o restore (6s) antes do warmup.
      expect(elapsed).toBeLessThan(5000)
      expect(await waitForEvent('vision_detections', 120000)).toBe(true)
    },
    150000
  )

  it(
    'starts and stops monitoring via tool calls, surviving tool calls',
    async () => {
      // First verify unselected camera is rejected
      const unselectedResult = (await execute({
        toolName: 'start_monitoring',
        args: { cameraId: 'webcam:test-cam', triggers: [{ type: 'motion' }] }
      })) as { ok: boolean; error?: string }
      expect(unselectedResult.ok).toBe(false)
      expect(unselectedResult.error).toContain('não está selecionada')

      // Select camera for monitoring
      await execute({
        toolName: 'configure',
        args: { selectedCameras: ['webcam:test-cam'] }
      })

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
    'rejects start_monitoring when cameraId is missing or unselected',
    async () => {
      const result = (await execute({
        toolName: 'start_monitoring',
        args: { triggers: [{ type: 'motion' }] }
      })) as { ok: boolean; error?: string }
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/Nenhuma câmera/i)
    },
    60000
  )

  it(
    'updates an active monitor via update_monitoring',
    async () => {
      const status = (await execute({ toolName: 'get_status', args: {} })) as {
        monitors: Array<{ id: string }>
      }
      expect(status.monitors.length).toBeGreaterThan(0)
      const targetId = status.monitors[0].id

      const updateRes = (await execute({
        toolName: 'update_monitoring',
        args: { monitorId: targetId, label: 'Entrada Principal', cooldownSec: 60 }
      })) as { ok: boolean; config?: { label?: string; cooldownSec?: number } }
      expect(updateRes.ok).toBe(true)
      expect(updateRes.config?.label).toBe('Entrada Principal')
      expect(updateRes.config?.cooldownSec).toBe(60)
    },
    60000
  )

  it(
    'persists monitor actions across tool calls (MOM-115)',
    async () => {
      const status = (await execute({ toolName: 'get_status', args: {} })) as {
        monitors: Array<{ id: string }>
      }
      const targetId = status.monitors[0].id
      const actions = [
        {
          id: 'act-test',
          target: 'whatsapp',
          tool: 'send_message',
          args: { contact: 'Ana', message: '{description}', image: '{event.imageDataUri}' }
        }
      ]
      const updateRes = (await execute({
        toolName: 'update_monitoring',
        args: { monitorId: targetId, actions }
      })) as { ok: boolean; config?: { actions?: unknown[] } }
      expect(updateRes.ok).toBe(true)
      expect(updateRes.config?.actions).toEqual(actions)

      const status2 = (await execute({ toolName: 'get_status', args: {} })) as {
        monitors: Array<{ id: string; actions?: unknown[] }>
      }
      expect(status2.monitors[0].actions).toEqual(actions)
    },
    60000
  )

  it(
    'pauses a monitor without deleting it, then resumes it',
    async () => {
      const status = (await execute({ toolName: 'get_status', args: {} })) as {
        monitors: Array<{ id: string; label?: string; paused?: boolean }>
      }
      expect(status.monitors.length).toBeGreaterThan(0)
      const targetId = status.monitors[0].id

      // Pause: the monitor stays saved but is marked paused.
      const pauseRes = (await execute({
        toolName: 'pause_monitoring',
        args: { monitorId: targetId }
      })) as { ok: boolean; paused?: string[] }
      expect(pauseRes.ok).toBe(true)
      expect(pauseRes.paused).toContain(targetId)
      // UIs are notified so the page refreshes its monitor list right away.
      expect(events.some((e) => e.eventType === 'vision_status')).toBe(true)

      const afterPause = (await execute({ toolName: 'get_status', args: {} })) as {
        monitors: Array<{ id: string; paused?: boolean }>
      }
      const pausedMonitor = afterPause.monitors.find((m) => m.id === targetId)
      expect(pausedMonitor).toBeTruthy()
      expect(pausedMonitor?.paused).toBe(true)

      // Resume: back to active.
      const resumeRes = (await execute({
        toolName: 'resume_monitoring',
        args: { monitorId: targetId }
      })) as { ok: boolean; resumed?: string[] }
      expect(resumeRes.ok).toBe(true)
      expect(resumeRes.resumed).toContain(targetId)

      const afterResume = (await execute({ toolName: 'get_status', args: {} })) as {
        monitors: Array<{ id: string; paused?: boolean }>
      }
      expect(afterResume.monitors.find((m) => m.id === targetId)?.paused).toBe(false)
    },
    60000
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
    'reload_camera tears down and re-acquires the webcam source',
    async () => {
      // Self-contained: make sure the camera is selected regardless of order.
      await execute({
        toolName: 'configure',
        args: { selectedCameras: ['webcam:test-cam'] }
      })
      cameraPostLog.length = 0
      const res = (await execute({
        toolName: 'reload_camera',
        args: { cameraId: 'webcam:test-cam' }
      })) as { ok: boolean; cameraId?: string; error?: string }
      // The mock has no /media/camera/frame endpoint, so a fresh frame can't
      // be returned here — what matters is the source was rebuilt: the host
      // watch was stopped and restarted.
      expect(res.cameraId).toBe('webcam:test-cam')
      expect(cameraPostLog.some((u) => u.includes('/stop-watch'))).toBe(true)
      expect(cameraPostLog.some((u) => u.includes('/start-watch'))).toBe(true)
    },
    60000
  )

  it(
    'reload_camera resolves a stale webcam id by label and remaps the selection',
    async () => {
      // Simulate a replug: the card still holds `webcam:old` but the device is
      // now enumerated as `webcam:test-cam` with the same label.
      await execute({
        toolName: 'configure',
        args: { selectedCameras: ['webcam:old'] }
      })
      cameraPostLog.length = 0
      const res = (await execute({
        toolName: 'reload_camera',
        args: { cameraId: 'webcam:old', cameraName: 'Test Webcam' }
      })) as { ok: boolean; cameraId?: string; error?: string }
      // The stale id resolved to the real device by label.
      expect(res.cameraId).toBe('webcam:test-cam')
      expect(cameraPostLog.some((u) => u.includes('/stop-watch'))).toBe(true)
      expect(cameraPostLog.some((u) => u.includes('/start-watch'))).toBe(true)
      // The persisted selection was remapped so the card reconnects now.
      const list = (await execute({ toolName: 'list_cameras', args: {} })) as {
        selectedCameras: string[]
      }
      expect(list.selectedCameras).toEqual(['webcam:test-cam'])
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
      // O frame_pump respondeu imediato/grace (nunca espera o engine); o SSE
      // vision_detections chega quando a detecção em background completar — no
      // primeiro boot o engine ainda pode estar carregando o WASM (10-60s).
      expect(await waitForEvent('vision_detections', 120000)).toBe(true)
    },
    150000
  )

  it(
    'frame_pump with cache responds immediately (never awaits the engine), even with an idle slot',
    async () => {
      // Primeiro pump da câmera: aquece o cache (realmente roda o YOLO).
      const first = (await execute({
        toolName: 'frame_pump',
        args: { cameraId: 'webcam:busy', jpegBase64: makeFixtureJpeg(1280, 720) }
      })) as { ok: boolean; detections?: unknown[] }
      expect(first.ok).toBe(true)
      expect(Array.isArray(first.detections)).toBe(true)
      expect(await waitForEvent('vision_detections', 60000)).toBe(true)

      // Dispara pumps CONCORRENTES para a MESMA câmera: o cache já existe, então
      // TODOS respondem imediatamente com o último resultado — mesmo que o slot
      // esteja livre e o mutex global esteja ocupado por outra câmera (RTSP/
      // FFmpeg). Nunca ficam presos esperando o YOLO (era a causa do timeout de
      // 8s no pump do card, que deixava os quadrados sumirem até trocar de aba).
      const t0 = Date.now()
      const results = await Promise.all(
        [1, 2, 3, 4].map(() =>
          execute({
            toolName: 'frame_pump',
            args: { cameraId: 'webcam:busy', jpegBase64: makeFixtureJpeg(1280, 720) }
          })
        )
      )
      const elapsed = Date.now() - t0
      for (const r of results) {
        expect((r as { ok?: boolean }).ok).toBe(true)
        expect(Array.isArray((r as { detections?: unknown[] }).detections)).toBe(true)
      }
      // Com cache, a resposta é instantânea (sem round-trip ao engine). Sem a
      // correção, ao menos um pump aguardava a detecção em fila — podendo
      // estourar os 8s. Folga para IPC em máquinas lentas.
      expect(elapsed).toBeLessThan(1000)
    },
    120000
  )

  it(
    'frame_pump without cache never blocks beyond the first-frame grace even with a busy global mutex',
    async () => {
      // Ocupa o mutex GLOBAL com detecções grandes de VÁRIAS câmeras diferentes
      // (cada uma serializa no engine). Não aguarda: dispara e segue.
      const big = makeFixtureJpeg(1920, 1080)
      const holders = ['hold-a', 'hold-b', 'hold-c', 'hold-d', 'hold-e'].map((id) =>
        execute({ toolName: 'frame_pump', args: { cameraId: `webcam:${id}`, jpegBase64: big } })
      )

      // Nova câmera SEM cache: o slot dela está livre, mas o mutex global está
      // ocupado pelas detecções acima. Com a correção, o frame_pump responde em
      // até FRAME_PUMP_FIRST_GRACE_MS (~2.5s) com [] (primeiro frame desenha o
      // vídeo sem boxes); sem a correção, aguardava a fila do mutex e podia
      // estourar o timeout de 8s do pump do card.
      const t0 = Date.now()
      const res = (await execute({
        toolName: 'frame_pump',
        args: { cameraId: 'webcam:novacache', jpegBase64: makeFixtureJpeg(320, 240) }
      })) as { ok?: boolean; detections?: unknown[] }
      const elapsed = Date.now() - t0
      expect(res.ok).toBe(true)
      expect(Array.isArray(res.detections)).toBe(true)
      // Bem abaixo dos 8s do pump (grace 2.5s + folga de IPC).
      expect(elapsed).toBeLessThan(6000)

      await Promise.all(holders)
    },
    120000
  )

  it(
    'reports the webcam online (Conectado) once the host delivers frames (mock)',
    async () => {
      // Isola a lógica da extensão do hardware: o mock simula a janela oculta
      // do host — start-watch "aquece" o device e o endpoint de frame passa a
      // entregar JPEG fresco. Se a extensão virar online aqui, o "Sem sinal"
      // real é do getUserMedia do host, não da extensão.
      await execute({ toolName: 'configure', args: { selectedCameras: ['webcam:test-cam'] } })
      const warm = (await execute({
        toolName: 'warm_webcam',
        args: { cameraId: 'webcam:test-cam' }
      })) as { ok: boolean; error?: string }
      expect(warm.ok).toBe(true)
      // Give the fire-and-forget start-watch a moment to hit the mock.
      await new Promise((r) => setTimeout(r, 400))
      expect(webcamWarm).toBe(true)

      const status = (await execute({ toolName: 'get_status', args: {} })) as {
        cameras?: Record<string, { online?: boolean }>
      }
      expect(status.cameras?.['webcam:test-cam']?.online).toBe(true)

      // list_cameras also reflects online via getStatusData.
      const list = (await execute({ toolName: 'list_cameras', args: {} })) as {
        cameras?: Array<{ id: string; online?: boolean }>
      }
      expect(list.cameras?.find((c) => c.id === 'webcam:test-cam')?.online).toBe(true)
    },
    60000
  )

  it(
    'pauses an automation monitor: toggles the hub automation via PATCH and returns ok',
    async () => {
      // O branch auto- de pause_monitoring desativa a automação no hub (PATCH
      // /automations/:id/toggle). Antes da correção o toggle era fire-and-forget:
      // a falha era engolida e o resultado nunca chegava à UI. O teste 2 cobre
      // o caso de falha; aqui validamos o fluxo de sucesso.
      const res = (await execute({
        toolName: 'pause_monitoring',
        args: { monitorId: 'auto-autotest' }
      })) as { ok: boolean; error?: string }
      expect(res.ok).toBe(true)
      expect(res.error).toBeUndefined()
    },
    60000
  )

  it(
    'returns an error when pausing an automation fails in the hub (no silent swallow)',
    async () => {
      // O mock responde 404 para /automations/nao-existe/toggle — a falha não
      // pode ser engolida silenciosamente: o runtime deve reportar erro.
      const res = (await execute({
        toolName: 'pause_monitoring',
        args: { monitorId: 'auto-nao-existe' }
      })) as { ok: boolean; error?: string }
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/pausar/i)
    },
    60000
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
      expect(status.monitors[0].label).toBe('Entrada Principal')
    },
    120000
  )
})
