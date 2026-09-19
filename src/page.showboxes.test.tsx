import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { getSDK } from 'momai:sdk'
import VisionPage, { CameraCard } from './page'

const IP_CAM = { id: 'ip:http://10.0.0.1:8080/video', name: 'Portão', source: 'ip', online: true, monitors: 0 } as const

interface ServerState {
  cameras: Array<{ id: string; name: string; source: 'webcam' | 'ip'; online: boolean; monitors: number }>
  selectedCameras: string[]
  showBoxes: Record<string, boolean>
  monitors: Array<{ id: string; cameraId: string; cameraName: string; triggers: Array<{ type: string }>; paused: boolean }>
}

function setupServer(initial: Partial<ServerState> = {}) {
  const state: ServerState = {
    cameras: [],
    selectedCameras: [],
    showBoxes: {},
    monitors: [],
    ...initial
  }
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = []
  const sdk = getSDK()
  vi.mocked(sdk.api.post).mockImplementation(async (path: string, body?: { toolName: string; args: Record<string, unknown> }) => {
    if (path !== '/extensions/momai-vision/command') {
      return { ok: true, data: {} }
    }
    const { toolName, args } = body || { toolName: '', args: {} }
    calls.push({ toolName, args })
    switch (toolName) {
      case 'list_cameras':
        return {
          ok: true,
          data: {
            cameras: state.cameras.map((c) => ({ ...c, selected: state.selectedCameras.includes(c.id) })),
            selectedCameras: [...state.selectedCameras]
          }
        }
      case 'get_status':
        return {
          ok: true,
          data: {
            monitors: state.monitors.map((m) => ({ ...m })),
            cameras: Object.fromEntries(state.cameras.map((c) => [c.id, { online: c.online, monitors: c.monitors }])),
            showBoxes: { ...state.showBoxes }
          }
        }
      case 'list_alerts':
        return { ok: true, data: { alerts: [] } }
      case 'list_snapshots':
        return { ok: true, data: { snapshots: [] } }
      case 'configure':
        if (Object.keys(args).length === 0) {
          return { ok: true, data: { ok: true, config: { showBoxes: { ...state.showBoxes }, selectedCameras: [...state.selectedCameras] } } }
        }
        if (args.showBoxes !== undefined) state.showBoxes = { ...(args.showBoxes as Record<string, boolean>) }
        return { ok: true, data: { ok: true, config: { showBoxes: { ...state.showBoxes }, selectedCameras: [...state.selectedCameras] } } }
      default:
        return { ok: true, data: {} }
    }
  })
  return { calls, state }
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  const sdk = getSDK()
  vi.mocked(sdk.api.post).mockReset()
  vi.mocked(sdk.api.post).mockResolvedValue({ ok: true, data: {} })
})

async function openSubmenuItem(groupLabel: string, itemLabel: string) {
  const group = await screen.findByRole('menuitem', { name: groupLabel })
  fireEvent.mouseEnter(group.parentElement!)
  const item = await screen.findByRole('menuitem', { name: itemLabel })
  return item
}

