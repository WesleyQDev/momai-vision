/**
 * MomAI Vision — persistent worker entry (dist/runtime.js).
 *
 * Persistent workers are forked DIRECTLY by the host manager (the runtime.js
 * IS the worker process, not a module loaded by extension-host-worker.js).
 * This file implements the host protocol: ready, execute (request/response),
 * heartbeat every 30s, shutdown — plus the `momai` bridge injected into
 * execute (storage, loadAsset, saveFile, events).
 *
 * The monitoring engine itself lives in runtime.ts and keeps its state in
 * this process (reset:false means the module is never reloaded between
 * tool calls, so monitor loops survive).
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import runtimeModule, { stopEngine, init } from './runtime'

const workerDir = path.dirname(fileURLToPath(import.meta.url))
const [skillId, skillPath] = process.argv.slice(2)
const dataDir =
  process.env.MOMAI_DATA_DIR ||
  process.env.MOMAI_NODE_CORE_DATA_DIR ||
  path.resolve(workerDir, '..', '..', 'data')

const storageBase = path.join(dataDir, 'extensions', skillId)

const SAFE_KEY = /^[a-zA-Z0-9_-]+$/

function resolveInsideExtensionDir(relativePath: string, method: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error(`${method}: relativePath must be a non-empty string`)
  }
  const resolvedBase = path.resolve(skillPath)
  const resolved = path.resolve(skillPath, relativePath)
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    throw new Error(`${method}: path escapes extension directory`)
  }
  return resolved
}

const storage = {
  storageDir: storageBase,
  async get(key: string) {
    if (typeof key !== 'string' || !SAFE_KEY.test(key)) throw new Error('Invalid storage key')
    try {
      return JSON.parse(await fs.readFile(path.join(storageBase, `${key}.json`), 'utf-8'))
    } catch {
      return null
    }
  },
  async set(key: string, value: unknown) {
    if (typeof key !== 'string' || !SAFE_KEY.test(key)) throw new Error('Invalid storage key')
    await fs.mkdir(storageBase, { recursive: true })
    const serialized = JSON.stringify(value, null, 2)
    if (serialized.length > 1024 * 1024) {
      throw new Error('Storage quota exceeded: max 1MB per extension')
    }
    await fs.writeFile(path.join(storageBase, `${key}.json`), serialized, 'utf-8')
  }
}

const MAX_ASSET_BYTES = 64 * 1024 * 1024
const MAX_SAVE_BYTES = 5 * 1024 * 1024

const momai = {
  log: (message: string) => process.send?.({ type: 'log', message }),
  sendEvent: (eventType: string, data: unknown) => process.send?.({ type: 'event', eventType, data }),
  sendStructuredResponse: (data: unknown) => process.send?.({ type: 'structured_response', data }),
  storage,
  async loadAsset(relativePath: string) {
    const fullPath = resolveInsideExtensionDir(relativePath, 'loadAsset')
    let stat
    try {
      stat = await fs.stat(fullPath)
    } catch {
      throw new Error(`loadAsset: file not found: ${relativePath}`)
    }
    if (!stat.isFile()) throw new Error(`loadAsset: not a file: ${relativePath}`)
    if (stat.size > MAX_ASSET_BYTES) {
      throw new Error(`loadAsset: file exceeds ${MAX_ASSET_BYTES} bytes limit`)
    }
    const bytes = new Uint8Array(await fs.readFile(fullPath))
    return { bytes, text: new TextDecoder().decode(bytes) }
  },
  async saveFile(relativePath: string, content: unknown) {
    const fullPath = resolveInsideExtensionDir(relativePath, 'saveFile')
    let buffer: Buffer
    if (typeof content === 'string') buffer = Buffer.from(content, 'utf-8')
    else if (content && typeof content === 'object' && 'bytes' in content && content.bytes instanceof Uint8Array) {
      buffer = Buffer.from(content.bytes)
    } else if (content instanceof Uint8Array) buffer = Buffer.from(content)
    else throw new Error('saveFile: content must be a string, Uint8Array or { bytes }')
    if (buffer.length > MAX_SAVE_BYTES) {
      throw new Error(`saveFile: file exceeds ${MAX_SAVE_BYTES} bytes limit`)
    }
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, buffer)
    return { ok: true, path: relativePath }
  }
}

process.send?.({ type: 'log', message: `Host initialized (PID: ${process.pid})` })
process.send?.({ type: 'ready' })

// Restore monitors and webcam watches at startup so monitoring keeps running
// even if the page is never opened / no chat tool call is ever dispatched.
init(momai).catch((err: unknown) => {
  process.send?.({
    type: 'log',
    message: `[vision] startup init failed: ${err instanceof Error ? err.message : String(err)}`
  })
})

process.on('message', async (msg: unknown) => {
  if (!msg || typeof msg !== 'object') return
  const message = msg as { type?: string; requestId?: string; payload?: Record<string, unknown> }
  if (message.type === 'execute') {
    const { requestId, payload } = message
    try {
      const result = await runtimeModule.execute({
        ...(payload || {}),
        momai
      })
      process.send?.({ type: 'response', requestId, result })
    } catch (err) {
      process.send?.({
        type: 'response',
        requestId,
        result: { ok: false, error: err instanceof Error ? err.message : String(err) }
      })
    }
    return
  }
  if (message.type === 'shutdown') {
    process.exit(0)
  }
})

// Host health check heartbeat (30s).
setInterval(() => {
  if (typeof process.send === 'function') {
    process.send({ type: 'heartbeat', timestamp: Date.now() })
  }
}, 30000)

// Stop the CV engine subprocess when this worker exits.
process.on('exit', () => {
  try {
    stopEngine()
  } catch {}
})
