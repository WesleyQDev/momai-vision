import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { getSDK } from 'momai:sdk'

// panel.tsx registers the vision_alert renderer at module scope.
import VisionPanel, { VisionAlertCard } from './panel'

describe('VisionPanel', () => {
  beforeEach(() => {
    cleanup()
    const sdk = getSDK()
    vi.mocked(sdk.api.post).mockReset()
    vi.mocked(sdk.api.post).mockResolvedValue({
      ok: true,
      data: {
        monitors: [{ id: 'mon-1', cameraName: 'Garagem', triggers: [{ type: 'motion' }] }],
        cameras: { 'webcam:cam': { online: true, monitors: 1 } }
      }
    })
  })

  it('shows camera and monitor counts', async () => {
    render(<VisionPanel />)
    await screen.findByText('câmeras (1 online)')
    expect(screen.getAllByText('1')).toHaveLength(2)
    expect(screen.getByText('monitors ativos')).toBeTruthy()
  })

  it('lists active monitors with trigger types', async () => {
    render(<VisionPanel />)
    await screen.findByText('Garagem')
    expect(screen.getByText('motion')).toBeTruthy()
  })

  it('polls get_status on an interval', () => {
    vi.useFakeTimers()
    render(<VisionPanel />)
    act(() => {
      vi.advanceTimersByTime(6000)
    })
    const sdk = getSDK()
    expect(sdk.api.post).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('registers the vision_alert renderer at module scope', () => {
    const sdk = getSDK()
    expect(sdk.registry.registerRenderer).toHaveBeenCalledWith('vision_alert', expect.any(Function))
  })
})

describe('VisionAlertCard', () => {
  it('renders only the image for snapshots (no buttons or header)', () => {
    render(
      <VisionAlertCard
        data={{
          cameraName: 'Webcam',
          monitorId: 'snapshot',
          triggeredBy: 'snapshot',
          imageDataUri: 'data:image/jpeg;base64,abc'
        }}
      />
    )
    const img = screen.getByRole('img') as HTMLImageElement
    expect(img.src).toContain('data:image/jpeg;base64,abc')
    expect(screen.queryByText('Abrir MomAI')).toBeNull()
    expect(screen.queryByText('Pausar monitoramento')).toBeNull()
    expect(screen.queryByText('Webcam')).toBeNull()
  })

  it('renders the alert title, description and snapshot', () => {
    render(
      <VisionAlertCard
        data={{
          cameraName: 'Garagem',
          className: 'person',
          confidence: 0.92,
          description: 'Movimento detectado',
          imageDataUri: 'data:image/jpeg;base64,abc',
          ts: Date.now()
        }}
      />
    )
    expect(screen.getByText('Garagem')).toBeTruthy()
    expect(screen.getByText('Movimento detectado')).toBeTruthy()
    const img = screen.getByRole('img') as HTMLImageElement
    expect(img.src).toContain('data:image/jpeg;base64,abc')
  })

  it('calls onClose when the close button is pressed', () => {
    const onClose = vi.fn()
    render(<VisionAlertCard data={{ cameraName: 'Garagem', onClose }} />)
    fireEvent.click(screen.getByLabelText('Fechar'))
    expect(onClose).toHaveBeenCalled()
  })

  it('pauses the monitor via keepalive fetch and closes the overlay immediately', async () => {
    const onClose = vi.fn()
    // The overlay window is destroyed on close, which aborts a plain fetch.
    // The pause command must be sent with keepalive before closing.
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: async () => ({ ok: true }) } as unknown as Response)
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<VisionAlertCard data={{ cameraName: 'Garagem', monitorId: 'mon-9', onClose }} />)
    fireEvent.click(screen.getByText('Pausar monitoramento'))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8000/extensions/momai-vision/command')
    expect(init.method).toBe('POST')
    expect(init.keepalive).toBe(true)
    expect(JSON.parse(String(init.body))).toEqual({
      toolName: 'pause_monitoring',
      args: { monitorId: 'mon-9' }
    })
    vi.unstubAllGlobals()
  })
})
