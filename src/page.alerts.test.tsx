import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { getSDK } from 'momai:sdk'
import VisionPage from './page'

interface ServerAlert {
  ts: number
  cameraName?: string
  triggeredBy?: string
  className?: string
  description?: string
  snapshotId?: string
}

// In-memory fake of the extension backend focused on the alerts feed: the
// server holds the persisted alerts history (what list_alerts returns) and
// records every subscribe so tests can emit SSE events like the real host.
function setupServer(initialAlerts: ServerAlert[] = []) {
  const state = { alerts: [...initialAlerts] }
  const sdk = getSDK()
  const subscribed: Array<{ type: string; handler: (data: unknown) => void }> = []
  vi.mocked(sdk.api.post).mockImplementation(
    async (path: string, body?: { toolName: string; args: Record<string, unknown> }) => {
      if (path !== '/extensions/momai-vision/command') {
        return { ok: true, data: {} }
      }
      const { toolName } = body || { toolName: '' }
      switch (toolName) {
        case 'list_cameras':
          return { ok: true, data: { cameras: [], selectedCameras: [] } }
        case 'get_status':
          return { ok: true, data: { monitors: [] } }
        case 'list_alerts':
          return { ok: true, data: { alerts: state.alerts } }
        case 'list_snapshots':
          return { ok: true, data: { snapshots: [] } }
        default:
          return { ok: true, data: {} }
      }
    }
  )
  vi.mocked(sdk.events.subscribe).mockImplementation(
    ((type: string, handler: (data: unknown) => void) => {
      subscribed.push({ type, handler })
      return () => {}
    }) as never
  )
  return { sdk, state, subscribed }
}

function alertHandler(subscribed: Array<{ type: string; handler: (data: unknown) => void }>) {
  const entry = subscribed.find((s) => s.type === 'vision_alert')
  if (!entry) throw new Error('vision_alert handler not subscribed')
  return entry.handler
}

function statusHandler(subscribed: Array<{ type: string; handler: (data: unknown) => void }>) {
  const entry = subscribed.find((s) => s.type === 'vision_status')
  if (!entry) throw new Error('vision_status handler not subscribed')
  return entry.handler
}

async function openAlertsTab() {
  fireEvent.click(screen.getByRole('button', { name: /^Alertas/ }))
  await screen.findByText('Histórico de Alertas')
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  const sdk = getSDK()
  vi.mocked(sdk.api.post).mockReset()
  vi.mocked(sdk.events.subscribe).mockReset()
  vi.mocked(sdk.api.post).mockResolvedValue({ ok: true, data: {} })
  vi.mocked(sdk.events.subscribe).mockReturnValue(() => {})
})

describe('VisionPage — Histórico de Alertas', () => {
  it('exibe todos os alertas retornados pela API na aba', async () => {
    setupServer([
      { ts: 3000, cameraName: 'Câmera A', triggeredBy: 'motion' },
      { ts: 2000, cameraName: 'Câmera B', triggeredBy: 'person' },
      { ts: 1000, cameraName: 'Câmera C', triggeredBy: 'object:car' }
    ])
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openAlertsTab()

    await waitFor(() => {
      expect(screen.getByText(/Câmera A/)).toBeTruthy()
      expect(screen.getByText(/Câmera B/)).toBeTruthy()
      expect(screen.getByText(/Câmera C/)).toBeTruthy()
    })
  })

  it('mantém alertas do SSE que ainda não foram persistidos após o poll', async () => {
    // O backend só tem o alerta antigo persistido.
    const { subscribed } = setupServer([{ ts: 1000, cameraName: 'Câmera A', triggeredBy: 'motion' }])
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openAlertsTab()
    await waitFor(() => expect(screen.getByText(/Câmera A/)).toBeTruthy())

    // Novo alerta chega via SSE, mas o storage do backend ainda não o tem.
    alertHandler(subscribed)({ ts: 2000, cameraName: 'Câmera B', triggeredBy: 'person' })
    await waitFor(() => expect(screen.getByText(/Câmera B/)).toBeTruthy())

    // Poll roda (disparado por vision_status) e a API continua retornando só
    // o alerta persistido: o recém-chegado não pode sumir da tela.
    statusHandler(subscribed)({ changedAt: Date.now() })
    await waitFor(() => {
      expect(screen.getByText(/Câmera B/)).toBeTruthy()
      expect(screen.getByText(/Câmera A/)).toBeTruthy()
    })
  })

  it('não zera o histórico quando list_alerts falha', async () => {
    const { sdk, subscribed } = setupServer([{ ts: 1000, cameraName: 'Câmera A', triggeredBy: 'motion' }])
    // A falha só passa a ocorrer depois que o carregamento inicial acontece,
    // simulando um timeout intermitente no poll de 5s.
    let failAlerts = false
    const original = vi.mocked(sdk.api.post).getMockImplementation()!
    vi.mocked(sdk.api.post).mockImplementation(async (path, body) => {
      if (
        path === '/extensions/momai-vision/command' &&
        (body as { toolName?: string })?.toolName === 'list_alerts' &&
        failAlerts
      ) {
        return { ok: false, data: { ok: false }, error: 'timeout simulado' }
      }
      return original(path, body)
    })

    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openAlertsTab()
    await waitFor(() => expect(screen.getByText(/Câmera A/)).toBeTruthy())

    failAlerts = true
    alertHandler(subscribed)({ ts: 2000, cameraName: 'Câmera B', triggeredBy: 'person' })
    await waitFor(() => expect(screen.getByText(/Câmera B/)).toBeTruthy())

    statusHandler(subscribed)({ changedAt: Date.now() })
    await waitFor(() => {
      expect(screen.getByText(/Câmera B/)).toBeTruthy()
      expect(screen.getByText(/Câmera A/)).toBeTruthy()
    })
  })

  it('deduplica o mesmo alerta vindo do SSE e do poll', async () => {
    const alert = { ts: 1000, cameraName: 'Câmera A', triggeredBy: 'motion', snapshotId: 'snap-1' }
    const { subscribed } = setupServer([alert])
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openAlertsTab()

    // Mesmo alerta (mesmo snapshotId) chega de novo via SSE.
    alertHandler(subscribed)({ ...alert })
    await waitFor(() => expect(screen.getAllByText(/Câmera A/)).toHaveLength(1))

    // Poll devolve o mesmo alerta persistido: continua sendo um único card.
    statusHandler(subscribed)({ changedAt: Date.now() })
    await waitFor(() => expect(screen.getAllByText(/Câmera A/)).toHaveLength(1))
  })
})