describe('VisionPage — Mostrar boxes por câmera (MOM-173)', () => {
  it('menu oferece Esconder boxes e persiste sem pausar nada nem abrir preview', async () => {
    const { calls } = setupServer({
      cameras: [{ ...IP_CAM }],
      selectedCameras: [IP_CAM.id],
      monitors: []
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    fireEvent.contextMenu(await screen.findByTitle('Portão'))
    fireEvent.click(await openSubmenuItem('Ver', 'Esconder boxes'))

    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.showBoxes !== undefined)
      expect(write).toBeTruthy()
      expect((write!.args.showBoxes as Record<string, boolean>)[IP_CAM.id]).toBe(false)
    })
    expect(calls.some((c) => c.toolName === 'pause_monitoring')).toBe(false)
    expect(document.body.textContent).not.toContain('Dois cliques para fechar')
  })

  it('rótulo alterna para Mostrar boxes após esconder', async () => {
    const { calls } = setupServer({
      cameras: [{ ...IP_CAM }],
      selectedCameras: [IP_CAM.id],
      monitors: []
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    fireEvent.contextMenu(await screen.findByTitle('Portão'))
    fireEvent.click(await openSubmenuItem('Ver', 'Esconder boxes'))
    await waitFor(() => {
      expect(calls.some((c) => c.toolName === 'configure' && c.args.showBoxes !== undefined)).toBe(true)
    })

    fireEvent.contextMenu(await screen.findByTitle('Portão'))
    fireEvent.mouseEnter((await screen.findByRole('menuitem', { name: 'Ver' })).parentElement!)
    expect(await screen.findByRole('menuitem', { name: 'Mostrar boxes' })).toBeTruthy()
  })

  it('ampliada tem o toggle de boxes e persiste sem fechar', async () => {
    const { calls } = setupServer({
      cameras: [{ ...IP_CAM }],
      selectedCameras: [IP_CAM.id],
      monitors: []
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    fireEvent.click(await screen.findByRole('button', { name: 'Ampliar imagem (tela cheia)' }))
    await screen.findByTitle('Dois cliques para fechar')

    const header = screen.getByTestId('expanded-header')
    fireEvent.click(within(header).getByRole('button', { name: 'Ver' }))
    fireEvent.click(within(header).getByRole('menuitem', { name: 'Esconder boxes' }))
    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.showBoxes !== undefined)
      expect(write).toBeTruthy()
      expect((write!.args.showBoxes as Record<string, boolean>)[IP_CAM.id]).toBe(false)
    })
    // A ampliada continua aberta
    expect(await screen.findByTitle('Dois cliques para fechar')).toBeTruthy()
  })

  it('CameraCard com showBoxes=false não desenha, mas mantém os dados', async () => {
    const boxes = [{ className: 'person', confidence: 0.9, x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 }]
    const camera = { id: IP_CAM.id, name: 'Portão', source: 'ip' as const, online: true, monitors: 0 }
    const boxLabels = (container: HTMLElement) =>
      [...container.querySelectorAll('svg text')].filter((el) => el.textContent?.includes('%'))

    const hidden = render(
      <CameraCard camera={camera} boxes={boxes} showBoxes={false} onSnapshot={() => {}} index={0} />
    )
    expect(boxLabels(hidden.container)).toHaveLength(0)

    cleanup()
    const shown = render(
      <CameraCard camera={camera} boxes={boxes} onSnapshot={() => {}} index={0} />
    )
    expect(boxLabels(shown.container).length).toBeGreaterThan(0)
  })

  it('menu de contexto oferece Esconder área selecionada e persiste showZones', async () => {
    const { calls } = setupServer({
      cameras: [{ ...IP_CAM }],
      selectedCameras: [IP_CAM.id],
      monitors: []
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    fireEvent.contextMenu(await screen.findByTitle('Portão'))
    fireEvent.click(await openSubmenuItem('Ver', 'Esconder área selecionada'))

    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.showZones !== undefined)
      expect(write).toBeTruthy()
      expect((write!.args.showZones as Record<string, boolean>)[IP_CAM.id]).toBe(false)
    })
  })

  it('ampliada tem o toggle de área selecionada dentro do botão Ver e persiste', async () => {
    const { calls } = setupServer({
      cameras: [{ ...IP_CAM }],
      selectedCameras: [IP_CAM.id],
      monitors: []
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    fireEvent.click(await screen.findByRole('button', { name: 'Ampliar imagem (tela cheia)' }))
    await screen.findByTitle('Dois cliques para fechar')

    const header = screen.getByTestId('expanded-header')
    fireEvent.click(within(header).getByRole('button', { name: 'Ver' }))
    fireEvent.click(within(header).getByRole('menuitem', { name: 'Esconder área selecionada' }))
    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.showZones !== undefined)
      expect(write).toBeTruthy()
      expect((write!.args.showZones as Record<string, boolean>)[IP_CAM.id]).toBe(false)
    })
    expect(await screen.findByTitle('Dois cliques para fechar')).toBeTruthy()
  })

  it('vídeo ampliado abre menu de contexto com clique direito', async () => {
    setupServer({
      cameras: [{ ...IP_CAM }],
      selectedCameras: [IP_CAM.id],
      monitors: []
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    fireEvent.click(await screen.findByRole('button', { name: 'Ampliar imagem (tela cheia)' }))
    const expandedVideo = await screen.findByTestId('expanded-video')

    fireEvent.contextMenu(expandedVideo)
    expect(await screen.findByRole('menuitem', { name: 'Ver' })).toBeTruthy()
    expect(await screen.findByRole('menuitem', { name: 'Ações' })).toBeTruthy()
    expect(await screen.findByRole('menuitem', { name: 'Câmera' })).toBeTruthy()
    fireEvent.mouseEnter((await screen.findByRole('menuitem', { name: 'Câmera' })).parentElement!)
    expect(await screen.findByRole('menuitem', { name: 'Editar Câmera' })).toBeTruthy()
    expect(await screen.findByRole('menuitem', { name: 'Copiar URL' })).toBeTruthy()
    fireEvent.mouseEnter((await screen.findByRole('menuitem', { name: 'Ações' })).parentElement!)
    expect(await screen.findByRole('menuitem', { name: 'Tirar print' })).toBeTruthy()
    fireEvent.mouseEnter((await screen.findByRole('menuitem', { name: 'Ver' })).parentElement!)
    expect(await screen.findByRole('menuitem', { name: 'Esconder boxes' })).toBeTruthy()
    expect(await screen.findByRole('menuitem', { name: 'Esconder área selecionada' })).toBeTruthy()
  })

  it('CameraCard com showZone=false não desenha o polígono da área', async () => {
    const zone = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }]
    const camera = { id: IP_CAM.id, name: 'Portão', source: 'ip' as const, online: true, monitors: 0 }

    const hidden = render(
      <CameraCard camera={camera} zone={zone} showZone={false} onSnapshot={() => {}} index={0} />
    )
    expect(hidden.container.querySelectorAll('polygon')).toHaveLength(0)

    cleanup()
    const shown = render(
      <CameraCard camera={camera} zone={zone} showZone={true} onSnapshot={() => {}} index={0} />
    )
    expect(shown.container.querySelectorAll('polygon')).toHaveLength(1)
  })

  it('card da câmera tem botão de alternar área selecionada e persiste', async () => {
    const { calls } = setupServer({
      cameras: [{ ...IP_CAM }],
      selectedCameras: [IP_CAM.id],
      monitors: []
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    const toggleZoneBtn = await screen.findByRole('button', { name: 'Esconder área selecionada' })
    expect(toggleZoneBtn).toBeTruthy()

    fireEvent.click(toggleZoneBtn)
    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.showZones !== undefined)
      expect(write).toBeTruthy()
      expect((write!.args.showZones as Record<string, boolean>)[IP_CAM.id]).toBe(false)
    })
  })
})
