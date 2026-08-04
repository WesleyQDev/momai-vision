/**
 * Test-only implementation of `momai:sdk` (aliased in vitest.config.ts).
 * The real SDK is provided by the host at runtime.
 */
import { vi } from 'vitest'

function createSDK() {
  return {
    api: {
      get: vi.fn(async () => ({ ok: true })),
      post: vi.fn(async () => ({ ok: true, data: {} })),
      put: vi.fn(async () => ({ ok: true })),
      delete: vi.fn(async () => ({ ok: true }))
    },
    storage: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      listKeys: vi.fn(async () => [])
    },
    events: {
      subscribe: vi.fn(() => () => {}),
      unsubscribe: vi.fn(),
      once: vi.fn()
    },
    llm: { complete: vi.fn(async () => ({ text: '' })) },
    registry: {
      registerRenderer: vi.fn(),
      getRenderer: vi.fn(),
      hasRenderer: vi.fn(() => false),
      listRendererTypes: vi.fn(() => [])
    },
    notifications: { send: vi.fn(async () => {}) },
    theme: { setColors: vi.fn(async () => {}) },
    scheduler: { cron: vi.fn(() => ({ cancel: vi.fn() })) },
    oauth: { authorize: vi.fn(async () => ({ ok: true })) },
    config: { get: vi.fn(async () => null), set: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    process: { spawn: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })) },
    system: { screen: { capture: vi.fn(async () => new ArrayBuffer(0)) } },
    browser: { open: vi.fn(async () => {}), screenshot: vi.fn(async () => new ArrayBuffer(0)) },
    has: vi.fn(() => true),
    dev: { reload: vi.fn(), log: vi.fn() }
  }
}

// Singleton so the module under test and the test share the same spies.
const sdk = createSDK()

export function getSDK() {
  return sdk
}
