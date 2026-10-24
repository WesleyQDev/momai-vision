import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { getSDK } from 'momai:sdk'
import VisionPage, { getPtzDefaultPosition } from './page'

const IP_CAM = {
  id: 'ip:192.168.0.3:5000',
  name: 'Quintal',
  source: 'ip' as const,
  online: true,
  monitors: 0,
  url: 'rtsp://192.168.0.3:554/onvif1'
}

function setupServer() {
  const sdk = getSDK()
  vi.mocked(sdk.api.post).mockImplementation(async (path: string, body?: { toolName: string; args: Record<string, unknown> }) => {
    const { toolName } = body || { toolName: '', args: {} }
    switch (toolName) {
      case 'list_cameras':
        return {
          ok: true,
          data: {
            cameras: [{ ...IP_CAM, selected: true }],
            availableWebcams: [],
            selectedCameras: [IP_CAM.id]
          }
        }
      case 'get_status':
        return {
          ok: true,
          data: {
            monitors: [],
            cameras: {
              [IP_CAM.id]: { online: true, monitors: 0 }
            }
          }
        }
      case 'list_alerts':
        return { ok: true, data: { alerts: [] } }
      case 'list_snapshots':
        return { ok: true, data: { snapshots: [] } }
      default:
        return { ok: true, data: {} }
    }
  })
}

