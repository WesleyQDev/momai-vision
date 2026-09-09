// snapshots-store: collection-backed persistence for snapshots and alerts.
// Injected bridge keeps this unit-testable without booting cameras.
// Legacy KV keys (snapshots_index, alerts_history) are read once as a
// fallback, backfilled, and deleted. Row ids (_rowId) never leak into
// SnapshotMeta ids.

export const SNAPSHOTS_COLLECTION = 'snapshots'
export const ALERTS_COLLECTION = 'alerts'
const LEGACY_SNAPSHOTS_KEY = 'snapshots_index'
const LEGACY_ALERTS_KEY = 'alerts_history'

export interface SnapshotRecord {
  id: string
  cameraId: string
  ts: number
  trigger?: string
  description?: string
  _rowId?: number
}

export interface CollectionBridge {
  log: (msg: string) => void
  storage: {
    get: (key: string) => Promise<unknown>
    set: (key: string, value: unknown) => Promise<void>
    delete?: (key: string) => Promise<void>
  }
  collections?: {
    insert: (name: string, record: unknown) => Promise<{ id: number }>
    list: (name: string, opts?: { limit?: number }) => Promise<any[]>
    remove: (name: string, id: number) => Promise<unknown>
    clear: (name: string, opts?: { olderThanMs?: number }) => Promise<{ removed: number }>
  }
}

function hasCollections(bridge: CollectionBridge): boolean {
  return Boolean(bridge?.collections && typeof bridge.collections.insert === 'function')
}

function warn(bridge: CollectionBridge, message: string): void {
  try {
    bridge.log(message)
  } catch {}
}

function stripRow(row: any): any {
  if (!row || typeof row !== 'object') return row
  const { _rowId, created_at, ...body } = row
  void _rowId
  void created_at
  return body
}

async function deleteLegacyKey(bridge: CollectionBridge, key: string): Promise<void> {
  try {
    await bridge.storage.delete?.(key)
  } catch {}
}

export async function loadSnapshots(bridge: CollectionBridge, limit: number): Promise<SnapshotRecord[]> {
  if (hasCollections(bridge)) {
    try {
      const rows = await bridge.collections!.list(SNAPSHOTS_COLLECTION, { limit })
      if (Array.isArray(rows) && rows.length > 0) return rows.map(stripRow)
    } catch (e) {
      warn(bridge, `loadSnapshots: ${(e as Error).message}`)
    }
  }
  let legacy: unknown = null
  try {
    legacy = await bridge.storage.get(LEGACY_SNAPSHOTS_KEY)
  } catch {}
  if (!Array.isArray(legacy) || legacy.length === 0) return []
  if (hasCollections(bridge)) {
    try {
      for (const entry of legacy) {
        await bridge.collections!.insert(SNAPSHOTS_COLLECTION, entry)
      }
      await deleteLegacyKey(bridge, LEGACY_SNAPSHOTS_KEY)
    } catch (e) {
      warn(bridge, `loadSnapshots backfill: ${(e as Error).message}`)
    }
  }
  return legacy as SnapshotRecord[]
}

export async function recordSnapshot(
  bridge: CollectionBridge,
  meta: Omit<SnapshotRecord, '_rowId'>
): Promise<SnapshotRecord> {
  const row = await bridge.collections!.insert(SNAPSHOTS_COLLECTION, meta)
  return { ...meta, _rowId: row.id }
}

export async function deleteSnapshotRecord(bridge: CollectionBridge, id: string): Promise<boolean> {
  const rows = await bridge.collections!.list(SNAPSHOTS_COLLECTION, { limit: 1000 })
  const found = (Array.isArray(rows) ? rows : []).find((row) => stripRow(row).id === id)
  if (!found) return false
  await bridge.collections!.remove(SNAPSHOTS_COLLECTION, found._rowId ?? found.id)
  return true
}

/** Clears the collection; returns removed string ids so callers delete files. */
export async function clearSnapshots(bridge: CollectionBridge): Promise<{ removed: number; ids: string[] }> {
  const rows = await bridge.collections!.list(SNAPSHOTS_COLLECTION, { limit: 1000 })
  const ids = (Array.isArray(rows) ? rows : []).map((row) => stripRow(row).id).filter(Boolean)
  const { removed } = await bridge.collections!.clear(SNAPSHOTS_COLLECTION)
  return { removed, ids }
}

/**
 * Keeps newest maxCount rows and drops rows older than maxAgeMs.
 * Returns removed string ids so callers delete files.
 */
