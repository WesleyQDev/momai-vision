import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { getSDK } from 'momai:sdk'
import VisionPage from './page'

const CAM = {
  id: 'ip:http://10.0.0.1:8080/video',
  name: 'Portão',
  source: 'ip',
  online: true,
  monitors: 0
} as const

function setupServer() {
  const sdk = getSDK()
  vi.mocked(sdk.api.post).mockImplementation(async (path: string, body?: { toolName: string; args: Record<string, unknown> }) => {
    if (path !== '/extensions/momai-vision/command') return { ok: true, data: {} }
    const { toolName, args } = body || { toolName: '', args: {} }
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
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  const sdk = getSDK()
  vi.mocked(sdk.api.post).mockReset()
  vi.mocked(sdk.api.post).mockResolvedValue({ ok: true, data: {} })
})

describe('VisionPage camera context menu order', () => {
  it('orders submenus as Camera, Ver, Acoes with pause video inside Camera below edit', async () => {
    setupServer()
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    const card = (await screen.findByText('Portão')).closest('.group')
    expect(card).toBeTruthy()
    fireEvent.contextMenu(card!)

    const menu = await screen.findByRole('menu')
    const topItems = within(menu).getAllByRole('menuitem')
    const topLabels = topItems.map((el) => el.textContent?.trim())
    expect(topLabels).toEqual(['Câmera', 'Ver', 'Ações'])

    const cameraGroup = within(menu).getByRole('menuitem', { name: 'Câmera' })
    fireEvent.mouseEnter(cameraGroup.parentElement!)

    const editItem = await screen.findByRole('menuitem', { name: 'Editar Câmera' })
    const pauseItem = await screen.findByRole('menuitem', { name: 'Pausar vídeo' })
    expect(editItem).toBeTruthy()
    expect(pauseItem).toBeTruthy()

    const cameraSubmenu = pauseItem.closest('[role="menu"]')
    expect(cameraSubmenu).toBeTruthy()
    const cameraLabels = within(cameraSubmenu as HTMLElement)
      .getAllByRole('menuitem')
      .map((el) => el.textContent?.trim())
    expect(cameraLabels.indexOf('Editar Câmera')).toBe(0)
    expect(cameraLabels.indexOf('Pausar vídeo')).toBe(1)

    const actionsGroup = within(menu).getByRole('menuitem', { name: 'Ações' })
    fireEvent.mouseEnter(actionsGroup.parentElement!)

    const actionsSubmenuItems = await within(menu).findByRole('menuitem', { name: 'Tirar print' })
    expect(actionsSubmenuItems).toBeTruthy()
    expect(screen.queryByRole('menuitem', { name: 'Editar Câmera' })).toBeNull()
  })
})
