import { describe, expect, it } from 'vitest'
import manifest from '../manifest.json'

describe('vision widgets manifest', () => {
  it('declares live and last-detection widgets for the gallery', () => {
    const widgets = (manifest as any)?.ui?.widgets ?? []
    const types = widgets.map((w: any) => w.type)
    expect(types).toContain('momai-vision-live-widget')
    expect(types).toContain('momai-vision-last-detection-widget')
  })

  it('declares gallery setup pointing at list_cameras', () => {
    const widgets = (manifest as any)?.ui?.widgets ?? []
    const live = widgets.find((w: any) => w.type === 'momai-vision-live-widget')
    expect(live?.setup?.mode).toBe('single')
    expect(live?.setup?.optionsTool).toBe('list_cameras')
    expect(live?.setup?.configField).toBe('cameraId')
  })
})
