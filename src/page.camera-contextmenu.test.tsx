import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { getSDK } from 'momai:sdk'
import VisionPage from './page'

const IP_CAM = { id: 'ip:http://10.0.0.1:8080/video', name: 'Portão', source: 'ip', online: true, monitors: 1 } as const
const IP_URL = 'http://10.0.0.1:8080/video'

interface ServerState {
  cameras: Array<{ id: string; name: string; source: 'webcam' | 'ip'; online: boolean; monitors: number }>
  selectedCameras: string[]
  ipCameras: Array<{ id: string; name: string; url: string; transport?: string }>
  monitors: Array<{ id: string; cameraId: string; cameraName: string; triggers: Array<{ type: string }>; paused: boolean }>
}

function setupServer(initial: Partial<ServerState> = {}) {
  const state: ServerState = {
    cameras: [],
    selectedCameras: [],
    ipCameras: [],
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
            cameras: Object.fromEntries(state.cameras.map((c) => [c.id, { online: c.online, monitors: c.monitors }]))
          }
        }
      case 'list_alerts':
        return { ok: true, data: { alerts: [] } }
      case 'list_snapshots':
        return { ok: true, data: { snapshots: [] } }
      case 'configure':
        if (Object.keys(args).length === 0) {
          return { ok: true, data: { ok: true, config: { ipCameras: [...state.ipCameras], selectedCameras: [...state.selectedCameras] } } }
        }
        if (args.selectedCameras !== undefined) state.selectedCameras = [...(args.selectedCameras as string[])]
        if (args.ipCameras !== undefined) state.ipCameras = [...(args.ipCameras as ServerState['ipCameras'])]
        return { ok: true, data: { ok: true, config: { ipCameras: [...state.ipCameras], selectedCameras: [...state.selectedCameras] } } }
      case 'pause_monitoring':
        state.monitors = state.monitors.map((m) => (m.id === (args as { monitorId: string }).monitorId ? { ...m, paused: true } : m))
        return { ok: true, data: { ok: true } }
      case 'resume_monitoring':
        state.monitors = state.monitors.map((m) => (m.id === (args as { monitorId: string }).monitorId ? { ...m, paused: false } : m))
        return { ok: true, data: { ok: true } }
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
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => {}) },
    configurable: true
  })
})

async function openCameraContextMenu(name: string) {
  const label = await screen.findByTitle(name)
  fireEvent.contextMenu(label)
}

async function openSubmenuItem(groupLabel: string, itemLabel: string) {
  const group = await screen.findByRole('menuitem', { name: groupLabel })
  fireEvent.mouseEnter(group.parentElement!)
  return screen.findByRole('menuitem', { name: itemLabel })
}

