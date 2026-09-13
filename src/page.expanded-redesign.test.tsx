import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { getSDK } from 'momai:sdk'
import VisionPage from './page'

const IP_A = { id: 'ip:http://10.0.0.1:8080/video', name: 'Portão', source: 'ip', online: true, monitors: 0 } as const
const CAM_B = { id: 'webcam:b', name: 'Garagem', source: 'webcam', online: true, monitors: 0 } as const
const CAM_EXTRA = { id: 'webcam:extra', name: 'Webcam Interna', source: 'webcam', online: true, monitors: 0 } as const

interface CameraLite {
  id: string
  name: string
  source: 'webcam' | 'ip'
  online: boolean
  monitors: number
}

function setupServer(
  cameras: readonly CameraLite[] = [IP_A, CAM_B],
  selectedIds: string[] = cameras.map((c) => c.id)
) {
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = []
  const sdk = getSDK()
  vi.mocked(sdk.api.post).mockImplementation(async (path: string, body?: { toolName: string; args: Record<string, unknown> }) => {
    if (path !== '/extensions/momai-vision/command') return { ok: true, data: {} }
    const { toolName } = body || { toolName: '', args: {} }
    calls.push({ toolName, args: body?.args || {} })
    switch (toolName) {
      case 'list_cameras':
        return {
          ok: true,
          data: {
            cameras: cameras.map((c) => ({ ...c, selected: selectedIds.includes(c.id) })),
            selectedCameras: [...selectedIds]
          }
        }
      case 'get_status':
        return {
          ok: true,
          data: {
            monitors: [],
            cameras: Object.fromEntries(cameras.map((c) => [c.id, { online: true, monitors: 0 }]))
          }
        }
      case 'list_alerts':
        return { ok: true, data: { alerts: [] } }
      case 'list_snapshots':
        return { ok: true, data: { snapshots: [] } }
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

async function openExpandedFor(name: string) {
  await screen.findByText('MomAI Vision')
  const label = await screen.findByTitle(name)
  const card = label.closest('div.group') as HTMLElement
  const btn = card.querySelector('[aria-label="Ampliar imagem (tela cheia)"]') as HTMLElement
  fireEvent.click(btn)
  await screen.findByTitle('Dois cliques para fechar')
}

function headerEl() {
  return screen.getByTestId('expanded-header')
}

function openGroup(label: string) {
  fireEvent.click(within(headerEl()).getByRole('button', { name: label }))
}

function clickItem(name: string) {
  fireEvent.click(within(headerEl()).getByRole('menuitem', { name }))
}

describe('VisionPage — reforma da câmera ampliada', () => {
  it('cabeçalho usa menus agrupados e mantém os rótulos dos grupos', async () => {
    setupServer()
    render(<VisionPage />)
    await openExpandedFor('Portão')

    const header = headerEl()
    expect(within(header).getByRole('button', { name: 'Ver' })).toBeTruthy()
    expect(within(header).getByRole('button', { name: 'Ações' })).toBeTruthy()
    expect(within(header).getByRole('button', { name: 'Câmera' })).toBeTruthy()
    expect(within(header).getByRole('button', { name: 'Fechar' })).toBeTruthy()

    // O cabeçalho cria contexto próprio (blur) e vem antes do vídeo no DOM:
    // sem um z-index acima do painel, o menu aberto pinta por baixo da imagem.
    expect(header.className).toMatch(/z-40/)

    openGroup('Ver')
    expect(within(header).getByRole('menuitem', { name: 'Esconder boxes' })).toBeTruthy()
    expect(within(header).getByRole('menuitem', { name: 'Ativar reconhecimento' })).toBeTruthy()
    expect(within(header).getByRole('menuitem', { name: 'Ajustar' })).toBeTruthy()

    openGroup('Ações')
    expect(within(header).getByRole('menuitem', { name: 'Tirar print' })).toBeTruthy()
    expect(within(header).getByRole('menuitem', { name: 'Adicionar Monitoramento' })).toBeTruthy()
    expect(within(header).getByRole('menuitem', { name: 'Recarregar câmera' })).toBeTruthy()

    openGroup('Câmera')
    expect(within(header).getByRole('menuitem', { name: 'Editar Câmera' })).toBeTruthy()
    expect(within(header).getByRole('menuitem', { name: 'Copiar URL' })).toBeTruthy()
    expect(within(header).getByRole('menuitem', { name: 'Definir área de monitoramento' })).toBeTruthy()
  })

  it('alterna entre Preencher e Ajustar, persiste a escolha e reflete no vídeo', async () => {
    setupServer()
    render(<VisionPage />)
    await openExpandedFor('Portão')

    expect((screen.getByTestId('expanded-video') as HTMLElement).className).toContain('object-cover')

    openGroup('Ver')
    clickItem('Ajustar')

    expect((screen.getByTestId('expanded-video') as HTMLElement).className).toContain('object-contain')
    expect(localStorage.getItem('momai-vision:expanded-fill')).toBe('contain')

    openGroup('Ver')
    expect(within(headerEl()).getByRole('menuitem', { name: 'Preencher' })).toBeTruthy()
  })

  it('faixa inferior lista as outras câmeras e troca a exibida ao clicar', async () => {
    setupServer()
    render(<VisionPage />)
    await openExpandedFor('Portão')

    const strip = screen.getByTestId('expanded-camera-strip')
    const thumb = within(strip).getByRole('button', { name: 'Garagem' }) as HTMLElement
    // O host não gera classes que só a extensão usa (ex.: aspect-video): a
    // miniatura precisa de tamanho inline para não colapsar.
    expect(thumb.style.width).toBe('182px')
    expect(thumb.style.aspectRatio).toBe('16 / 9')
    fireEvent.click(thumb)

    expect(await screen.findByRole('heading', { name: /Garagem/ })).toBeTruthy()
    expect(within(screen.getByTestId('expanded-camera-strip')).getByRole('button', { name: 'Portão' })).toBeTruthy()
  })

  it('alinha a faixa ao ritmo do cabeçalho e unifica o raio das miniaturas', async () => {
    setupServer()
    render(<VisionPage />)
    await openExpandedFor('Portão')

    const strip = screen.getByTestId('expanded-camera-strip')
    const thumb = within(strip).getByRole('button', { name: 'Garagem' }) as HTMLElement

    // Mesmo ritmo do cabeçalho: margens laterais e vertical iguais às do header.
    for (const cls of ['px-3', 'sm:px-6', 'py-3']) {
      expect(headerEl().className).toContain(cls)
      expect(strip.className).toContain(cls)
    }
    // A miniatura segue o vocabulário arredondado dos controles da ampliada.
    expect(thumb.className).toContain('rounded-xl')
    expect(thumb.className).not.toContain('rounded-lg')
  })

  it('mostra só as câmeras adicionadas, não todas as do PC', async () => {
    setupServer([IP_A, CAM_B, CAM_EXTRA], [IP_A.id, CAM_B.id])
    render(<VisionPage />)
    await openExpandedFor('Portão')

    expect(screen.queryByRole('button', { name: 'Webcam Interna' })).toBeNull()
    expect(within(screen.getByTestId('expanded-camera-strip')).getByRole('button', { name: 'Garagem' })).toBeTruthy()
  })

  it('editor de área na ampliada usa botões com rótulo e sem emoji', async () => {
    setupServer()
    render(<VisionPage />)
    await openExpandedFor('Portão')

    openGroup('Câmera')
    clickItem('Definir área de monitoramento')

    const dock = await screen.findByTestId('expanded-zone-dock')
    expect(dock.textContent).toContain('Cancelar')
    expect(dock.textContent).toContain('Limpar')
    expect(dock.textContent).toContain('Salvar')
    expect(dock.textContent).not.toMatch(/✏️|▢|📍/)

    const save = within(dock).getByRole('button', { name: 'Salvar' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })

  it('pausa a grade enquanto a ampliada está aberta e retoma ao fechar', async () => {
    const { calls } = setupServer()
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ jpegBase64: 'data:image/jpeg;base64,AAA' })
    }))
    vi.stubGlobal('fetch', fetchMock)

    const pumpsFor = (cameraId: string) =>
      calls.filter((c) => c.toolName === 'frame_pump' && c.args.cameraId === cameraId).length

    try {
      render(<VisionPage />)
      await screen.findByText('MomAI Vision')

      // A grade precisa estar bombeando antes de abrir a ampliada.
      await waitFor(() => expect(pumpsFor(CAM_B.id)).toBeGreaterThan(0), { timeout: 8000 })

      await openExpandedFor('Portão')
      const before = pumpsFor(CAM_B.id)

      await new Promise((r) => setTimeout(r, 1600))
      expect(pumpsFor(CAM_B.id)).toBe(before)

      fireEvent.click(screen.getByRole('button', { name: 'Fechar' }))
      await waitFor(() => expect(screen.queryByTitle('Dois cliques para fechar')).toBeNull())

      await waitFor(() => expect(pumpsFor(CAM_B.id)).toBeGreaterThan(before), { timeout: 5000 })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