describe('getPtzDefaultPosition helper', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1200 })
    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 800 })
  })

  it('centers in viewport when isExpanded is true and is not compact', () => {
    const pos = getPtzDefaultPosition('any-camera-id', true)
    expect(pos.x).toBe(504) // (1200 - 192) / 2
    expect(pos.y).toBe(298) // Math.round((800 - 205) / 2) = 298
    expect(pos.compact).toBe(false)
  })

  it('centers compact overlay on the camera card to the left in windowed mode (card width < 550)', () => {
    const leftEl = document.createElement('div')
    leftEl.setAttribute('data-camera-card-id', 'webcam-left')
    document.body.appendChild(leftEl)
    leftEl.getBoundingClientRect = () => ({
      left: 100,
      right: 500,
      top: 150,
      bottom: 450,
      width: 400,
      height: 300,
      x: 100,
      y: 150,
      toJSON: () => {}
    })

    const rightEl = document.createElement('div')
    rightEl.setAttribute('data-camera-card-id', 'ip-right')
    document.body.appendChild(rightEl)
    rightEl.getBoundingClientRect = () => ({
      left: 550,
      right: 950,
      top: 150,
      bottom: 450,
      width: 400,
      height: 300,
      x: 550,
      y: 150,
      toJSON: () => {}
    })

    // Clicked PTZ on the IP camera on the right in windowed mode
    const pos = getPtzDefaultPosition('ip-right', false)

    // In windowed mode (card < 550px), uses compact 144x152 overlay:
    // left = 100 + (400 - 144) / 2 = 228
    // top = 150 + (300 - 152) / 2 = 224
    expect(pos.compact).toBe(true)
    expect(pos.x).toBe(228)
    expect(pos.y).toBe(224)

    document.body.removeChild(leftEl)
    document.body.removeChild(rightEl)
  })

  it('centers standard overlay on the camera card in maximized mode (card width >= 550 and window >= 1200)', () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1920 })
    Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 1080 })

    const leftEl = document.createElement('div')
    leftEl.setAttribute('data-camera-card-id', 'ip-left')
    document.body.appendChild(leftEl)
    leftEl.getBoundingClientRect = () => ({
      left: 100,
      right: 900,
      top: 150,
      bottom: 600,
      width: 800,
      height: 450,
      x: 100,
      y: 150,
      toJSON: () => {}
    })

    const rightEl = document.createElement('div')
    rightEl.setAttribute('data-camera-card-id', 'cam-right')
    document.body.appendChild(rightEl)
    rightEl.getBoundingClientRect = () => ({
      left: 960,
      right: 1760,
      top: 150,
      bottom: 600,
      width: 800,
      height: 450,
      x: 960,
      y: 150,
      toJSON: () => {}
    })

    const pos = getPtzDefaultPosition('ip-left', false)

    // In maximized mode, uses standard 192x205 overlay on the right camera:
    // left = 960 + (800 - 192) / 2 = 1264
    // top = 150 + (450 - 205) / 2 = 272.5 -> rounded to 273
    expect(pos.compact).toBe(false)
    expect(pos.x).toBe(1264)
    expect(pos.y).toBe(273)

    document.body.removeChild(leftEl)
    document.body.removeChild(rightEl)
  })

  it('opens in the empty grid slot beside the card when there is no other camera card in the row', () => {
    const cardEl = document.createElement('div')
    cardEl.setAttribute('data-camera-card-id', 'single-cam')
    document.body.appendChild(cardEl)

    cardEl.getBoundingClientRect = () => ({
      left: 100,
      right: 500,
      top: 100,
      bottom: 400,
      width: 400,
      height: 300,
      x: 100,
      y: 100,
      toJSON: () => {}
    })

    const pos = getPtzDefaultPosition('single-cam', false)
    // Sem câmera vizinha, usa o slot vazio à direita (100 + 400 + 24 = 524),
    // exatamente onde o card de outra câmera ficaria.
    // Compact 144x152, centrado no slot:
    // x = 524 + (400 - 144) / 2 = 652
    // y = 100 + (300 - 152) / 2 = 174
    expect(pos.compact).toBe(true)
    expect(pos.x).toBe(652)
    expect(pos.y).toBe(174)

    document.body.removeChild(cardEl)
  })

  it('centers on own card (offset by the scoped container) when there is no room for another slot', () => {
    const container = document.createElement('div')
    container.className = 'ext-momai-vision'
    document.body.appendChild(container)
    container.getBoundingClientRect = () => ({
      left: 68,
      right: 1000,
      top: 40,
      bottom: 700,
      width: 932,
      height: 660,
      x: 68,
      y: 40,
      toJSON: () => {}
    })

    const cardEl = document.createElement('div')
    cardEl.setAttribute('data-camera-card-id', 'cam-1')
    container.appendChild(cardEl)
    cardEl.getBoundingClientRect = () => ({
      left: 68,
      right: 1000,
      top: 40,
      bottom: 700,
      width: 932,
      height: 660,
      x: 68,
      y: 40,
      toJSON: () => {}
    })

    const pos = getPtzDefaultPosition('cam-1', false)
    // O card ocupa o container inteiro: não há slot vizinho, então cai no
    // próprio card.
    // targetCenterX = 68 + 932/2 = 534
    // targetCenterY = 40 + 660/2 = 370
    // relative to container (left: 68, top: 40):
    // relativeCenterX = 534 - 68 = 466
    // relativeCenterY = 370 - 40 = 330
    // x = 466 - 144/2 = 394
    // y = 330 - 152/2 = 254
    expect(pos.compact).toBe(true)
    expect(pos.x).toBe(394)
    expect(pos.y).toBe(254)

    document.body.removeChild(container)
  })
})