describe('VisionPage — clique direito no card da câmera (MOM-195)', () => {
  it('abre menu com Editar sem abrir o preview', async () => {
    setupServer({
      cameras: [{ ...IP_CAM }],
      selectedCameras: [IP_CAM.id],
      ipCameras: [{ id: IP_CAM.id, name: 'Portão', url: IP_URL, transport: 'udp' }],
      monitors: []
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    await openCameraContextMenu('Portão')

    expect(await screen.findByRole('menuitem', { name: 'Câmera' })).toBeTruthy()
    expect(await openSubmenuItem('Câmera', 'Editar Câmera')).toBeTruthy()
    fireEvent.mouseEnter((await screen.findByRole('menuitem', { name: 'Ver' })).parentElement!)
    expect(screen.queryByText('Ampliar imagem')).toBeTruthy()
    // Preview (modal expandido) não deve abrir com o botão direito
    expect(document.body.textContent).not.toContain('Dois cliques para fechar')
  })

  it('Editar reabre o modal preenchido e salva o novo nome', async () => {
    const { calls } = setupServer({
      cameras: [{ ...IP_CAM }],
      selectedCameras: [IP_CAM.id],
      ipCameras: [{ id: IP_CAM.id, name: 'Portão', url: IP_URL, transport: 'udp' }],
      monitors: []
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    await openCameraContextMenu('Portão')
    fireEvent.click(await openSubmenuItem('Câmera', 'Editar Câmera'))

    const nameInput = (await screen.findByPlaceholderText('Nome da câmera (ex.: Garagem, Entrada)')) as HTMLInputElement
    expect(nameInput.value).toBe('Portão')
    fireEvent.change(nameInput, { target: { value: 'Portão Novo' } })
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }))

    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.ipCameras !== undefined)
      expect(write).toBeTruthy()
      const list = write!.args.ipCameras as Array<{ name: string }>
      expect(list.some((c) => c.name === 'Portão Novo')).toBe(true)
    })
  })

  it('Copiar URL copia o endereço sem abrir o preview', async () => {
    setupServer({
      cameras: [{ ...IP_CAM }],
      selectedCameras: [IP_CAM.id],
      ipCameras: [{ id: IP_CAM.id, name: 'Portão', url: IP_URL, transport: 'udp' }],
      monitors: []
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    await openCameraContextMenu('Portão')
    fireEvent.click(await openSubmenuItem('Câmera', 'Copiar URL'))

    await waitFor(() => {
      expect(vi.mocked(window.navigator.clipboard.writeText)).toHaveBeenCalledWith(IP_URL)
    })
    expect(document.body.textContent).not.toContain('Dois cliques para fechar')
  })

  it('ampliada tem o toggle de reconhecimento sem fechar', async () => {
    const { calls } = setupServer({
      cameras: [{ ...IP_CAM }],
      selectedCameras: [IP_CAM.id],
      ipCameras: [{ id: IP_CAM.id, name: 'Portão', url: IP_URL, transport: 'udp' }],
      monitors: [{ id: 'mon-1', cameraId: IP_CAM.id, cameraName: 'Portão', triggers: [{ type: 'motion' }], paused: false }]
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    fireEvent.click(await screen.findByRole('button', { name: 'Ampliar imagem (tela cheia)' }))
    await screen.findByTitle('Dois cliques para fechar')

    const header = screen.getByTestId('expanded-header')
    fireEvent.click(within(header).getByRole('button', { name: 'Ver' }))
    fireEvent.click(within(header).getByRole('menuitem', { name: 'Desativar reconhecimento' }))
    await waitFor(() => {
      expect(calls.some((c) => c.toolName === 'pause_monitoring')).toBe(true)
    })
    expect(await screen.findByTitle('Dois cliques para fechar')).toBeTruthy()
  })

  it('ampliada abre o Editar e copia a URL sem fechar', async () => {
    setupServer({
      cameras: [{ ...IP_CAM }],
      selectedCameras: [IP_CAM.id],
      ipCameras: [{ id: IP_CAM.id, name: 'Portão', url: IP_URL, transport: 'udp' }],
      monitors: []
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    fireEvent.click(await screen.findByRole('button', { name: 'Ampliar imagem (tela cheia)' }))
    await screen.findByTitle('Dois cliques para fechar')

    const header = screen.getByTestId('expanded-header')
    fireEvent.click(within(header).getByRole('button', { name: 'Câmera' }))
    fireEvent.click(within(header).getByRole('menuitem', { name: 'Editar Câmera' }))
    const nameInput = (await screen.findByPlaceholderText('Nome da câmera (ex.: Garagem, Entrada)')) as HTMLInputElement
    expect(nameInput.value).toBe('Portão')
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))

    fireEvent.click(within(header).getByRole('button', { name: 'Câmera' }))
    fireEvent.click(within(header).getByRole('menuitem', { name: 'Copiar URL' }))
    await waitFor(() => {
      expect(vi.mocked(window.navigator.clipboard.writeText)).toHaveBeenCalledWith(IP_URL)
    })
    expect(await screen.findByTitle('Dois cliques para fechar')).toBeTruthy()
  })

  it('Ativar/Desativar reconhecimento pausa e retoma sem quebrar o preview', async () => {
    const { calls } = setupServer({
      cameras: [{ ...IP_CAM }],
      selectedCameras: [IP_CAM.id],
      ipCameras: [{ id: IP_CAM.id, name: 'Portão', url: IP_URL, transport: 'udp' }],
      monitors: [{ id: 'mon-1', cameraId: IP_CAM.id, cameraName: 'Portão', triggers: [{ type: 'motion' }], paused: false }]
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    await openCameraContextMenu('Portão')
    fireEvent.click(await openSubmenuItem('Ver', 'Desativar reconhecimento'))

    await waitFor(() => {
      expect(calls.some((c) => c.toolName === 'pause_monitoring')).toBe(true)
    })
    expect(document.body.textContent).not.toContain('Dois cliques para fechar')
  })
})

describe('VisionPage — Limpar Cache e Conexões volta para a grade', () => {
  it('fecha o Editar e sai da ampliada ao concluir a limpeza', async () => {
    const { calls } = setupServer({
      cameras: [{ ...IP_CAM }],
      selectedCameras: [IP_CAM.id],
      ipCameras: [{ id: IP_CAM.id, name: 'Portão', url: IP_URL, transport: 'udp' }],
      monitors: []
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    fireEvent.click(await screen.findByRole('button', { name: 'Ampliar imagem (tela cheia)' }))
    await screen.findByTitle('Dois cliques para fechar')
    const header = screen.getByTestId('expanded-header')
    fireEvent.click(within(header).getByRole('button', { name: 'Câmera' }))
    fireEvent.click(within(header).getByRole('menuitem', { name: 'Editar Câmera' }))

    fireEvent.click(await screen.findByRole('button', { name: /Limpar Cache e Conexões/i }))

    await waitFor(() => {
      expect(calls.some((c) => c.toolName === 'clear_camera_cache')).toBe(true)
    })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(screen.queryByTitle('Dois cliques para fechar')).toBeNull()
  })

  it('gira o ícone de recarregar até a câmera reconectar', async () => {
    const { state } = setupServer({
      cameras: [{ ...IP_CAM }],
      selectedCameras: [IP_CAM.id],
      ipCameras: [{ id: IP_CAM.id, name: 'Portão', url: IP_URL, transport: 'udp' }],
      monitors: []
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    await openCameraContextMenu('Portão')
    fireEvent.click(await openSubmenuItem('Câmera', 'Editar Câmera'))
    fireEvent.click(await screen.findByRole('button', { name: /Limpar Cache e Conexões/i }))

    const reloadBtn = await screen.findByRole('button', { name: 'Recarregar câmera' })
    await waitFor(() => {
      expect(reloadBtn.querySelector('svg')?.classList.contains('animate-spin')).toBe(true)
    })

    // The camera comes back online on the next poll: the spin stops by itself.
    state.cameras[0] = { ...state.cameras[0], online: true }
    await waitFor(
      () => {
        expect(reloadBtn.querySelector('svg')?.classList.contains('animate-spin')).toBe(false)
      },
      { timeout: 9000 }
    )
  }, 15000)
})
