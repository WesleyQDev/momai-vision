/**
 * Integration test: YOLO11n detection runs headless through the CV engine
 * subprocess (dist/cv/engine.cjs). Requires `pnpm build` first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { encode } from 'jpeg-js'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const ENGINE_PATH = path.join(root, 'dist', 'cv', 'engine.cjs')

function makeFixtureJpeg(): string {
  const width = 320
  const height = 240
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const gradient = (x / width) * 255
      data[i] = gradient
      data[i + 1] = 128
      data[i + 2] = 255 - gradient
      data[i + 3] = 255
    }
  }
  const jpeg = encode({ data, width, height }, 85)
  return Buffer.from(jpeg.data).toString('base64')
}

describe('CV engine (YOLO11n headless)', () => {
  let child: ChildProcess
  let nextId = 1
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  function send(type: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    const id = `t${nextId++}`
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.send({ type, id, ...payload })
    })
  }

  beforeAll(async () => {
    child = spawn(process.execPath, [ENGINE_PATH], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
    child.on('message', (msg: unknown) => {
      const m = msg as { id?: string }
      if (m.id && pending.has(m.id)) {
        const entry = pending.get(m.id)!
        pending.delete(m.id)
        entry.resolve(msg)
      }
    })
    await new Promise<void>((resolve, reject) => {
      // O 'ready' só é enviado APÓS o load do WASM+modelo (ver src/engine.ts) —
      // pode levar ~10-60s em máquinas lentas.
      const timer = setTimeout(() => reject(new Error('engine ready timeout')), 90000)
      child.on('message', (msg: unknown) => {
        if ((msg as { type?: string }).type === 'ready') {
          clearTimeout(timer)
          resolve()
        }
      })
    })
  }, 120000)

  afterAll(() => {
    try {
      child.send({ type: 'shutdown' })
    } catch {}
  })

  it(
    'detects on a synthetic frame and returns normalized COCO boxes',
    async () => {
      const result = (await send('detect', { jpegBase64: makeFixtureJpeg() })) as {
        boxes: Array<{ className: string; confidence: number; x1: number; y1: number; x2: number; y2: number }>
        ms?: number
        error?: string
      }
      expect(result.error).toBeUndefined()
      expect(Array.isArray(result.boxes)).toBe(true)
      for (const box of result.boxes) {
        expect(box.className).toBeTruthy()
        expect(box.confidence).toBeGreaterThan(0)
        expect(box.x1).toBeGreaterThanOrEqual(0)
        expect(box.x1).toBeLessThanOrEqual(1)
        expect(box.y2).toBeLessThanOrEqual(1)
        expect(box.x2).toBeGreaterThanOrEqual(box.x1)
        expect(box.y2).toBeGreaterThanOrEqual(box.y1)
      }
      if (result.ms !== undefined) {
        expect(result.ms).toBeGreaterThan(0)
      }
    },
    60000
  )

  it(
    'errors clearly on invalid input',
    async () => {
      const result = (await send('detect', { jpegBase64: 'not-a-jpeg' })) as { error?: string }
      expect(result.error).toBeTruthy()
    },
    60000
  )
})