describe('VisionPage PTZ overlay tab & visibility behavior', () => {
  beforeEach(() => {
    setupServer()
    localStorage.clear()
    localStorage.setItem('momai-vision:cameras', JSON.stringify([IP_CAM]))
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('opens PTZ overlay on toggle and closes it when switching to another tab', async () => {
    render(<VisionPage isActive={true} />)

    // Wait for camera card to be displayed
    await waitFor(() => {
      expect(screen.getByText('Quintal')).toBeTruthy()
    })

    // Find and click PTZ button on the camera card
    const ptzBtn = screen.getByTitle('Controle PTZ')
    expect(ptzBtn).toBeTruthy()
    fireEvent.click(ptzBtn)

    // PTZ overlay should now be visible
    await waitFor(() => {
      expect(screen.getByTitle('Fechar PTZ')).toBeTruthy()
      expect(screen.getByTitle('Cima')).toBeTruthy()
    })

    // Switch to another tab, e.g. Alerts ('Alertas')
    const alertsTab = screen.getByRole('button', { name: /Alertas/i })
    fireEvent.click(alertsTab)

    // PTZ overlay should be closed
    await waitFor(() => {
      expect(screen.queryByTitle('Fechar PTZ')).toBeNull()
    })

    // Switch back to Cameras tab
    const camerasTab = screen.getByRole('button', { name: /Câmeras/i })
    fireEvent.click(camerasTab)

    // Upon returning, the PTZ overlay remains closed
    expect(screen.queryByTitle('Fechar PTZ')).toBeNull()
  })

  it('closes PTZ overlay when isActive becomes false (switching to another extension)', async () => {
    const { rerender } = render(<VisionPage isActive={true} />)

    await waitFor(() => {
      expect(screen.getByText('Quintal')).toBeTruthy()
    })

    // Open PTZ
    const ptzBtn = screen.getByTitle('Controle PTZ')
    fireEvent.click(ptzBtn)

    await waitFor(() => {
      expect(screen.getByTitle('Fechar PTZ')).toBeTruthy()
    })

    // User switches to another extension tab in MomAI
    rerender(<VisionPage isActive={false} />)

    await waitFor(() => {
      expect(screen.queryByTitle('Fechar PTZ')).toBeNull()
    })

    // User returns to MomAI Vision tab
    rerender(<VisionPage isActive={true} />)

    // PTZ overlay must remain closed on return
    expect(screen.queryByTitle('Fechar PTZ')).toBeNull()
  })

  it('closes PTZ overlay when document becomes hidden', async () => {
    render(<VisionPage isActive={true} />)

    await waitFor(() => {
      expect(screen.getByText('Quintal')).toBeTruthy()
    })

    // Open PTZ
    const ptzBtn = screen.getByTitle('Controle PTZ')
    fireEvent.click(ptzBtn)

    await waitFor(() => {
      expect(screen.getByTitle('Fechar PTZ')).toBeTruthy()
    })

    // Simulate switching window/tab
    Object.defineProperty(document, 'hidden', { writable: true, configurable: true, value: true })
    fireEvent(document, new Event('visibilitychange'))

    await waitFor(() => {
      expect(screen.queryByTitle('Fechar PTZ')).toBeNull()
    })
  })

  it('closes PTZ overlay when expanding a webcam or non-IP camera', async () => {
    const WEBCAM = {
      id: 'webcam:0',
      name: 'USB 2.0',
      source: 'webcam' as const,
      online: true,
      monitors: 0
    }
    const sdk = getSDK()
    vi.mocked(sdk.api.post).mockImplementation(async (path: string, body?: { toolName: string; args: Record<string, unknown> }) => {
      const { toolName } = body || { toolName: '', args: {} }
      switch (toolName) {
        case 'list_cameras':
          return {
            ok: true,
            data: {
              cameras: [{ ...IP_CAM, selected: true }, { ...WEBCAM, selected: true }],
              availableWebcams: [{ id: '0', label: 'USB 2.0' }],
              selectedCameras: [IP_CAM.id, WEBCAM.id]
            }
          }
        case 'get_status':
          return {
            ok: true,
            data: {
              monitors: [],
              cameras: {
                [IP_CAM.id]: { online: true, monitors: 0 },
                [WEBCAM.id]: { online: true, monitors: 0 }
              }
            }
          }
        case 'list_alerts':
          return { ok: true, data: { alerts: [] } }
        case 'list_snapshots':
          return { ok: true, data: { snapshots: [] } }
        default:
          return { ok: true, data: {} }
      }
    })

    localStorage.setItem('momai-vision:cameras', JSON.stringify([IP_CAM, WEBCAM]))
    render(<VisionPage isActive={true} />)

    await waitFor(() => {
      expect(screen.getByText('Quintal')).toBeTruthy()
      expect(screen.getByText('USB 2.0')).toBeTruthy()
    })

    // Open PTZ on Quintal
    const ptzBtn = screen.getByTitle('Controle PTZ')
    fireEvent.click(ptzBtn)

    await waitFor(() => {
      expect(screen.getByTitle('Fechar PTZ')).toBeTruthy()
    })

    // Now expand USB 2.0 (webcam)
    const expandButtons = screen.getAllByTitle(/Ampliar imagem/i)
    fireEvent.click(expandButtons[1])

    // PTZ must close because USB 2.0 is a webcam (not an IP camera)
    await waitFor(() => {
      expect(screen.queryByTitle('Fechar PTZ')).toBeNull()
    })
  })
})
