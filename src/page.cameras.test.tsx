import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { getSDK } from 'momai:sdk'
import VisionPage from './page'
import { frameCacheKey } from './vision/frame-cache'

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
  pausedCameras?: string[]
  discoveredCameras?: any[]
}

// In-memory fake of the extension backend: list_cameras/get_status configure
// keep one consistent state, and every configure call is recorded.
function setupServer(
  initial: Partial<ServerState> = {},
  credentials: Record<string, { username: string; password: string }> = {}
) {
  const state: ServerState = {
    cameras: [],
    selectedCameras: [],
    ipCameras: [],
    ...initial
  }
  const credentialStore = new Map(Object.entries(credentials))
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = []
  const sdk = getSDK()
  vi.mocked(sdk.api.post).mockImplementation(async (path: string, body?: { toolName: string; args: Record<string, unknown> }) => {
    if (path !== '/extensions/momai-vision/command') {
      return { ok: true, data: {} }
    }
    const { toolName, args } = body || { toolName: '', args: {} }
    calls.push({ toolName, args })
    switch (toolName) {
      case 'get_camera_credentials': {
        const url = String(args.url || '')
        const credential = credentialStore.get(url)
        return {
          ok: true,
          data: credential ? { ok: true, url, ...credential } : { ok: false }
        }
      }
      case 'list_cameras':
        return {
          ok: true,
          data: {
            cameras: state.cameras.map((c) => ({ ...c, selected: state.selectedCameras.includes(c.id) })),
            availableWebcams: state.cameras.filter((c) => c.source === 'webcam'),
            selectedCameras: [...state.selectedCameras]
          }
        }
      case 'get_status':
        // Contrato real do runtime: cameras é um mapa id -> { online, monitors }.
        return {
          ok: true,
          data: {
            monitors: [],
            cameras: Object.fromEntries(
              state.cameras.map((c) => [c.id, { online: c.online, monitors: c.monitors }])
            )
          }
        }
      case 'discover_cameras':
        return { ok: true, data: { ok: true, cameras: state.discoveredCameras || [] } }
      case 'list_alerts':
        return { ok: true, data: { alerts: [] } }
      case 'list_snapshots':
        return { ok: true, data: { snapshots: [] } }
      case 'configure':
        if (args.selectedCameras !== undefined || args.ipCameras !== undefined) {
          if (args.selectedCameras !== undefined) state.selectedCameras = [...(args.selectedCameras as string[])]
          if (args.ipCameras !== undefined) {
            state.ipCameras = [...(args.ipCameras as Array<{ id: string; name: string; url: string }>)]
            state.cameras = [
              ...state.cameras.filter((c) => c.source !== 'ip'),
              ...state.ipCameras.map((ip) => ({ id: ip.id, name: ip.name, source: 'ip' as const, online: true, monitors: 0 }))
            ]
          }
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
  it('renderiza o dropdown de webcams via portal no body (não é cortado pelo card do modal)', async () => {
    setupServer({ cameras: [WEB_A, WEB_B] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    await screen.findByText('Selecione uma webcam...')

    fireEvent.click(screen.getByText('Selecione uma webcam...'))

    // O popover (lista de opções) deve viver direto no document.body — fora do
    // modal com overflow-y-auto — para nunca ser limitado/cortado pelo card.
    // ("Webcam A" também existe no card do grid, então filtramos pelo role).
    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(2)
    const optionWebcamB = options.find((o) => o.textContent?.includes('Webcam B'))!
    const optionWebcamA = options.find((o) => o.textContent?.includes('Webcam A'))!

    expect(document.body.contains(optionWebcamB)).toBe(true)
    // O pai imediato do botão de opção é o popover, que é filho direto do body.
    const popover = optionWebcamB.parentElement
    expect(popover).toBeTruthy()
    expect(popover!.parentElement).toBe(document.body)
    expect(optionWebcamA.parentElement).toBe(popover)
  })

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
    // Modal closes after a successful confirm. A câmera B é offline no mock, então
    // a espera limitada pelo status (≤2.5s) roda até o teto antes de fechar.
    await waitFor(() => expect(screen.queryByText('Adicionar Câmeras')).toBeNull(), { timeout: 8000 })
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
        {
          id: 'ip:http://192.168.0.5:8080/video',
          name: 'Garagem',
          url: 'http://192.168.0.5:8080/video',
          transport: 'udp',
          previewWidth: 640
        }
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
      selectedCameras: ['webcam:a', registeredIp.id],
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

  it('permite recadastrar uma câmera IP após a sua remoção', async () => {
    const registeredIp = { id: 'ip:http://10.0.0.1:8080/video', name: 'Portão', url: 'http://10.0.0.1:8080/video' }
    const { state } = setupServer({
      cameras: [{ id: registeredIp.id, name: 'Portão', source: 'ip', online: true, monitors: 0 }],
      selectedCameras: [registeredIp.id],
      ipCameras: [registeredIp]
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await screen.findByText('Portão')

    // Remover a câmera IP existente através do botão de remoção no card
    fireEvent.click(await screen.findByTitle('Remover câmera IP (cadastro e exibição)'))
    await screen.findByText('Fechar câmera?')
    fireEvent.click(screen.getByRole('button', { name: 'Sim' }))

    // Aguardar atualização do estado (removida do ipCameras)
    await waitFor(() => {
      expect(state.ipCameras).toHaveLength(0)
    })

    // Abrir modal e tentar recadastrar a mesma URL
    await openCameraModal()
    await stageIp('Portão Novo', 'http://10.0.0.1:8080/video')

    expect(screen.queryByText('Esta câmera IP já está cadastrada.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Adicionar 1 câmera' })).toBeTruthy()
  })

  it('câmera descoberta na rede não continua como ativa após remoção e pode ser readicionada', async () => {
    const registeredIp = { id: 'ip:http://10.0.0.1:8080/video', name: 'Portão', url: 'http://10.0.0.1:8080/video' }
    const discovered = [{ id: 'disc-1', name: 'Portão', ip: '10.0.0.1', suggestedUrl: 'http://10.0.0.1:8080/video' }]
    const { state } = setupServer({
      cameras: [{ id: registeredIp.id, name: 'Portão', source: 'ip', online: true, monitors: 0 }],
      selectedCameras: [registeredIp.id],
      ipCameras: [registeredIp],
      discoveredCameras: discovered
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await screen.findByText('Portão')

    // Remover a câmera IP existente através do botão de remoção no card
    fireEvent.click(await screen.findByTitle('Remover câmera IP (cadastro e exibição)'))
    await screen.findByText('Fechar câmera?')
    fireEvent.click(screen.getByRole('button', { name: 'Sim' }))

    // Aguardar atualização do estado (removida do ipCameras)
    await waitFor(() => {
      expect(state.ipCameras).toHaveLength(0)
    })

    // Abrir modal de adicionar câmera e mudar para a aba Câmeras IP
    await openCameraModal()
    fireEvent.click(screen.getByRole('tab', { name: /Câmeras IP/i }))

    // Abrir o dropdown de câmeras detectadas
    await screen.findByText('Selecione uma câmera detectada...')
    fireEvent.click(screen.getByText('Selecione uma câmera detectada...'))

    // A opção deve ser exibida com a badge ONVIF (e NÃO "Ativa")
    await screen.findByText(/Portão \(10\.0\.0\.1\)/)
    expect(screen.queryByText('Ativa')).toBeNull()

    // Clicar na câmera detectada
    fireEvent.click(screen.getByText(/Portão \(10\.0\.0\.1\)/))

    // Não deve acusar erro de já cadastrada
    expect(screen.queryByText('Esta câmera IP já está cadastrada.')).toBeNull()

    // Clicar em Adicionar à seleção
    fireEvent.click(screen.getByText('Adicionar à seleção'))
    expect(screen.queryByText('Esta câmera IP já está cadastrada.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Adicionar 1 câmera' })).toBeTruthy()
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

  it('fecha o modal na confirmação (otimista) e mostra erro no banner se a persistência falhar', async () => {
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

    // Optimistic close: the modal closes right away even if persistence fails.
    await waitFor(() => expect(screen.queryByText('Adicionar Câmeras')).toBeNull())
    // The failure is logged to dev console without cluttering the UI banner.
    await waitFor(() => expect(screen.queryByText('falha simulada')).toBeNull())
  })

  it('inclui automaticamente IP válido digitado sem precisar clicar em Adicionar à seleção', async () => {
    const { calls } = setupServer({ cameras: [WEB_A] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    await screen.findByText('Selecione uma webcam...')

    await stageWebcam('Webcam A')
    // Fill the IP fields but do NOT click "Adicionar à seleção" — o rodapé deve
    // contar o draft válido (+1) e incluir ao confirmar em 1 clique.
    fireEvent.click(screen.getByRole('tab', { name: /Câmeras IP/ }))
    fireEvent.change(screen.getByPlaceholderText(/URL \(http/), { target: { value: 'http://10.0.0.9:8080/video' } })

    // O botão agora mostra 2 (webcam + IP não-staged mas válido)
    expect(screen.getByRole('button', { name: 'Adicionar 2 câmeras' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar 2 câmeras' }))

    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.selectedCameras !== undefined)
      expect(write).toBeTruthy()
      expect(write!.args.selectedCameras).toEqual(['webcam:a', 'ip:http://10.0.0.9:8080/video'])
      expect(write!.args.ipCameras).toEqual([
        {
          id: 'ip:http://10.0.0.9:8080/video',
          name: 'Câmera IP',
          url: 'http://10.0.0.9:8080/video',
          transport: 'udp',
          previewWidth: 640
        }
      ])
    })
  })
})

describe('VisionPage — modal Adicionar Câmeras respeita o container de overlay do host', () => {
  const OVERLAY_ROOT_ID = 'momai-extension-overlay-root'

  function mountOverlayRoot() {
    document.getElementById(OVERLAY_ROOT_ID)?.remove()
    const root = document.createElement('div')
    root.id = OVERLAY_ROOT_ID
    document.body.appendChild(root)
    return root
  }

  afterEach(() => {
    document.getElementById(OVERLAY_ROOT_ID)?.remove()
  })

  it('monta o sheet dentro do container oficial com posicionamento absolute', async () => {
    const root = mountOverlayRoot()
    setupServer({ cameras: [WEB_A] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    const heading = await screen.findByText('Adicionar Câmeras')

    // O portal deve mirar o container do host — nunca o body direto — para
    // o sheet preencher só a área de conteúdo sem cobrir o sidebar nativo.
    expect(root.contains(heading)).toBe(true)
    const sheet = root.firstElementChild as HTMLElement | null
    expect(sheet).toBeTruthy()
    expect(sheet!.parentElement).toBe(root)
    expect(sheet!.className).toMatch(/(^|\s)absolute(\s|$)/)
    expect(sheet!.className).not.toMatch(/(^|\s)fixed(\s|$)/)
  })

  it('recorre ao body quando o host não oferece o container (hosts antigos)', async () => {
    document.getElementById(OVERLAY_ROOT_ID)?.remove()
    setupServer({ cameras: [WEB_A] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    const heading = await screen.findByText('Adicionar Câmeras')

    const sheet = [...document.body.children].find((el) =>
      el.textContent?.includes('Adicionar Câmeras')
    )
    expect(sheet).toBeTruthy()
    expect(sheet!.contains(heading)).toBe(true)
  })
})

describe('VisionPage — modo de conexão da câmera IP (TCP/UDP)', () => {
  it('usa UDP como padrão ao adicionar câmera RTSP, à esquerda de TCP', async () => {
    const { calls } = setupServer({ cameras: [] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    fireEvent.click(screen.getByRole('tab', { name: /Câmeras IP/ }))

    const group = screen.getByRole('radiogroup', { name: /Modo de conexão/i })
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[]
    expect(radios[0].value).toBe('udp')
    expect(radios[0].checked).toBe(true)
    expect(radios[1].value).toBe('tcp')

    await stageIp('Quintal', 'rtsp://admin:pass@192.168.0.4:554/onvif2')
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar 1 câmera' }))

    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.selectedCameras !== undefined)
      expect(write).toBeTruthy()
      expect(write!.args.ipCameras).toEqual([
        {
          id: 'ip:rtsp://192.168.0.4:554/onvif2',
          name: 'Quintal',
          url: 'rtsp://192.168.0.4:554/onvif2',
          username: 'admin',
          password: 'pass',
          transport: 'udp',
          previewWidth: 640
        }
      ])
    })
  })

  it('envia UDP quando o usuário seleciona UDP antes de adicionar', async () => {
    const { calls } = setupServer({ cameras: [] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    fireEvent.click(screen.getByRole('tab', { name: /Câmeras IP/ }))

    fireEvent.click(screen.getByRole('radio', { name: 'UDP' }))
    fireEvent.change(screen.getByPlaceholderText('Nome da câmera (ex.: Garagem, Entrada)'), { target: { value: 'Quintal' } })
    fireEvent.change(screen.getByPlaceholderText(/URL \(http/), { target: { value: 'rtsp://admin:pass@192.168.0.4:554/onvif2' } })
    fireEvent.click(screen.getByText('Adicionar à seleção'))

    // The staged draft shows the chosen mode.
    expect(screen.getAllByText('UDP').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Adicionar 1 câmera' }))

    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.selectedCameras !== undefined)
      expect(write).toBeTruthy()
      expect(write!.args.ipCameras).toEqual([
        {
          id: 'ip:rtsp://192.168.0.4:554/onvif2',
          name: 'Quintal',
          url: 'rtsp://192.168.0.4:554/onvif2',
          username: 'admin',
          password: 'pass',
          transport: 'udp',
          previewWidth: 640
        }
      ])
    })
  })

  it('o ponto de interrogação abre o card explicativo de cada modo', async () => {
    setupServer({ cameras: [] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    fireEvent.click(screen.getByRole('tab', { name: /Câmeras IP/ }))

    expect(screen.queryByText(/Alternativa sem controle/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sobre o modo UDP' }))
    await screen.findByText(/Alternativa sem controle/)

    // Clicking again closes the card.
    fireEvent.click(screen.getByRole('button', { name: 'Sobre o modo UDP' }))
    await waitFor(() => expect(screen.queryByText(/Alternativa sem controle/)).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Sobre o modo TCP' }))
    await screen.findByText(/Recomendado para a maioria/)
  })
})

describe('VisionPage — lembrar credenciais e preferências da câmera IP', () => {
  it('caixinha Lembrar salva e preenche credenciais ao reabrir mantendo URL e nome limpos', async () => {
    setupServer({ cameras: [] }, { 'rtsp://192.168.0.4:554/onvif2': { username: 'admin', password: 'pass123' } })
    const first = render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    fireEvent.click(screen.getByRole('tab', { name: /Câmeras IP/ }))

    fireEvent.change(screen.getByPlaceholderText('Nome da câmera (ex.: Garagem, Entrada)'), { target: { value: 'Quintal' } })
    fireEvent.change(screen.getByPlaceholderText(/URL \(http/), { target: { value: 'rtsp://192.168.0.4:554/onvif2' } })
    fireEvent.change(screen.getByPlaceholderText('Senha da câmera (se houver)'), { target: { value: 'pass123' } })
    fireEvent.click(screen.getByRole('radio', { name: 'TCP' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lembrar credenciais e preferências' }))
    fireEvent.click(screen.getByText('Adicionar à seleção'))

    // The password and clean URL are stored in camera-defaults
    expect(JSON.parse(localStorage.getItem('momai-vision:camera-defaults') || '{}')).toEqual({
      username: 'admin',
      password: 'pass123',
      url: 'rtsp://192.168.0.4:554/onvif2',
      transport: 'tcp',
      previewWidth: 640,
      codec: 'h264',
      remember: true
    })
    expect(localStorage.getItem('momai-vision:camera-defaults')).toContain('pass123')

    first.unmount()
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    fireEvent.click(screen.getByRole('tab', { name: /Câmeras IP/ }))

    // Nome e URL iniciam limpos para adicionar uma nova câmera sem atrito
    expect((screen.getByPlaceholderText('Nome da câmera (ex.: Garagem, Entrada)') as HTMLInputElement).value).toBe('')
    expect((screen.getByPlaceholderText(/URL \(http/) as HTMLInputElement).value).toBe('')
    // Mas credenciais e preferências foram restauradas (senha vem do cofre)
    await waitFor(() => {
      expect((screen.getByPlaceholderText('admin (opcional)') as HTMLInputElement).value).toBe('admin')
      expect((screen.getByPlaceholderText('Senha da câmera (se houver)') as HTMLInputElement).value).toBe('pass123')
    })
    expect((screen.getByRole('radio', { name: 'TCP' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Lembrar credenciais e preferências' }) as HTMLInputElement).checked).toBe(true)
  })

  it('desmarcar a caixinha apaga as preferências salvas', async () => {
    localStorage.setItem('momai-vision:camera-defaults', JSON.stringify({ username: 'admin', password: 'secret', transport: 'tcp', remember: true }))
    setupServer({ cameras: [] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    fireEvent.click(screen.getByRole('tab', { name: /Câmeras IP/ }))

    expect((screen.getByRole('checkbox', { name: 'Lembrar credenciais e preferências' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lembrar credenciais e preferências' }))
    expect(localStorage.getItem('momai-vision:camera-defaults')).toBeNull()
  })

  it('adiciona câmera com 1 clique usando credenciais restauradas ao preencher apenas a URL', async () => {
    localStorage.setItem('momai-vision:camera-defaults', JSON.stringify({
      username: 'admin',
      url: 'rtsp://192.168.0.10:554/live',
      transport: 'tcp',
      previewWidth: 640,
      remember: true
    }))
    const { calls } = setupServer(
      { cameras: [] },
      { 'rtsp://192.168.0.10:554/live': { username: 'admin', password: 'mypassword' } }
    )
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    fireEvent.click(screen.getByRole('tab', { name: /Câmeras IP/ }))

    // Credenciais vindas do cofre (não ficam no localStorage)
    await waitFor(() => {
      expect((screen.getByPlaceholderText('Senha da câmera (se houver)') as HTMLInputElement).value).toBe('mypassword')
    })

    // Preenche apenas a URL da nova câmera
    fireEvent.change(screen.getByPlaceholderText(/URL \(http/), { target: { value: 'rtsp://192.168.0.10:554/live' } })
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar 1 câmera' }))

    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.selectedCameras !== undefined)
      expect(write).toBeTruthy()
      expect(write!.args.ipCameras).toEqual([
        {
          id: 'ip:rtsp://192.168.0.10:554/live',
          name: 'Câmera IP',
          url: 'rtsp://192.168.0.10:554/live',
          username: 'admin',
          password: 'mypassword',
          transport: 'tcp',
          previewWidth: 640
        }
      ])
    })
  })

  it('cada vez que seleciona uma câmera IP exibe a senha correspondente sem vazar para a outra', async () => {
    setupServer({
      cameras: [],
      discoveredCameras: [
        { id: 'cam-a', name: 'Câmera A', ip: '192.168.0.10', suggestedUrl: 'rtsp://192.168.0.10:554/onvif1' },
        { id: 'cam-b', name: 'Câmera B', ip: '192.168.0.20', suggestedUrl: 'rtsp://192.168.0.20:554/onvif1' }
      ]
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    fireEvent.click(screen.getByRole('tab', { name: /Câmeras IP/ }))

    // Seleciona Câmera A
    fireEvent.click(await screen.findByText('Selecione uma câmera detectada...'))
    fireEvent.click(await screen.findByText('Câmera A (192.168.0.10)'))

    // Digita senha da Câmera A e marca lembrar
    fireEvent.change(screen.getByPlaceholderText('Senha da câmera (se houver)'), { target: { value: 'senhaA' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Lembrar credenciais e preferências' }))
    fireEvent.click(screen.getByText('Adicionar à seleção'))

    // Após adicionar Câmera A, o campo de senha fica limpo
    expect((screen.getByPlaceholderText('Senha da câmera (se houver)') as HTMLInputElement).value).toBe('')

    // Agora seleciona Câmera B (que ainda não tem senha memorizada)
    fireEvent.click(await screen.findByText('Selecione uma câmera detectada...'))
    fireEvent.click(await screen.findByText('Câmera B (192.168.0.20)'))

    // Câmera B NÃO deve herdar a senha da Câmera A
    expect((screen.getByPlaceholderText('Senha da câmera (se houver)') as HTMLInputElement).value).toBe('')

    // Digita senha da Câmera B e adiciona
    fireEvent.change(screen.getByPlaceholderText('Senha da câmera (se houver)'), { target: { value: 'senhaB' } })
    fireEvent.click(screen.getByText('Adicionar à seleção'))

    // Seleciona Câmera A novamente — deve carregar senhaA correspondente a ela
    fireEvent.click(await screen.findByText('Selecione uma câmera detectada...'))
    fireEvent.click(await screen.findByText('Câmera A (192.168.0.10)'))
    await waitFor(() => {
      expect((screen.getByPlaceholderText('Senha da câmera (se houver)') as HTMLInputElement).value).toBe('senhaA')
    })

    // Seleciona Câmera B novamente — deve carregar senhaB correspondente a ela
    fireEvent.click(screen.getByText('Câmera A (192.168.0.10)'))
    fireEvent.click(await screen.findByText('Câmera B (192.168.0.20)'))
    await waitFor(() => {
      expect((screen.getByPlaceholderText('Senha da câmera (se houver)') as HTMLInputElement).value).toBe('senhaB')
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

    // Confirmation card appears before anything is removed.
    await screen.findByText('Fechar câmera?')
    expect(calls.filter((c) => c.toolName === 'configure' && c.args.ipCameras !== undefined)).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Sim' }))

    await waitFor(() => {
      const write = calls.find((c) => c.toolName === 'configure' && c.args.ipCameras !== undefined)
      expect(write).toBeTruthy()
      expect(write!.args.ipCameras).toEqual([])
      expect(write!.args.selectedCameras).toEqual([])
    })
  })

  it('cancelar a confirmação mantém a câmera na exibição', async () => {
    const registeredIp = { id: 'ip:http://10.0.0.1:8080/video', name: 'Portão', url: 'http://10.0.0.1:8080/video' }
    const { calls } = setupServer({
      cameras: [{ id: registeredIp.id, name: 'Portão', source: 'ip', online: true, monitors: 0 }],
      selectedCameras: [registeredIp.id],
      ipCameras: [registeredIp]
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    fireEvent.click(await screen.findByTitle('Remover câmera IP (cadastro e exibição)'))
    await screen.findByText('Fechar câmera?')

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))

    await waitFor(() => expect(screen.queryByText('Fechar câmera?')).toBeNull())
    expect(calls.filter((c) => c.toolName === 'configure' && c.args.selectedCameras !== undefined)).toHaveLength(0)
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

    // Confirmation card appears before anything is removed.
    await screen.findByText('Fechar câmera?')
    fireEvent.click(screen.getByRole('button', { name: 'Sim' }))

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

describe('VisionPage — pump do card continua vivo após falha/timeout do frame_pump', () => {
  it('mantém o loop agendando novos ciclos mesmo quando frame_pump falha', async () => {
    const sdk = getSDK()
    let pumpCount = 0
    vi.mocked(sdk.api.post).mockImplementation(async (path, body) => {
      if (path !== '/extensions/momai-vision/command') return { ok: true, data: {} }
      const toolName = body?.toolName
      switch (toolName) {
        case 'list_cameras':
          return { ok: true, data: { cameras: [WEB_A], selectedCameras: ['webcam:a'] } }
        case 'get_status':
          return { ok: true, data: { monitors: [], cameras: { 'webcam:a': { online: true, monitors: 0 } } } }
        case 'list_alerts':
          return { ok: true, data: { alerts: [] } }
        case 'list_snapshots':
          return { ok: true, data: { snapshots: [] } }
        case 'get_frame':
          return { ok: true, data: { jpegBase64: 'data:image/jpeg;base64,AAA' } }
        case 'frame_pump':
          pumpCount++
          if (pumpCount === 1) return { ok: true, data: { detections: [] } }
          // A partir do 2º ciclo o frame_pump falha (engine ocupado/timeout): o
          // pump não pode morrer — precisa continuar agendando o próximo ciclo.
          throw new Error('engine ocupado (falha simulada)')
        default:
          return { ok: true, data: {} }
      }
    })

    // fetchDirectFrame devolve um JPEG para o pump obter um frame local (sem
    // depender de <video>/worker no jsdom).
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ jpegBase64: 'data:image/jpeg;base64,AAA' })
    }))
    vi.stubGlobal('fetch', fetchMock)

    try {
      render(<VisionPage />)
      await screen.findByText('MomAI Vision')

      // Com a falha do frame_pump a partir do 2º ciclo, o pump precisa ter
      // continuado: mais de 1 chamada = o loop sobreviveu ao erro e re-agendou.
      await waitFor(() => expect(pumpCount).toBeGreaterThan(1), { timeout: 8000 })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('VisionPage — frame direto do host só para webcam', () => {
  it('não bate em /media/camera/frame para câmera IP (evita 404 a cada ciclo)', async () => {
    const IP_CAM = { id: 'ip:rtsp://192.168.0.2:554/onvif1', name: 'Rua', source: 'ip', online: true, monitors: 0 } as const
    let pumpCount = 0
    const toolsCalled: string[] = []
    const pumpPayloads: Array<Record<string, unknown>> = []
    const sdk = getSDK()
    vi.mocked(sdk.api.post).mockImplementation(async (path, body) => {
      if (path !== '/extensions/momai-vision/command') return { ok: true, data: {} }
      toolsCalled.push(String(body?.toolName))
      switch (body?.toolName) {
        case 'list_cameras':
          return { ok: true, data: { cameras: [IP_CAM], selectedCameras: [IP_CAM.id] } }
        case 'get_status':
          return { ok: true, data: { monitors: [], cameras: { [IP_CAM.id]: { online: true, monitors: 0 } } } }
        case 'list_alerts':
          return { ok: true, data: { alerts: [] } }
        case 'list_snapshots':
          return { ok: true, data: { snapshots: [] } }
        case 'get_frame':
          return { ok: true, data: { jpegBase64: 'data:image/jpeg;base64,AAA' } }
        case 'frame_pump':
          pumpCount++
          pumpPayloads.push((body?.args || {}) as Record<string, unknown>)
          return { ok: true, data: { detections: [] } }
        default:
          return { ok: true, data: {} }
      }
    })

    // O stream MJPEG responde sem body. Para IP o pump usa o frame que o
    // worker já mantém: não pode cair no get_frame nem reenviar o JPEG pelo
    // renderer; o fetch direto ao host também NÃO pode ser chamado para IP.
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => ({ ok: true, body: null, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchMock)

    try {
      render(<VisionPage />)
      await screen.findByText('MomAI Vision')
      await waitFor(() => expect(pumpCount).toBeGreaterThan(0), { timeout: 8000 })

      // O warmup de montagem dispara UM get_frame para iniciar o stream; o pump
      // não pode depender dele (no código antigo cada ciclo chamava get_frame e
      // reenviava o JPEG pelo renderer).
      const getFrameCalls = toolsCalled.filter((tool) => tool === 'get_frame').length
      expect(getFrameCalls).toBeLessThanOrEqual(1)
      expect(pumpPayloads.length).toBeGreaterThan(0)
      expect(pumpPayloads.every((args) => args.jpegBase64 === undefined)).toBe(true)
      const hitDirectFrame = fetchMock.mock.calls.some((call) => String(call[0]).includes('/media/camera/frame/'))
      expect(hitDirectFrame).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('VisionPage — Limpar Cache e Conexões da câmera IP', () => {
  it('chama clear_camera_cache ao clicar no botão de limpar cache no modal de adicionar câmera', async () => {
    const { calls } = setupServer({ cameras: [] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    fireEvent.click(screen.getByRole('tab', { name: /Câmeras IP/ }))

    fireEvent.change(screen.getByPlaceholderText(/URL \(http/), { target: { value: 'rtsp://admin:pass@192.168.0.2:554/onvif1' } })
    const clearBtn = screen.getByRole('button', { name: /Limpar Cache e Conexões/i })
    expect(clearBtn).toBeTruthy()
    fireEvent.click(clearBtn)

    await waitFor(() => {
      const clearCall = calls.find((c) => c.toolName === 'clear_camera_cache')
      expect(clearCall).toBeTruthy()
      expect(clearCall!.args.url).toBe('rtsp://192.168.0.2:554/onvif1')
    })

    await screen.findByText(/Conexões e cache limpos!/i)
  })

  it('mantém o modo de conexão selecionado (UDP) ao limpar o cache', async () => {
    setupServer({ cameras: [] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    fireEvent.click(screen.getByRole('tab', { name: /Câmeras IP/ }))

    // Seleciona UDP
    const udpRadio = screen.getByRole('radio', { name: /UDP/i }) as HTMLInputElement
    fireEvent.click(udpRadio)
    expect(udpRadio.checked).toBe(true)

    // Clica em limpar cache
    const clearBtn = screen.getByRole('button', { name: /Limpar Cache e Conexões/i })
    fireEvent.click(clearBtn)
    await screen.findByText(/Conexões e cache limpos!/i)

    // Confirma que UDP continua selecionado (não foi forçado para TCP)
    expect(udpRadio.checked).toBe(true)
  })

  it('fecha o modal ao disparar o evento momai:close_automation_modal (navegação lateral)', async () => {
    setupServer({ cameras: [] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    expect(screen.getByRole('dialog')).toBeTruthy()

    // Simula clique na barra lateral (evento global disparado pelo App)
    window.dispatchEvent(new CustomEvent('momai:close_automation_modal'))

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  it('fecha o modal ao clicar na tecla Escape', async () => {
    setupServer({ cameras: [] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    expect(screen.getByRole('dialog')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })
})

describe('VisionPage — botões removidos do modal de adicionar câmera', () => {
  it('não exibe perfil de estabilidade nem busca na rede', async () => {
    setupServer({ cameras: [] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    fireEvent.click(screen.getByRole('tab', { name: /Câmeras IP/ }))

    expect(screen.queryByText('Perfil de estabilidade')).toBeNull()
    expect(screen.queryByText('Estável / Wi-Fi')).toBeNull()
    expect(screen.queryByText('Baixa Latência / Cabo')).toBeNull()
    expect(screen.queryByText('Buscar na rede')).toBeNull()
    expect(screen.queryByText('Câmeras na rede local')).toBeNull()
  })

  it('não exibe a dica de substream ao digitar uma URL onvif1', async () => {
    setupServer({ cameras: [] })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openCameraModal()
    fireEvent.click(screen.getByRole('tab', { name: /Câmeras IP/ }))
    fireEvent.change(screen.getByPlaceholderText(/URL \(http/), { target: { value: 'rtsp://admin:pass@192.168.0.2:554/onvif1' } })

    expect(screen.queryByText(/Mudar para Substream/)).toBeNull()
    expect(screen.queryByText(/canal secundário \(substream\)/)).toBeNull()
  })
})

describe('VisionPage — último frame em cache no card', () => {
  it('mostra o último frame salvo e gira o ícone de recarregar até a conexão voltar', async () => {
    const CAM = {
      id: 'ip:rtsp://192.168.0.2:554/onvif2',
      name: 'Quintal',
      source: 'ip',
      online: true,
      monitors: 0
    } as const
    localStorage.setItem(frameCacheKey(CAM.id), 'data:image/jpeg;base64,/9j/4AAQSkZJRg==')
    setupServer({
      cameras: [{ ...CAM }],
      selectedCameras: [CAM.id],
      ipCameras: [{ id: CAM.id, name: 'Quintal', url: 'rtsp://192.168.0.2:554/onvif2' }]
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    // The card opens already showing the stored frame — no placeholder.
    await waitFor(() => {
      const canvas = document.querySelector('canvas')
      expect(canvas).toBeTruthy()
      expect(canvas!.className).not.toContain('opacity-0')
    })
    expect(screen.queryByText('Iniciando...')).toBeNull()

    // Until the live stream takes over, the reload icon keeps spinning.
    const reloadBtn = screen.getByRole('button', { name: 'Recarregar câmera' })
    expect(reloadBtn.querySelector('svg')?.classList.contains('animate-spin')).toBe(true)
  })
})

describe('VisionPage — pausar e retomar vídeo da câmera', () => {
  it('exibe opção Pausar vídeo no menu de contexto e persiste ao clicar', async () => {
    const CAM = {
      id: 'ip:rtsp://192.168.0.2:554/onvif2',
      name: 'Garagem',
      source: 'ip',
      online: true,
      monitors: 0
    } as const
    const { calls } = setupServer({
      cameras: [{ ...CAM }],
      selectedCameras: [CAM.id],
      ipCameras: [{ id: CAM.id, name: 'Garagem', url: 'rtsp://192.168.0.2:554/onvif2' }]
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    const card = screen.getByText('Garagem').closest('.group')
    expect(card).toBeTruthy()
    fireEvent.contextMenu(card!)

    const cameraGroup = await screen.findByRole('menuitem', { name: 'Câmera' })
    fireEvent.mouseEnter(cameraGroup.parentElement!)
    const pauseItem = await screen.findByText('Pausar vídeo')
    expect(pauseItem).toBeTruthy()

    fireEvent.click(pauseItem)

    await waitFor(() => {
      const configureCall = calls.find((c) => c.toolName === 'configure' && c.args.pausedCameras !== undefined)
      expect(configureCall).toBeTruthy()
      expect(configureCall!.args.pausedCameras).toContain(CAM.id)
    })
  })

  it('exibe badge e overlay de Pausada quando a câmera está na lista de pausedCameras', async () => {
    const CAM = {
      id: 'ip:rtsp://192.168.0.2:554/onvif2',
      name: 'Garagem',
      source: 'ip',
      online: true,
      monitors: 0
    } as const
    localStorage.setItem('momai-vision:config', JSON.stringify({
      selectedCameras: [CAM.id],
      pausedCameras: [CAM.id]
    }))
    const { calls } = setupServer({
      cameras: [{ ...CAM }],
      selectedCameras: [CAM.id],
      pausedCameras: [CAM.id],
      ipCameras: [{ id: CAM.id, name: 'Garagem', url: 'rtsp://192.168.0.2:554/onvif2' }]
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    expect(screen.getAllByText('Pausada').length).toBeGreaterThan(0)
    expect(screen.getByText('Clique para retomar o vídeo')).toBeTruthy()

    const resumeBtn = screen.getByTitle('Retomar vídeo')
    expect(resumeBtn).toBeTruthy()
    fireEvent.click(resumeBtn)

    await waitFor(() => {
      const configureCall = calls.find((c) => c.toolName === 'configure' && c.args.pausedCameras !== undefined)
      expect(configureCall).toBeTruthy()
      expect(configureCall!.args.pausedCameras).toEqual([])
    })
  })

  it('persiste a imagem de fundo através de tag img quando a câmera está pausada', async () => {
    const CAM = {
      id: 'ip:rtsp://192.168.0.2:554/onvif2',
      name: 'Garagem',
      source: 'ip',
      online: true,
      monitors: 0
    } as const
    const FAKE_FRAME = 'data:image/jpeg;base64,PAUSED_FRAME_DATA'
    localStorage.setItem('momai-vision:config', JSON.stringify({
      selectedCameras: [CAM.id],
      pausedCameras: [CAM.id]
    }))
    localStorage.setItem('momai-vision:lastframe:' + CAM.id, FAKE_FRAME)
    setupServer({
      cameras: [{ ...CAM }],
      selectedCameras: [CAM.id],
      pausedCameras: [CAM.id],
      ipCameras: [{ id: CAM.id, name: 'Garagem', url: 'rtsp://192.168.0.2:554/onvif2' }]
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    // Verifica que o overlay de Pausada está presente
    expect(screen.getByText('Clique para retomar o vídeo')).toBeTruthy()

    // Verifica que a imagem persistente de fundo está presente com o src do frame congelado
    const pausedImgs = document.querySelectorAll('img[src="data:image/jpeg;base64,PAUSED_FRAME_DATA"]')
    expect(pausedImgs.length).toBeGreaterThan(0)
  })

  it('exibe opção Retomar vídeo ao clicar com o botão direito em câmera pausada', async () => {
    const CAM = {
      id: 'ip:rtsp://192.168.0.2:554/onvif2',
      name: 'Garagem',
      source: 'ip',
      online: true,
      monitors: 0
    } as const
    localStorage.setItem('momai-vision:config', JSON.stringify({
      selectedCameras: [CAM.id],
      pausedCameras: [CAM.id]
    }))
    const { calls } = setupServer({
      cameras: [{ ...CAM }],
      selectedCameras: [CAM.id],
      pausedCameras: [CAM.id],
      ipCameras: [{ id: CAM.id, name: 'Garagem', url: 'rtsp://192.168.0.2:554/onvif2' }]
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    const card = screen.getByText('Garagem').closest('.group')
    expect(card).toBeTruthy()
    fireEvent.contextMenu(card!)

    const cameraGroup = await screen.findByRole('menuitem', { name: 'Câmera' })
    fireEvent.mouseEnter(cameraGroup.parentElement!)

    // Right-clicking a paused camera MUST show "Retomar vídeo", NOT "Pausar vídeo"
    const resumeItem = await screen.findByText('Retomar vídeo')
    expect(resumeItem).toBeTruthy()
    expect(screen.queryByText('Pausar vídeo')).toBeNull()

    // Canvas must stay visible (not opacity-0) while paused
    const canvas = card!.querySelector('canvas')
    expect(canvas).toBeTruthy()
    expect(canvas!.className).not.toContain('opacity-0')

    // Clicking "Retomar vídeo" resumes the camera
    fireEvent.click(resumeItem)
    await waitFor(() => {
      const configureCall = calls.find((c) => c.toolName === 'configure' && c.args.pausedCameras !== undefined)
      expect(configureCall).toBeTruthy()
      expect(configureCall!.args.pausedCameras).toEqual([])
    })
  })

  it('reconhece câmera pausada mesmo com credenciais na URL e mantém após poll', async () => {
    const CAM_WITH_AUTH = {
      id: 'ip:rtsp://admin:secret@192.168.0.2:554/onvif2',
      name: 'Entrada',
      source: 'ip',
      online: true,
      monitors: 0
    } as const
    const CLEAN_ID = 'ip:rtsp://192.168.0.2:554/onvif2'
    localStorage.setItem('momai-vision:config', JSON.stringify({
      selectedCameras: [CAM_WITH_AUTH.id],
      pausedCameras: [CLEAN_ID]
    }))
    setupServer({
      cameras: [{ ...CAM_WITH_AUTH }],
      selectedCameras: [CAM_WITH_AUTH.id],
      pausedCameras: [CLEAN_ID],
      ipCameras: [{ id: CAM_WITH_AUTH.id, name: 'Entrada', url: 'rtsp://192.168.0.2:554/onvif2' }]
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    const card = screen.getByText('Entrada').closest('.group')
    expect(card).toBeTruthy()
    fireEvent.contextMenu(card!)

    const cameraGroup = await screen.findByRole('menuitem', { name: 'Câmera' })
    fireEvent.mouseEnter(cameraGroup.parentElement!)

    const resumeItem = await screen.findByText('Retomar vídeo')
    expect(resumeItem).toBeTruthy()
  })

  it('restaura a imagem de fundo em cache ao abrir o app com câmera já pausada (sem sobrescrever com canvas preto)', async () => {
    const CAM = {
      id: 'ip:rtsp://192.168.0.2:554/onvif2',
      name: 'Garagem',
      source: 'ip',
      online: true,
      monitors: 0
    } as const
    const JPEG = 'data:image/jpeg;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    localStorage.setItem(`momai-vision:lastframe:${CAM.id}`, JPEG)
    localStorage.setItem('momai-vision:config', JSON.stringify({
      selectedCameras: [CAM.id],
      pausedCameras: [CAM.id]
    }))
    setupServer({
      cameras: [{ ...CAM }],
      selectedCameras: [CAM.id],
      pausedCameras: [CAM.id],
      ipCameras: [{ id: CAM.id, name: 'Garagem', url: 'rtsp://192.168.0.2:554/onvif2' }]
    })
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    const card = screen.getByText('Garagem').closest('.group')
    expect(card).toBeTruthy()

    // Imagem do frame persistido deve estar visível
    const img = card!.querySelector('img[src^="data:image/jpeg"]') as HTMLImageElement | null
    expect(img).toBeTruthy()
    expect(img?.src).toBe(JPEG)

    // O frame em cache no localStorage não deve ter sido apagado nem sobrescrito com canvas vazio
    const cachedAfterMount = localStorage.getItem(`momai-vision:lastframe:${CAM.id}`)
    expect(cachedAfterMount).toBe(JPEG)
  })

  it('salva o nome da câmera no backend, no localStorage aliases e exibe imediatamente no card', async () => {
    const { calls } = setupServer({
      cameras: [],
      selectedCameras: [],
      ipCameras: []
    })

    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    await openCameraModal()
    await stageIp('Câmera do Quintal', 'rtsp://192.168.1.100:554/stream')

    const confirmBtn = screen.getByRole('button', { name: /Adicionar 1 câmera/i })
    fireEvent.click(confirmBtn)

    // O card com o nome configurado deve aparecer na tela
    await screen.findByText('Câmera do Quintal')

    // Deve salvar no localStorage momai-vision:camera-names
    await waitFor(() => {
      const raw = localStorage.getItem('momai-vision:camera-names')
      expect(raw).toBeTruthy()
      const aliases = JSON.parse(raw!)
      expect(aliases['ip:rtsp://192.168.1.100:554/stream']).toBe('Câmera do Quintal')
    })

    // Deve enviar configure com o nome da câmera para o backend
    await waitFor(() => {
      const configureCalls = calls.filter((c) => c.toolName === 'configure' && c.args.ipCameras)
      expect(configureCalls.length).toBeGreaterThan(0)
      const last = configureCalls[configureCalls.length - 1]
      const ipCams = last.args.ipCameras as Array<{ id: string; name: string }>
      expect(ipCams.some((c) => c.name === 'Câmera do Quintal')).toBe(true)
    })
  })
})