export async function pruneSnapshots(
  bridge: CollectionBridge,
  opts: { maxCount: number; maxAgeMs: number }
): Promise<string[]> {
  const rows = await bridge.collections!.list(SNAPSHOTS_COLLECTION, { limit: 1000 })
  const now = Date.now()
  const keep = (Array.isArray(rows) ? rows : [])
    .filter((row) => now - Number(stripRow(row).ts || 0) < opts.maxAgeMs)
    .slice(0, Math.max(opts.maxCount, 0))
  const keepIds = new Set(keep.map((row) => stripRow(row).id))
  const removed: string[] = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const body = stripRow(row)
    if (!keepIds.has(body.id)) {
      await bridge.collections!.remove(SNAPSHOTS_COLLECTION, row._rowId ?? row.id)
      if (body.id) removed.push(body.id)
    }
  }
  return removed
}

export function alertKey(alert: { cameraId?: string; ts?: number; className?: string; snapshotId?: string }): string {
  return `${alert.cameraId || ''}_${alert.ts || 0}_${alert.className || 'obj'}_${alert.snapshotId || ''}`
}

export async function loadAlerts(bridge: CollectionBridge, limit: number): Promise<any[]> {
  if (hasCollections(bridge)) {
    try {
      const rows = await bridge.collections!.list(ALERTS_COLLECTION, { limit })
      if (Array.isArray(rows) && rows.length > 0) return rows.map(stripRow)
    } catch (e) {
      warn(bridge, `loadAlerts: ${(e as Error).message}`)
    }
  }
  let legacy: unknown = null
  try {
    legacy = await bridge.storage.get(LEGACY_ALERTS_KEY)
  } catch {}
  if (!Array.isArray(legacy) || legacy.length === 0) return []
  if (hasCollections(bridge)) {
    try {
      for (const entry of legacy) {
        await bridge.collections!.insert(ALERTS_COLLECTION, entry)
      }
      await deleteLegacyKey(bridge, LEGACY_ALERTS_KEY)
    } catch (e) {
      warn(bridge, `loadAlerts backfill: ${(e as Error).message}`)
    }
  }
  return legacy
}

/** Append-only insert: concurrent alerts can never overwrite each other. */
export async function recordAlert(bridge: CollectionBridge, alert: unknown): Promise<{ id: number }> {
  return bridge.collections!.insert(ALERTS_COLLECTION, alert)
}

/** Reconciles a full-array save without duplicating rows. */
export async function saveAlerts(bridge: CollectionBridge, alerts: any[]): Promise<void> {
  const rows = await bridge.collections!.list(ALERTS_COLLECTION, { limit: 1000 })
  const wanted = new Set((Array.isArray(alerts) ? alerts : []).map(alertKey))
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!wanted.has(alertKey(stripRow(row)))) {
      await bridge.collections!.remove(ALERTS_COLLECTION, row._rowId ?? row.id)
    }
  }
  const existing = new Set(
    (Array.isArray(rows) ? rows : []).map((row) => alertKey(stripRow(row)))
  )
  for (const alert of Array.isArray(alerts) ? alerts : []) {
    if (!existing.has(alertKey(alert))) {
      await bridge.collections!.insert(ALERTS_COLLECTION, alert)
    }
  }
}

/** Keeps the newest keepN alerts, dropping older rows. */
export async function trimAlerts(bridge: CollectionBridge, keepN: number): Promise<number> {
  const rows = await bridge.collections!.list(ALERTS_COLLECTION, { limit: 1000 })
  const extra = (Array.isArray(rows) ? rows : []).slice(Math.max(keepN, 0))
  for (const row of extra) {
    await bridge.collections!.remove(ALERTS_COLLECTION, row._rowId ?? row.id)
  }
  return extra.length
}

/** Clears all alerts. */
export async function clearAlerts(bridge: CollectionBridge): Promise<{ removed: number }> {
  return bridge.collections!.clear(ALERTS_COLLECTION)
}

/** Deletes alerts matching a predicate over the alert body. */
export async function deleteAlertsWhere(
  bridge: CollectionBridge,
  predicate: (alert: any) => boolean
): Promise<number> {
  const rows = await bridge.collections!.list(ALERTS_COLLECTION, { limit: 1000 })
  let removed = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    if (predicate(stripRow(row))) {
      await bridge.collections!.remove(ALERTS_COLLECTION, row._rowId ?? row.id)
      removed += 1
    }
  }
  return removed
}
