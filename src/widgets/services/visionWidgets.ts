import { getSDK } from 'momai:sdk'

const EXT_COMMAND = '/extensions/momai-vision/command'

export interface WidgetSnapshot {
  cameraName: string
  className: string
  triggeredBy: string
  timestamp: number
  image: string
}

async function postCommand(toolName: string, args: Record<string, unknown> = {}): Promise<any> {
  const sdk = getSDK()
  const res = await sdk.api.post(EXT_COMMAND, { toolName, args })
  return (res as any)?.data ?? res
}

export async function captureWidgetFrame(cameraId: string): Promise<{ image: string; cameraName: string }> {
  const data = await postCommand('capture_snapshot', { cameraId })
  return {
    image: String(data?.imageDataUri ?? data?.annotatedImageDataUri ?? ''),
    cameraName: String(data?.cameraName ?? '')
  }
}

export async function fetchLastWidgetSnapshot(): Promise<WidgetSnapshot | null> {
  const data = await postCommand('list_snapshots', { limit: 1 })
  const list: any[] = data?.snapshots ?? []
  if (list.length === 0) return null
  const top = list[0]
  return {
    cameraName: String(top.cameraName ?? top.camera ?? 'Camera'),
    className: String(top.className ?? top.label ?? 'detection'),
    triggeredBy: String(top.triggeredBy ?? top.trigger ?? ''),
    timestamp: Number(top.ts ?? top.timestamp ?? Date.now()),
    image: String(top.imageDataUri ?? top.annotatedImageDataUri ?? '')
  }
}
