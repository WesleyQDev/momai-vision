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
import fsSync from 'node:fs'
import { fileURLToPath } from 'node:url'
import runtimeModule, { stopEngine, init } from './runtime'
import { createIpcVisionStorage } from './worker-storage'

const workerDir = path.dirname(fileURLToPath(import.meta.url))
const [skillId, skillPath] = process.argv.slice(2)
const dataDir =
  process.env.MOMAI_DATA_DIR ||
  process.env.MOMAI_NODE_CORE_DATA_DIR ||
  path.resolve(workerDir, '..', '..', 'data')

const displayStorageDir = path.join(dataDir, 'extensions', skillId)

let storageResponseListener: ((msg: any) => void) | null = null
const ipcBridge = createIpcVisionStorage({
  send: (msg: unknown) => process.send?.(msg as any),
  onResponse: (fn) => {
    storageResponseListener = fn as (msg: any) => void
  },
  storageDir: displayStorageDir
})

async function migrateLegacySharedJsonOnce(): Promise<void> {
  try {
    const current = await ipcBridge.storage.get('config')
    if (current !== null && current !== undefined) return
  } catch {
    return
  }
  const legacyFile = path.join(dataDir, 'extensions', skillId, 'config.json')
  try {
    if (!fsSync.existsSync(legacyFile)) return
    const raw = await fs.readFile(legacyFile, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      await ipcBridge.storage.set('config', parsed)
    }
  } catch {}
  const legacyMonitors = path.join(dataDir, 'extensions', skillId, 'monitors.json')
  try {
    const currentMonitors = await ipcBridge.storage.get('monitors')
    if (currentMonitors !== null && currentMonitors !== undefined) return
    if (!fsSync.existsSync(legacyMonitors)) return
    const raw = await fs.readFile(legacyMonitors, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed !== null && parsed !== undefined) {
      await ipcBridge.storage.set('monitors', parsed)
    }
  } catch {}
}

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

const storage = ipcBridge.storage

const MAX_ASSET_BYTES = 64 * 1024 * 1024
const MAX_SAVE_BYTES = 5 * 1024 * 1024

const momai = {
  log: (message: string) => process.send?.({ type: 'log', message }),
  sendEvent: (eventType: string, data: unknown) => process.send?.({ type: 'event', eventType, data }),
  sendStructuredResponse: (data: unknown) => process.send?.({ type: 'structured_response', data }),
  storage,
  collections: ipcBridge.collections,
  sessionFiles: ipcBridge.sessionFiles,
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
migrateLegacySharedJsonOnce()
  .catch(() => {})
  .finally(() => {
    init(momai).catch((err: unknown) => {
      process.send?.({
        type: 'log',
        message: `[vision] startup init failed: ${err instanceof Error ? err.message : String(err)}`
      })
    })
  })

process.on('message', async (msg: unknown) => {
  if (!msg || typeof msg !== 'object') return
  const message = msg as { type?: string; requestId?: string; payload?: Record<string, unknown> }
  if (message.type === 'storage-response') {
    try {
      storageResponseListener?.(message)
    } catch {}
    return
  }
  if (message.type === 'execute') {
    const { requestId, payload } = message
    const t0 = Date.now()
    try {
      const result = await runtimeModule.execute({
        ...(payload || {}),
        momai
      })
      const dt = Date.now() - t0
      if (dt > 1000) {
        process.send?.({
          type: 'log',
          message: `[vision] execute ${String(payload?.toolName)} took ${dt}ms`
        })
      }
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
  try { stopEngine() } catch {}
})
