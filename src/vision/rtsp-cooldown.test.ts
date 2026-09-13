/**
 * Shared RTSP cooldown used by "clear cache and connections".
 *
 * The clear action runs inside a single worker, but the host forks several
 * runtime workers and each one keeps its own reconnect timers. The cooldown
 * lives in the shared extension storage so every worker pauses together,
 * giving the camera a quiet window to drop its stuck sessions.
 */
import { describe, it, expect } from 'vitest'
import {
  markRtspClearCooldown,
  rtspCooldownRemaining,
  RTSP_CLEAR_COOLDOWN_MS
} from './rtsp-cooldown'

interface FakeStorage {
  raw: Map<string, unknown>
  get(key: string): Promise<unknown>
  set(key: string, value: unknown, opts?: { ttlMs?: number }): Promise<void>
}

function createFakeStorage(): FakeStorage {
  const raw = new Map<string, unknown>()
  return {
    raw,
    get: async (key) => (raw.has(key) ? raw.get(key) : null),
    set: async (key, value) => {
      raw.set(key, value)
    }
  }
}

describe('rtsp clear cooldown', () => {
  it('publishes a cooldown other workers can read and expires on its own', async () => {
    const storage = createFakeStorage()
    const now = 1_000_000

    await markRtspClearCooldown(storage, ['ip:rtsp://cam'], now)

    expect(storage.raw.get('rtsp_cooldown')).toBeTruthy()
    expect(await rtspCooldownRemaining(storage, 'ip:rtsp://cam', now + 1_000)).toBe(
      RTSP_CLEAR_COOLDOWN_MS - 1_000
    )
    expect(await rtspCooldownRemaining(storage, 'ip:rtsp://outra', now + 1_000)).toBe(0)
    expect(
      await rtspCooldownRemaining(storage, 'ip:rtsp://cam', now + RTSP_CLEAR_COOLDOWN_MS + 1)
    ).toBe(0)
  })

  it('a global clear (no camera target) holds every camera', async () => {
    const storage = createFakeStorage()

    await markRtspClearCooldown(storage, null, 5_000)

    expect(await rtspCooldownRemaining(storage, 'ip:rtsp://qualquer', 5_001)).toBeGreaterThan(0)
  })

  it('merges a second clear into the current window instead of shortening it', async () => {
    const storage = createFakeStorage()
    const now = 10_000

    await markRtspClearCooldown(storage, ['ip:rtsp://a'], now)
    await markRtspClearCooldown(storage, ['ip:rtsp://b'], now + 20_000)

    expect(await rtspCooldownRemaining(storage, 'ip:rtsp://a', now + 20_001)).toBeGreaterThan(0)
    expect(await rtspCooldownRemaining(storage, 'ip:rtsp://b', now + 20_001)).toBeGreaterThan(0)
  })

  it('never blocks the clear when storage is unavailable', async () => {
    const storage: FakeStorage = {
      raw: new Map(),
      get: async () => {
        throw new Error('storage offline')
      },
      set: async () => {
        throw new Error('storage offline')
      }
    }

    await expect(markRtspClearCooldown(storage, null, 1)).resolves.toBeGreaterThan(0)
    await expect(rtspCooldownRemaining(storage, 'ip:rtsp://cam', 1)).resolves.toBe(0)
  })
})
