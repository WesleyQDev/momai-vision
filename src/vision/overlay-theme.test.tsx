import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { getSDK } from 'momai:sdk'
import {
  overlayLabelColor,
  zoneFillColor,
  zoneStrokeColor,
  zoneVertexColor,
  zoneVertexStrokeColor,
} from './theme-color'
import { VisionAlertCard } from '../panel'
import { CameraCard } from '../page'

function setThemeVar(name: string, value: string): void {
  document.documentElement.style.setProperty(name, value)
}

function clearThemeVars(): void {
  for (const name of ['--text-primary', '--error', '--accent', '--highlight']) {
    document.documentElement.style.removeProperty(name)
  }
}

beforeEach(() => {
  cleanup()
  clearThemeVars()
  localStorage.clear()
  const sdk = getSDK()
  vi.mocked(sdk.api.post).mockReset()
  vi.mocked(sdk.api.post).mockResolvedValue({ ok: true, data: {} })
  vi.mocked(sdk.api.get).mockReset()
  vi.mocked(sdk.api.get).mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  clearThemeVars()
})

describe('Vision overlays follow host theme (MOM-220)', () => {
  it('uses fallback label color only when theme token is missing', () => {
    expect(overlayLabelColor()).toBe('#0a0a0a')
  })

  it('reads label color from theme when token exists', () => {
    setThemeVar('--text-primary', '20 20 25')
    expect(overlayLabelColor()).not.toBe('#0a0a0a')
    expect(overlayLabelColor()).toContain('20')
  })

  it('reads zone colors from theme with fallback only without tokens', () => {
    expect(zoneFillColor(true)).toBe('rgba(239, 68, 68, 0.16)')
    expect(zoneStrokeColor(false)).toContain('56')
    setThemeVar('--error', '220 38 38')
    setThemeVar('--accent', '139 92 246')
    expect(zoneFillColor(true)).not.toBe('rgba(239, 68, 68, 0.16)')
    expect(zoneFillColor(true)).toContain('220')
    expect(zoneStrokeColor(false)).toContain('139')
  })

  it('reads vertex colors from theme with fallback only without tokens', () => {
    expect(zoneVertexColor(false)).toBe('#ef4444')
    expect(zoneVertexStrokeColor()).toBe('#ffffff')
    setThemeVar('--highlight', '250 204 21')
    setThemeVar('--text-primary', '20 20 25')
    expect(zoneVertexColor(true)).toContain('250')
    expect(zoneVertexStrokeColor()).not.toBe('#ffffff')
  })

  it('floating alert card uses host theme tokens instead of zinc/gray', () => {
    const { container } = render(
      <VisionAlertCard
        data={{
          cameraName: 'Garagem',
          className: 'person',
          confidence: 0.9,
          description: 'Movimento detectado',
          imageDataUri: 'data:image/jpeg;base64,abc',
        }}
      />
    )
    const card = container.firstElementChild as HTMLElement
    const classes = card.className
    expect(classes).toContain('bg-card')
    expect(classes).toContain('text-text')
    expect(classes).toContain('border-border')
    expect(classes).not.toContain('bg-zinc-900')
    expect(classes).not.toContain('text-gray-100')
    expect(classes).not.toContain('border-white/10')
  })

  it('camera boxes label follows theme instead of hardcoded fill', () => {
    setThemeVar('--text-primary', '20 20 25')
    const boxes = [{ className: 'person', confidence: 0.9, x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 }]
    const camera = { id: 'ip:test', name: 'Portao', source: 'ip' as const, online: true, monitors: 0 }
    const { container } = render(
      <CameraCard camera={camera} boxes={boxes} onSnapshot={() => {}} index={0} />
    )
    const label = container.querySelector('svg text')
    expect(label).toBeTruthy()
    expect(label?.getAttribute('fill')).not.toBe('#0a0a0a')
  })
})
