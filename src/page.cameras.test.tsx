import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { getSDK } from 'momai:sdk'
import VisionPage from './page'

const WEB_A = { id: 'webcam:a', name: 'Webcam A', source: 'webcam', online: true, monitors: 0 } as const
const WEB_B = { id: 'webcam:b', name: 'Webcam B', source: 'webcam', online: false, monitors: 0 } as const

interface CameraInfo {
  id: string
  name: string
  source: 'webcam' | 'ip'
  online: boolean
  monitors: number
}

interface ServerState {
  cameras: CameraInfo[]
  selectedCameras: string[]
  ipCameras: Array<{ id: string; name: string; url: string }>
}

// In-memory fake of the extension backend: list_cameras/get_status configure
// keep one consistent state, and every configure call is recorded.
function setupServer(initial: Partial<ServerState> = {}) {
  const state: ServerState = {
    cameras: [],
    selectedCameras: [],
    ipCameras: [],
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
        return { ok: true, data: { monitors: [] } }
      case 'list_alerts':
        return { ok: true, data: { alerts: [] } }
      case 'list_snapshots':
        return { ok: true, data: { snapshots: [] } }
      case 'configure':
        if (args.selectedCameras !== undefined || args.ipCameras !== undefined) {
          if (args.selectedCameras !== undefined) state.selectedCameras = [...(args.selectedCameras as string[])]
          if (args.ipCameras !== undefined) state.ipCameras = [...(args.ipCameras as Array<{ id: string; name: string; url: string }>)]
          return { ok: true, data: { ok: true } }
        }
        return {
          ok: true,
          data: { ok: true, config: { ipCameras: [...state.ipCameras], selectedCameras: [...state.selectedCameras] } }
        }
      default:
        return { ok: true, data: {} }
    }
  })
  return { sdk, calls, state }
}

async function openCameraModal() {
  fireEvent.click(screen.getByText('Adicionar Câmera'))
  await screen.findByText('Adicionar Câmeras')
}

async function stageWebcam(name: string) {
  fireEvent.click(screen.getByText('Selecione uma webcam...'))
  fireEvent.click(await screen.findByText(name))
}

async function stageIp(name: string, url: string) {
  fireEvent.click(screen.getByRole('tab', { name: /Câmeras IP/ }))
  fireEvent.change(screen.getByPlaceholderText('Nome da câmera (ex.: Garagem, Entrada)'), { target: { value: name } })
  fireEvent.change(screen.getByPlaceholderText(/URL \(http/), { target: { value: url } })
  fireEvent.click(screen.getByText('Adicionar à seleção'))
}

// jest-dom is not installed in this repo; assert the DOM attribute directly.
function expectButtonDisabled(el: HTMLElement) {
  expect((el as HTMLButtonElement).disabled).toBe(true)
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  const sdk = getSDK()
  vi.mocked(sdk.api.post).mockReset()
  vi.mocked(sdk.api.post).mockResolvedValue({ ok: true, data: {} })
})

