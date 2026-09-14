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
})
