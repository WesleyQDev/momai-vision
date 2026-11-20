import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import EditCameraModal, { type EditingCameraTarget } from './EditCameraModal'

const IP_TARGET: EditingCameraTarget = {
  id: 'ip:rtsp://192.168.0.2:554/onvif2',
  name: 'wea',
  source: 'ip',
  url: 'rtsp://192.168.0.2:554/onvif2',
  transport: 'udp',
  previewWidth: 640
}

describe('EditCameraModal — preview width and codec', () => {
  it('saves the chosen preview width with the rest of the camera config', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<EditCameraModal target={IP_TARGET} onClose={() => {}} onSave={onSave} />)

    const select = screen.getByLabelText(/Resolução da prévia|Preview resolution/i) as HTMLSelectElement
    expect(select.value).toBe('640')

    fireEvent.change(select, { target: { value: '1280' } })
    expect(select.value).toBe('1280')

    fireEvent.click(screen.getByRole('button', { name: /Salvar|Save/i }))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        IP_TARGET.id,
        expect.objectContaining({ previewWidth: 1280 })
      )
    )
  })

  it('saves the chosen video codec with the camera config', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<EditCameraModal target={IP_TARGET} onClose={() => {}} onSave={onSave} />)

    const codecSelect = screen.getByLabelText(/Protocolo de vídeo|Video protocol/i) as HTMLSelectElement
    expect(codecSelect.value).toBe('h264')

    fireEvent.change(codecSelect, { target: { value: 'h265' } })
    expect(codecSelect.value).toBe('h265')

    fireEvent.click(screen.getByRole('button', { name: /Salvar|Save/i }))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        IP_TARGET.id,
        expect.objectContaining({ codec: 'h265' })
      )
    )
  })

  it('renders full-screen layout when window is not maximized', () => {
    render(<EditCameraModal target={IP_TARGET} onClose={() => {}} onSave={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('w-full h-full max-w-none max-h-none rounded-none border-0')
  })

  it('defaults economy mode to active, moves knob on toggle, saves false, and toggles help balloon', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<EditCameraModal target={IP_TARGET} onClose={() => {}} onSave={onSave} />)

    const toggle = screen.getByRole('switch', { name: /Modo Econômico|Economy Mode/i })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    const knob = toggle.querySelector('span') as HTMLSpanElement
    expect(knob.style.transform).toBe('translateX(18px)')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(knob.style.transform).toBe('translateX(2px)')

    fireEvent.click(screen.getByRole('button', { name: /Salvar|Save/i }))
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        IP_TARGET.id,
        expect.objectContaining({ economyMode: false })
      )
    )

    const helpBtn = screen.getByRole('button', { name: /Modo Econômico|Economy Mode/i })
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(helpBtn)
    expect(screen.getByRole('status')).toBeTruthy()
    fireEvent.click(helpBtn)
    expect(screen.queryByRole('status')).toBeNull()
  })
})
