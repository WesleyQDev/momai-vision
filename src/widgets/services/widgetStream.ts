import { getSDK } from 'momai:sdk'

const EXT_COMMAND = '/extensions/momai-vision/command'
const EXT_ID = 'momai-vision'

async function postCommand(toolName: string, args: Record<string, unknown> = {}): Promise<any> {
  const sdk = getSDK()
  const res = await sdk.api.post(EXT_COMMAND, { toolName, args })
  return (res as any)?.data ?? res
}

/**
 * Same MJPEG stream URL the tab cards use, so the widget shows the same
 * live video instead of snapshots.
 */
export function buildWidgetStreamUrl(cameraId: string, nonce: string | number): string | null {
  if (typeof cameraId !== 'string' || cameraId === '') return null
  const deviceId = cameraId.startsWith('webcam:') ? cameraId.slice('webcam:'.length) : cameraId
  const scope =
    typeof window !== 'undefined'
      ? (window as unknown as { api?: { getApiBaseUrl?: () => string; getSessionToken?: () => string } })
      : undefined
  const api = scope?.api
  let base = 'http://127.0.0.1:8000'
  let token = ''
  try {
    base = api?.getApiBaseUrl?.() || base
    token = api?.getSessionToken?.() || ''
  } catch {}
  return `${base}/media/camera/stream/${encodeURIComponent(deviceId)}?ext=${EXT_ID}&token=${encodeURIComponent(token)}&r=${nonce}`
}

function normalizeCameraId(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/^ip:/, '')
    .replace(/\/+$/, '')
}

export async function fetchWidgetCameraName(cameraId: string): Promise<string> {
  const target = normalizeCameraId(cameraId)

  // 1. Check local alias cache first (instant response)
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem('momai-vision:camera-names')
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, string>
        for (const [key, val] of Object.entries(parsed)) {
          if (normalizeCameraId(key) === target && typeof val === 'string' && val.trim()) {
            return val.trim()
          }
        }
      }
    }
  } catch {}

  // 2. Fetch from backend list_cameras
  const data = await postCommand('list_cameras', {})
  const list: any[] = data?.cameras ?? []
  const found = list.find((entry) => {
    if (normalizeCameraId(entry?.id) === target) return true
    const entryId = normalizeCameraId(entry?.id)
    if (entryId !== '' && target !== '' && (entryId.includes(target) || target.includes(entryId))) return true
    return false
  })
  const name = String(found?.name ?? found?.label ?? '').trim()
  // Never fall back to the IP/URL itself: return '' so callers use a generic title.
  if (name === '' || normalizeCameraId(name) === target) return ''
  return name
}

export interface WidgetCameraStatus {
  name: string
  isActive: boolean
  hasAnyCamera: boolean
  firstCameraId?: string
}

export async function fetchWidgetCameraStatus(cameraId: string): Promise<WidgetCameraStatus> {
  const target = normalizeCameraId(cameraId)
  let name = ''

  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem('momai-vision:camera-names')
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, string>
        for (const [key, val] of Object.entries(parsed)) {
          if (normalizeCameraId(key) === target && typeof val === 'string' && val.trim()) {
            name = val.trim()
            break
          }
        }
      }
    }
  } catch {}

  const data = await postCommand('list_cameras', {}).catch(() => null)
  const list: any[] = data?.cameras ?? []
  const hasAnyCamera = list.length > 0
  const found = list.find((entry) => {
    if (!target) return false
    if (normalizeCameraId(entry?.id) === target) return true
    const entryId = normalizeCameraId(entry?.id)
    if (entryId !== '' && target !== '' && (entryId.includes(target) || target.includes(entryId))) return true
    return false
  })

  if (found) {
    const foundName = String(found?.name ?? found?.label ?? '').trim()
    if (foundName && normalizeCameraId(foundName) !== target) {
      name = foundName
    }
  }

  const firstCamera = list[0]
  const firstCameraId = firstCamera?.id ? String(firstCamera.id) : undefined
  const firstName = String(firstCamera?.name ?? firstCamera?.label ?? '').trim()

  return {
    name: name || (firstCameraId && normalizeCameraId(firstName) !== normalizeCameraId(firstCameraId) ? firstName : ''),
    isActive: Boolean(found),
    hasAnyCamera,
    firstCameraId
  }
}

/**
 * Lightweight latest frame (no snapshot saved, no chat message), used to
 * validate the camera and as a fallback when the MJPEG stream isDown.
 */
export async function fetchWidgetFrame(cameraId: string): Promise<{ image: string }> {
  const data = await postCommand('get_frame', { cameraId })
  if (data && (data as any).ok === false) {
    throw new Error(String((data as any).error || 'Frame failed.'))
  }
  const jpeg = String((data as any)?.jpegBase64 ?? '')
  if (jpeg === '') throw new Error('no frame available')
  return { image: `data:image/jpeg;base64,${jpeg}` }
}

export async function sendWidgetCommand(toolName: string, args: Record<string, unknown> = {}): Promise<any> {
  return postCommand(toolName, args)
}
