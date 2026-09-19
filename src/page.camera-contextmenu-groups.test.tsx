import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { getSDK } from 'momai:sdk'
import VisionPage from './page'

const CAM = {
  id: 'ip:http://10.0.0.1:8080/video',
  name: 'Portão',
  source: 'ip',
  online: true,
  monitors: 0
} as const
const CAM_URL = 'http://10.0.0.1:8080/video'

function setupServer() {
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = []
  const sdk = getSDK()
  vi.mocked(sdk.api.post).mockImplementation(async (path: string, body?: { toolName: string; args: Record<string, unknown> }) => {
    if (path !== '/extensions/momai-vision/command') return { ok: true, data: {} }
    const { toolName, args } = body || { toolName: '', args: {} }
    calls.push({ toolName, args })
    switch (toolName) {
      case 'list_cameras':
        return {
          ok: true,
          data: {
            cameras: [{ ...CAM, selected: true }],
            selectedCameras: [CAM.id]
          }
        }
      case 'get_status':
        return { ok: true, data: { monitors: [], cameras: { [CAM.id]: { online: true, monitors: 0 } } } }
      case 'list_alerts':
        return { ok: true, data: { alerts: [] } }
      case 'list_snapshots':
        return { ok: true, data: { snapshots: [] } }
      case 'configure':
        if (Object.keys(args).length === 0) {
          return { ok: true, data: { ok: true, config: { ipCameras: [], selectedCameras: [CAM.id] } } }
        }
        return { ok: true, data: { ok: true } }
      default:
        return { ok: true, data: {} }
    }
  })
  return { calls }
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  const sdk = getSDK()
  vi.mocked(sdk.api.post).mockReset()
  vi.mocked(sdk.api.post).mockResolvedValue({ ok: true, data: {} })
})

describe('VisionPage camera context menu groups', () => {
  it('groups camera actions under Camera, Ver and Acoes submenus', async () => {
    const { calls } = setupServer()
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    const card = screen.getByText('Portão').closest('.group')
    expect(card).toBeTruthy()
    fireEvent.contextMenu(card!)

    const menu = await screen.findByRole('menu')
    const topItems = within(menu).getAllByRole('menuitem')
    const topLabels = topItems.map((el) => el.textContent?.trim())
    expect(topLabels).toEqual(['Câmera', 'Ver', 'Ações'])

    // Flat list is gone: grouped action starts hidden inside its submenu.
    expect(screen.queryByRole('menuitem', { name: 'Pausar vídeo' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Editar Câmera' })).toBeNull()

    const cameraGroup = within(menu).getByRole('menuitem', { name: 'Câmera' })
    fireEvent.mouseEnter(cameraGroup.parentElement!)

    const pauseItem = await screen.findByRole('menuitem', { name: 'Pausar vídeo' })
    fireEvent.click(pauseItem)

    await waitFor(() => {
      const configureCall = calls.find(
        (c) => c.toolName === 'configure' && c.args.pausedCameras !== undefined
      )
      expect(configureCall).toBeTruthy()
    })
  })
})
