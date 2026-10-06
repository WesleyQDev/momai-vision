/**
 * Camera credential storage.
 *
 * Passwords never travel inside camera URLs or ids. They are encrypted with
 * the OS vault (Electron safeStorage via the host's secure-storage bridge)
 * whenever it is available; otherwise AES-256-GCM with a random
 * per-installation key kept in extension storage (the same at-rest model the
 * notes feature uses). The only camera identity persisted is the clean URL.
 *
 * Storage shape (extension storage key `camera_credentials`):
 *   { "<clean-url>": { username, payload, vault } }
 *
 * `payload` is a base64 vault blob (vault=true) or an AES-GCM payload
 * (vault=false). Usernames are not secret and stay readable so the UI can
 * prefill them without a decrypt round-trip.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { parseCameraAuth } from './vision/rtsp-auth'

export interface SecureStorageBridge {
  encrypt(plain: string): Promise<string | null>
  decrypt(encryptedBase64: string): Promise<string | null>
}

export interface CredentialStorageBridge {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export interface StoredCredential {
  username: string
  payload: string
  vault: boolean
}

export type CredentialMap = Record<string, StoredCredential>

export interface ResolvedCredential {
  username: string
  password: string
}

export const CREDENTIALS_KEY = 'camera_credentials'
export const FALLBACK_KEY = 'camera_credentials_key'

const SALT = 'momai-vision-credentials-v1'
const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32

/** Clean URL used as the credential key (credentials stripped). */
export function credentialKey(rawUrl: string): string {
  const clean = parseCameraAuth(String(rawUrl || '')).cleanUrl.trim()
  return clean || String(rawUrl || '').trim()
}

async function loadFallbackKey(storage: CredentialStorageBridge): Promise<Buffer> {
  try {
    const stored = await storage.get(FALLBACK_KEY)
    if (typeof stored === 'string' && stored.trim()) {
      return scryptSync(Buffer.from(stored, 'base64'), SALT, KEY_LENGTH)
    }
  } catch {}
  const marker = randomBytes(KEY_LENGTH)
  try {
    await storage.set(FALLBACK_KEY, marker.toString('base64'))
  } catch {}
  return scryptSync(marker, SALT, KEY_LENGTH)
}

/** Encrypts a password with the OS vault when possible, AES-GCM otherwise. */
export async function encryptCredential(
  storage: CredentialStorageBridge,
  secure: SecureStorageBridge | undefined,
  plain: string
): Promise<{ payload: string; vault: boolean }> {
  if (secure) {
    try {
      const encrypted = await secure.encrypt(plain)
      if (encrypted) return { payload: encrypted, vault: true }
    } catch {}
  }
  const key = await loadFallbackKey(storage)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    payload: Buffer.concat([iv, tag, encrypted]).toString('base64'),
    vault: false
  }
}

/** Decrypts a stored credential; returns null when no path can recover it. */
export async function decryptCredential(
  storage: CredentialStorageBridge,
  secure: SecureStorageBridge | undefined,
  entry: StoredCredential
): Promise<string | null> {
  if (!entry?.payload) return null
  if (entry.vault) {
    if (!secure) return null
    try {
      return await secure.decrypt(entry.payload)
    } catch {
      return null
    }
  }
  try {
    const raw = Buffer.from(entry.payload, 'base64')
    if (raw.length < IV_LENGTH + TAG_LENGTH) return null
    const key = await loadFallbackKey(storage)
    const iv = raw.subarray(0, IV_LENGTH)
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
    const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH)
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

export async function loadCredentialMap(storage: CredentialStorageBridge): Promise<CredentialMap> {
  try {
    const raw = await storage.get(CREDENTIALS_KEY)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const map: CredentialMap = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = value as Partial<StoredCredential> | null
      if (!entry || typeof entry.payload !== 'string') continue
      map[key] = {
        username: typeof entry.username === 'string' ? entry.username : '',
        payload: entry.payload,
        vault: entry.vault === true
      }
    }
    return map
  } catch {
    return {}
  }
}

export async function saveCredentialMap(
  storage: CredentialStorageBridge,
  map: CredentialMap
): Promise<void> {
  await storage.set(CREDENTIALS_KEY, map)
}

/** Stores (or replaces) the credential for a camera URL. */
export async function putCredential(
  storage: CredentialStorageBridge,
  secure: SecureStorageBridge | undefined,
  map: CredentialMap,
  rawUrl: string,
  username: string,
  password: string
): Promise<void> {
  const key = credentialKey(rawUrl)
  if (!key) return
  const encrypted = await encryptCredential(storage, secure, password)
  map[key] = {
    username: String(username || ''),
    payload: encrypted.payload,
    vault: encrypted.vault
  }
  await saveCredentialMap(storage, map)
}

export async function removeCredential(
  storage: CredentialStorageBridge,
  map: CredentialMap,
  rawUrl: string
): Promise<void> {
  const key = credentialKey(rawUrl)
  if (!key || !(key in map)) return
  delete map[key]
  await saveCredentialMap(storage, map)
}

/** Loads the decrypted credential for a camera URL, if one was stored. */
export async function getCredential(
  storage: CredentialStorageBridge,
  secure: SecureStorageBridge | undefined,
  map: CredentialMap,
  rawUrl: string
): Promise<ResolvedCredential | null> {
  const entry = map[credentialKey(rawUrl)]
  if (!entry) return null
  const password = await decryptCredential(storage, secure, entry)
  if (password === null) return null
  return { username: entry.username, password }
}

export function hasCredential(map: CredentialMap, rawUrl: string): boolean {
  return credentialKey(rawUrl) in map
}
