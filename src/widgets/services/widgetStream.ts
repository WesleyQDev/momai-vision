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

export async function fetchWidgetCameraName(cameraId: string): Promise<string> {
  const data = await postCommand('list_cameras', {})
  const list: any[] = data?.cameras ?? []
  const found = list.find((entry) => entry?.id === cameraId)
  return String(found?.name ?? found?.label ?? cameraId ?? '')
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
