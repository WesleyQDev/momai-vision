import { describe, it, expect, vi } from 'vitest'
import {
  SNAPSHOTS_COLLECTION,
  ALERTS_COLLECTION,
  loadSnapshots,
  recordSnapshot,
  deleteSnapshotRecord,
  clearSnapshots,
  loadAlerts,
  recordAlert,
  saveAlerts,
  trimAlerts,
  clearAlerts,
  deleteAlertsWhere
} from './snapshots-store'

function stubBridge(options: { declared?: string[]; legacy?: Record<string, any> } = {}) {
  const declared = new Set(options.declared ?? [SNAPSHOTS_COLLECTION, ALERTS_COLLECTION])
  const kv = new Map<string, any>(Object.entries(options.legacy ?? {}))
  const tables = new Map<string, any[]>()
  const log = vi.fn()
  const table = (name: string) => {
    if (!declared.has(name)) {
      throw Object.assign(new Error('not declared'), { code: 'permission_denied' })
    }
    let rows = tables.get(name)
    if (!rows) {
      rows = []
      tables.set(name, rows)
    }
    return rows
  }
  return {
    log,
    kv,
    tables,
    bridge: {
      log,
      storage: {
        get: async (key: string) => kv.get(key) ?? null,
        set: async (key: string, value: any) => {
          kv.set(key, value)
        },
        delete: async (key: string) => {
          kv.delete(key)
        }
      },
      collections: {
        insert: async (name: string, record: any) => {
          const rows = table(name)
          rows.push({ ...record, _rowId: rows.length + 1 })
          return { id: rows.length }
        },
        list: async (name: string, opts?: { limit?: number }) => {
          const rows = [...table(name)].reverse()
          return typeof opts?.limit === 'number' ? rows.slice(0, opts.limit) : rows
        },
        remove: async (name: string, id: number) => {
          const rows = table(name)
          const index = rows.findIndex((r) => r._rowId === id)
          if (index >= 0) rows.splice(index, 1)
          return { ok: true }
        },
        clear: async (name: string) => {
          const rows = table(name)
          const removed = rows.length
          rows.length = 0
          return { removed }
        }
      }
    }
  }
}

const snap = { id: 's1', cameraId: 'cam1', ts: 1000 }
const alert = { cameraId: 'cam1', ts: 2000, className: 'person' }

describe('snapshots collection', () => {
  it('records one row per snapshot without rewriting an index', async () => {
    const { bridge, tables } = stubBridge()
    await recordSnapshot(bridge as any, snap)
    await recordSnapshot(bridge as any, { ...snap, id: 's2' })
    expect(tables.get(SNAPSHOTS_COLLECTION)).toHaveLength(2)
  })

  it('loads newest first with legacy fallback and backfill', async () => {
    const { bridge, kv, tables } = stubBridge({ legacy: { snapshots_index: [snap] } })
    const loaded = await loadSnapshots(bridge as any, 50)
    expect(loaded.map((s: any) => s.id)).toEqual(['s1'])
    expect(tables.get(SNAPSHOTS_COLLECTION)).toHaveLength(1)
    expect(kv.has('snapshots_index')).toBe(false)
  })

  it('deletes a snapshot by string id', async () => {
    const { bridge } = stubBridge()
    await recordSnapshot(bridge as any, snap)
    await deleteSnapshotRecord(bridge as any, 's1')
    await expect(loadSnapshots(bridge as any, 50)).resolves.toEqual([])
  })

  it('clears everything and reports the count', async () => {
    const { bridge } = stubBridge()
    await recordSnapshot(bridge as any, snap)
    const cleared = await clearSnapshots(bridge as any)
    expect(cleared.removed).toBe(1)
    expect(cleared.ids).toEqual(['s1'])
  })
})

describe('alerts collection', () => {
  it('appends concurrently without losing entries (no read-modify-write)', async () => {
    const { bridge, tables } = stubBridge()
    await Promise.all([
      recordAlert(bridge as any, alert),
      recordAlert(bridge as any, { ...alert, ts: 2001 })
    ])
    expect(tables.get(ALERTS_COLLECTION)).toHaveLength(2)
  })

  it('falls back to the legacy key once and backfills', async () => {
    const { bridge, kv } = stubBridge({ legacy: { alerts_history: [alert] } })
    const loaded = await loadAlerts(bridge as any, 100)
    expect(loaded).toHaveLength(1)
    expect(kv.has('alerts_history')).toBe(false)
  })

  it('reconciles full-array saves without duplicating rows', async () => {
    const { bridge, tables } = stubBridge()
    await recordAlert(bridge as any, alert)
    await saveAlerts(bridge as any, [{ ...alert }, { ...alert, ts: 2001 }])
    expect(tables.get(ALERTS_COLLECTION)).toHaveLength(2)
  })

  it('trims alerts to the newest keepN rows', async () => {
    const { bridge, tables } = stubBridge()
    await recordAlert(bridge as any, alert)
    await recordAlert(bridge as any, { ...alert, ts: 2001 })
    await expect(trimAlerts(bridge as any, 1)).resolves.toBe(1)
    expect(tables.get(ALERTS_COLLECTION)).toHaveLength(1)
  })

  it('clears all alerts and deletes by predicate', async () => {
    const { bridge, tables } = stubBridge()
    await recordAlert(bridge as any, alert)
    await recordAlert(bridge as any, { ...alert, ts: 2001 })
    expect(await deleteAlertsWhere(bridge as any, (a: any) => a.ts === 2000)).toBe(1)
    await expect(clearAlerts(bridge as any)).resolves.toEqual({ removed: 1 })
    expect(tables.get(ALERTS_COLLECTION)).toHaveLength(0)
  })
})
