import { describe, it, expect } from 'vitest'
import {
  credentialKey,
  decryptCredential,
  getCredential,
  loadCredentialMap,
  putCredential,
  removeCredential,
  type CredentialMap,
  type CredentialStorageBridge,
  type SecureStorageBridge
} from './credentials'

function memoryStorage(): CredentialStorageBridge & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    get: async (key: string) => data.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      data.set(key, value)
    }
  }
}

function fakeVault(): SecureStorageBridge & { secrets: Map<string, string> } {
  const secrets = new Map<string, string>()
  let seq = 0
  return {
    secrets,
    encrypt: async (plain: string) => {
      const id = `vault-${seq++}`
      secrets.set(id, plain)
      return id
    },
    decrypt: async (encryptedBase64: string) => secrets.get(encryptedBase64) ?? null
  }
}

describe('camera credentials', () => {
  it('strips credentials from the storage key', () => {
    expect(credentialKey('rtsp://admin:secret@192.168.0.4:554/onvif1')).toBe(
      'rtsp://192.168.0.4:554/onvif1'
    )
  })

  it('encrypts with the OS vault when available', async () => {
    const storage = memoryStorage()
    const vault = fakeVault()
    const map: CredentialMap = {}
    await putCredential(storage, vault, map, 'rtsp://cam.local/live', 'admin', 's3cret')

    const entry = map['rtsp://cam.local/live']
    expect(entry.vault).toBe(true)
    expect(entry.username).toBe('admin')
    expect(entry.payload.startsWith('vault-')).toBe(true)
    expect(entry.payload).not.toContain('s3cret')

    const restored = await getCredential(storage, vault, map, 'rtsp://cam.local/live')
    expect(restored).toEqual({ username: 'admin', password: 's3cret' })
  })

  it('falls back to AES-GCM with a per-installation key when the vault is absent', async () => {
    const storage = memoryStorage()
    const map: CredentialMap = {}
    await putCredential(storage, undefined, map, 'rtsp://cam.local/live', 'admin', 's3cret')

    const entry = map['rtsp://cam.local/live']
    expect(entry.vault).toBe(false)
    expect(entry.payload).not.toContain('s3cret')
    expect(typeof storage.data.get('camera_credentials_key')).toBe('string')

    const reloaded = await loadCredentialMap(storage)
    const restored = await getCredential(storage, undefined, reloaded, 'rtsp://cam.local/live')
    expect(restored).toEqual({ username: 'admin', password: 's3cret' })
  })

  it('returns null when the payload was tampered with', async () => {
    const storage = memoryStorage()
    const map: CredentialMap = {}
    await putCredential(storage, undefined, map, 'rtsp://cam.local/live', 'admin', 's3cret')
    const entry = { ...map['rtsp://cam.local/live'], payload: 'AAAA' }
    expect(await decryptCredential(storage, undefined, entry)).toBeNull()
  })

  it('removes a stored credential', async () => {
    const storage = memoryStorage()
    const map: CredentialMap = {}
    await putCredential(storage, undefined, map, 'rtsp://cam.local/live', 'admin', 's3cret')
    await removeCredential(storage, map, 'rtsp://cam.local/live')
    expect(await getCredential(storage, undefined, map, 'rtsp://cam.local/live')).toBeNull()
  })
})