describe('VisionPage — Adicionar Câmeras (seleção + confirmação)', () => {
  it('bloqueia confirmar sem seleção e cancelar/fechar não adiciona nada', async () => {
    const { calls } = setupServer({ cameras: [WEB_A, WEB_B] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    await screen.findByText('Selecione uma webcam...')

    // Nothing selected -> confirm disabled
    const confirmBtn = screen.getByRole('button', { name: 'Nenhuma câmera selecionada' })
    expectButtonDisabled(confirmBtn)

    // Stage then cancel: nothing persists
    await stageWebcam('Webcam A')
    expect(screen.getByRole('button', { name: 'Adicionar 1 câmera' })).toBeTruthy()
    fireEvent.click(screen.getByText('Cancelar'))
    await waitFor(() => expect(screen.queryByText('Adicionar Câmeras')).toBeNull())
    expect(calls.filter((c) => c.toolName === 'configure' && c.args.selectedCameras !== undefined)).toHaveLength(0)

    // Reopening resets the pending selection
    await openCameraModal()
    await screen.findByText('Selecione uma webcam...')
    expectButtonDisabled(screen.getByRole('button', { name: 'Nenhuma câmera selecionada' }))
  })

  it('seleciona várias webcams sem adicionar e confirma todas de uma vez', async () => {
    const { calls } = setupServer({ cameras: [WEB_A, WEB_B] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    await screen.findByText('Selecione uma webcam...')

    await stageWebcam('Webcam A')
    await stageWebcam('Webcam B')
    expect(screen.getByText('Revisão')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Adicionar 2 câmeras' })).toBeTruthy()

    // Staging alone must not write anything — only confirm does
    expect(calls.filter((c) => c.toolName === 'configure')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar 2 câmeras' }))

    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.selectedCameras !== undefined)
      expect(write).toBeTruthy()
      expect(write!.args.selectedCameras).toEqual(['webcam:a', 'webcam:b'])
    })
    // Modal closes after a successful confirm
    await waitFor(() => expect(screen.queryByText('Adicionar Câmeras')).toBeNull())
  })

  it('confirma webcam + câmera IP em uma única operação', async () => {
    const { calls } = setupServer({ cameras: [WEB_A] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    await screen.findByText('Selecione uma webcam...')

    await stageWebcam('Webcam A')
    await stageIp('Garagem', 'http://192.168.0.5:8080/video')
    expect(screen.getByRole('button', { name: 'Adicionar 2 câmeras' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar 2 câmeras' }))

    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.selectedCameras !== undefined)
      expect(write).toBeTruthy()
      expect(write!.args.selectedCameras).toEqual(['webcam:a', 'ip:http://192.168.0.5:8080/video'])
      expect(write!.args.ipCameras).toEqual([
        { id: 'ip:http://192.168.0.5:8080/video', name: 'Garagem', url: 'http://192.168.0.5:8080/video' }
      ])
    })
  })

  it('seleciona várias câmeras IP e confirma todas de uma vez', async () => {
    const { calls } = setupServer({ cameras: [] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()

    await stageIp('Garagem', 'http://10.0.0.5:8080/video')
    await stageIp('Entrada', 'http://10.0.0.6:8080/video')
    expect(screen.getByText('Revisão')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Adicionar 2 câmeras' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar 2 câmeras' }))

    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.selectedCameras !== undefined)
      expect(write).toBeTruthy()
      expect(write!.args.selectedCameras).toEqual([
        'ip:http://10.0.0.5:8080/video',
        'ip:http://10.0.0.6:8080/video'
      ])
      expect(write!.args.ipCameras).toHaveLength(2)
    })
  })

  it('atualiza a contagem ao alterar a seleção antes de confirmar', async () => {
    setupServer({ cameras: [WEB_A, WEB_B] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    await screen.findByText('Selecione uma webcam...')

    await stageWebcam('Webcam A')
    await stageWebcam('Webcam B')
    expect(screen.getByRole('button', { name: 'Adicionar 2 câmeras' })).toBeTruthy()

    // Remove Webcam A from the pending list
    fireEvent.click(screen.getByLabelText('Remover Webcam A da seleção'))
    expect(screen.getByRole('button', { name: 'Adicionar 1 câmera' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Adicionar 2 câmeras' })).toBeNull()

    // Removing the last one leaves the modal in the empty state
    fireEvent.click(screen.getByLabelText('Remover Webcam B da seleção'))
    expectButtonDisabled(screen.getByRole('button', { name: 'Nenhuma câmera selecionada' }))
  })

  it('não permite duplicidades (webcam já adicionada fora do dropdown, IP duplicado bloqueado)', async () => {
    const registeredIp = { id: 'ip:http://10.0.0.1:8080/video', name: 'Portão', url: 'http://10.0.0.1:8080/video' }
    setupServer({
      cameras: [WEB_A, WEB_B, { id: registeredIp.id, name: 'Portão', source: 'ip', online: true, monitors: 0 }],
      selectedCameras: ['webcam:a'],
      ipCameras: [registeredIp]
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()

    // Webcam A is already selected -> only Webcam B remains available. The
    // grid card also renders "Webcam A", so expect exactly one occurrence (the
    // card) — a dropdown option would add a second one.
    await screen.findByText('Selecione uma webcam...')
    fireEvent.click(screen.getByText('Selecione uma webcam...'))
    expect(screen.getAllByText('Webcam A')).toHaveLength(1)
    fireEvent.click(screen.getByText('Webcam B'))

    // Duplicate IP against a registered camera is rejected
    await stageIp('Portão', 'http://10.0.0.1:8080/video')
    expect(screen.getByText('Esta câmera IP já está cadastrada.')).toBeTruthy()

    // Same URL staged twice is also rejected
    fireEvent.change(screen.getByPlaceholderText(/URL \(http/), { target: { value: 'http://10.0.0.2:8080/video' } })
    fireEvent.click(screen.getByText('Adicionar à seleção'))
    fireEvent.change(screen.getByPlaceholderText(/URL \(http/), { target: { value: 'http://10.0.0.2:8080/video' } })
    fireEvent.click(screen.getByText('Adicionar à seleção'))
    expect(screen.getByText('Esta câmera IP já está na lista de seleção.')).toBeTruthy()
  })

  it('preserva câmeras IP já cadastradas ao confirmar novas seleções', async () => {
    const registeredIp = { id: 'ip:http://10.0.0.1:8080/video', name: 'Portão', url: 'http://10.0.0.1:8080/video' }
    const { calls } = setupServer({
      cameras: [WEB_A, { id: registeredIp.id, name: 'Portão', source: 'ip', online: true, monitors: 0 }],
      selectedCameras: [registeredIp.id],
      ipCameras: [registeredIp]
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    await screen.findByText('Selecione uma webcam...')

    await stageWebcam('Webcam A')
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar 1 câmera' }))

    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.selectedCameras !== undefined)
      expect(write).toBeTruthy()
      // Existing IP stays selected and registered; only the webcam is appended
      expect(write!.args.selectedCameras).toEqual([registeredIp.id, 'webcam:a'])
      expect(write!.args.ipCameras).toEqual([registeredIp])
    })
  })

  it('mantém o modal aberto e mostra erro se a confirmação falhar', async () => {
    const { sdk } = setupServer({ cameras: [WEB_A] })
    // Make every configure write fail (reads keep working via the base impl)
    const original = vi.mocked(sdk.api.post).getMockImplementation()!
    vi.mocked(sdk.api.post).mockImplementation(async (path, body) => {
      if (path === '/extensions/momai-vision/command' && body?.toolName === 'configure' && body?.args?.selectedCameras !== undefined) {
        return { ok: false, data: { ok: false }, error: 'falha simulada' }
      }
      return original(path, body)
    })

    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    await screen.findByText('Selecione uma webcam...')

    await stageWebcam('Webcam A')
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar 1 câmera' }))

    // Modal stays open with the error, nothing was persisted
    await screen.findByText('falha simulada')
    expect(screen.getByText('Adicionar Câmeras')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Adicionar 1 câmera' })).toBeTruthy()
  })

  it('alerta quando há campos IP preenchidos sem adicionar à seleção', async () => {
    const { calls } = setupServer({ cameras: [WEB_A] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    await screen.findByText('Selecione uma webcam...')

    await stageWebcam('Webcam A')
    // Fill the IP fields but do NOT stage the camera
    fireEvent.click(screen.getByRole('tab', { name: /Câmeras IP/ }))
    fireEvent.change(screen.getByPlaceholderText(/URL \(http/), { target: { value: 'http://10.0.0.9:8080/video' } })

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar 1 câmera' }))

    // Prompt appears and nothing was written yet
    expect(screen.getByText(/Confirmar mesmo assim/)).toBeTruthy()
    expect(calls.filter((c) => c.toolName === 'configure')).toHaveLength(0)

    // Cancelar dismisses the prompt and keeps editing (fields stay filled)
    fireEvent.click(screen.getByText('Cancelar'))
    expect(screen.queryByText(/Confirmar mesmo assim/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Adicionar 1 câmera' })).toBeTruthy()

    // Confirm again, then accept: only the staged webcam is added
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar 1 câmera' }))
    fireEvent.click(screen.getByText('Sim, adicionar mesmo assim'))
    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.selectedCameras !== undefined)
      expect(write).toBeTruthy()
      expect(write!.args.selectedCameras).toEqual(['webcam:a'])
      expect(write!.args.ipCameras).toEqual([])
    })
  })
})

describe('VisionPage — X no card remove câmera IP do cadastro (webcam só da exibição)', () => {
  it('remover câmera IP pelo X apaga do cadastro (ipCameras) e da seleção', async () => {
    const registeredIp = { id: 'ip:http://10.0.0.1:8080/video', name: 'Portão', url: 'http://10.0.0.1:8080/video' }
    const { calls } = setupServer({
      cameras: [{ id: registeredIp.id, name: 'Portão', source: 'ip', online: true, monitors: 0 }],
      selectedCameras: [registeredIp.id],
      ipCameras: [registeredIp]
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    fireEvent.click(await screen.findByTitle('Remover câmera IP (cadastro e exibição)'))

    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.ipCameras !== undefined)
      expect(write).toBeTruthy()
      expect(write!.args.ipCameras).toEqual([])
      expect(write!.args.selectedCameras).toEqual([])
    })
  })

  it('remover webcam pelo X mantém o cadastro das câmeras IP intacto', async () => {
    const registeredIp = { id: 'ip:http://10.0.0.1:8080/video', name: 'Portão', url: 'http://10.0.0.1:8080/video' }
    const { calls } = setupServer({
      cameras: [WEB_A, { id: registeredIp.id, name: 'Portão', source: 'ip', online: true, monitors: 0 }],
      selectedCameras: ['webcam:a', registeredIp.id],
      ipCameras: [registeredIp]
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    fireEvent.click(await screen.findByTitle('Fechar / Remover câmera da exibição'))

    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.selectedCameras !== undefined)
      expect(write).toBeTruthy()
      expect(write!.args.selectedCameras).toEqual([registeredIp.id])
      // Webcam removal never touches the IP registry
      expect(write!.args.ipCameras).toBeUndefined()
    })
  })
})

describe('VisionPage — botão recarregar câmera', () => {
  it('dispara reload_camera para a câmera do card ao clicar no ícone', async () => {
    const { calls } = setupServer({ cameras: [WEB_A], selectedCameras: ['webcam:a'] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    const reloadBtn = await screen.findByRole('button', { name: 'Recarregar câmera' })
    fireEvent.click(reloadBtn)

    await waitFor(() => {
      expect(calls.find((c) => c.toolName === 'reload_camera')).toBeTruthy()
    })
    expect(calls.find((c) => c.toolName === 'reload_camera')!.args).toEqual({
      cameraId: 'webcam:a',
      cameraName: 'Webcam A'
    })
  })
})

describe('VisionPage — atualização imediata de monitoramentos (vision_status)', () => {
  it('faz poll imediato ao receber o evento vision_status', async () => {
    const { calls } = setupServer({ cameras: [WEB_A] })
    const sdk = getSDK()
    const subscribed: Array<{ type: string; handler: (data: unknown) => void }> = []
    vi.mocked(sdk.events.subscribe).mockImplementation(
      ((type: string, handler: (data: unknown) => void) => {
        subscribed.push({ type, handler })
        return () => {}
      }) as never
    )

    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    const statusHandler = subscribed.find((s) => s.type === 'vision_status')?.handler
    expect(statusHandler).toBeTruthy()

    const pollsBefore = calls.filter((c) => c.toolName === 'get_status').length
    statusHandler!({ changedAt: Date.now() })
    await waitFor(() => {
      expect(calls.filter((c) => c.toolName === 'get_status').length).toBeGreaterThan(pollsBefore)
    })
  })
})

describe('VisionPage — cache de monitoramentos', () => {
  it('mostra os monitoramentos do cache imediatamente ao abrir', async () => {
    const cachedMonitors = [
      {
        id: 'mon-1',
        cameraId: 'webcam:a',
        cameraName: 'Webcam A',
        triggers: [{ type: 'motion' }],
        paused: false
      }
    ]
    // Same snapshot the poll saves: cameras + monitors together.
    localStorage.setItem('momai-vision:cameras', JSON.stringify([WEB_A]))
    localStorage.setItem('momai-vision:monitors', JSON.stringify(cachedMonitors))
    const { calls } = setupServer({ cameras: [WEB_A] })

    render(<VisionPage />)

    // Rendered from the cache without waiting for the poll to finish.
    expect(screen.getByText('Pausar')).toBeTruthy()

    // The poll still refreshes the list in the background.
    await waitFor(() => {
      expect(calls.some((c) => c.toolName === 'get_status')).toBe(true)
    })
  })

  it('salva os monitoramentos do poll no cache', async () => {
    const { sdk } = setupServer({ cameras: [WEB_A] })
    const original = vi.mocked(sdk.api.post).getMockImplementation()!
    vi.mocked(sdk.api.post).mockImplementation(async (path, body) => {
      if (path === '/extensions/momai-vision/command' && body?.toolName === 'get_status') {
        return {
          ok: true,
          data: { monitors: [{ id: 'mon-9', cameraId: 'webcam:a', triggers: [{ type: 'motion' }] }] }
        }
      }
      return original(path, body)
    })

    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    await waitFor(() => {
      const saved = localStorage.getItem('momai-vision:monitors')
      expect(saved).toContain('mon-9')
    })
  })
})
