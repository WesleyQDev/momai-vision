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
    expect(screen.queryByText('Parar monitoramento')).toBeNull()
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

  it('stops the monitor via the command route', async () => {
    const onClose = vi.fn()
    const sdk = getSDK()
    vi.mocked(sdk.api.post).mockResolvedValue({ ok: true, data: { ok: true } })
    render(<VisionAlertCard data={{ cameraName: 'Garagem', monitorId: 'mon-9', onClose }} />)
    fireEvent.click(screen.getByText('Parar monitoramento'))
    await act(async () => {})
    expect(sdk.api.post).toHaveBeenCalledWith('/extensions/momai-vision/command', {
      toolName: 'stop_monitoring',
      args: { monitorId: 'mon-9' }
    })
    expect(onClose).toHaveBeenCalled()
  })
})
