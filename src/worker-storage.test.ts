import { describe, it, expect, vi } from 'vitest'
import { createIpcVisionStorage } from './worker-storage'

describe('vision worker storage uses host SQLite via IPC', () => {
  it('routes get/set through storage-request instead of shared JSON files', async () => {
    const sent: any[] = []
    const holder: { current: ((msg: any) => void) | null } = { current: null }
    const bridge = createIpcVisionStorage({
      send: (msg: any) => {
        sent.push(msg)
      },
      onResponse: (fn: (msg: any) => void) => {
        holder.current = fn
      },
      storageDir: '/tmp/vision-display-only'
    })

    const pendingGet = bridge.storage.get('config')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'storage-request',
      method: 'storage.get'
    })
    expect(Array.isArray(sent[0].args)).toBe(true)
    expect(sent[0].args[0]).toBe('config')

    holder.current?.({
      type: 'storage-response',
      requestId: sent[0].requestId,
      result: { ok: true, value: { ipCameras: [] } }
    })
    await expect(pendingGet).resolves.toEqual({ ipCameras: [] })

    sent.length = 0
    const pendingSet = bridge.storage.set('config', { ipCameras: [] })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'storage-request',
      method: 'storage.set'
    })

    holder.current?.({
      type: 'storage-response',
      requestId: sent[0].requestId,
      result: { ok: true, value: undefined }
    })
    await expect(pendingSet).resolves.toBeUndefined()
  })

  it('surfaces host storage errors with errorCode', async () => {
    const sent: any[] = []
    const holder: { current: ((msg: any) => void) | null } = { current: null }
    const bridge = createIpcVisionStorage({
      send: (msg: any) => {
        sent.push(msg)
      },
      onResponse: (fn: (msg: any) => void) => {
        holder.current = fn
      },
      storageDir: '/tmp/vision-display-only'
    })

    const pending = bridge.storage.get('monitors')
    holder.current?.({
      type: 'storage-response',
      requestId: sent[0].requestId,
      result: { ok: false, error: 'denied', errorCode: 'permission_denied' }
    })
    await expect(pending).rejects.toMatchObject({ code: 'permission_denied' })
    expect(vi.fn()).toBeDefined()
  })
})
