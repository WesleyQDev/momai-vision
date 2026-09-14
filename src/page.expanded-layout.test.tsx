import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import { getSDK } from 'momai:sdk'
import VisionPage from './page'

const WEB_A = { id: 'webcam:a', name: 'Webcam A', source: 'webcam', online: true, monitors: 0 } as const

function setupServer() {
  const sdk = getSDK()
  vi.mocked(sdk.api.post).mockImplementation(async (path: string, body?: { toolName: string; args: Record<string, unknown> }) => {
    if (path !== '/extensions/momai-vision/command') return { ok: true, data: {} }
    switch (body?.toolName) {
      case 'list_cameras':
        return { ok: true, data: { cameras: [WEB_A], selectedCameras: ['webcam:a'] } }
      case 'get_status':
        return { ok: true, data: { monitors: [], cameras: { 'webcam:a': { online: true, monitors: 0 } } } }
      case 'list_alerts':
        return { ok: true, data: { alerts: [] } }
      case 'list_snapshots':
        return { ok: true, data: { snapshots: [] } }
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

describe('VisionPage — expanded camera stays inside content area', () => {
  it('renders expanded view as absolute (not fixed) so it never goes behind the sidebar', async () => {
    setupServer()
    const { container } = render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    const expandBtn = await screen.findByTitle(/Ampliar imagem|Enlarge image/i)
    fireEvent.click(expandBtn)

    await screen.findByTitle(/Dois cliques para fechar|Double-click to close/i)

    const expanded = screen.getByTestId('expanded-camera')
    // Must be contained in the page (absolute), never a viewport-fixed layer
    // that competes with the host sidebar stacking order.
    expect(expanded.className).toMatch(/\babsolute\b/)
    expect(expanded.className).not.toMatch(/\bfixed\b/)
  })

  it('stays outside the spaced content wrapper so space-y never offsets inset-0', async () => {
    setupServer()
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    const expandBtn = await screen.findByTitle(/Ampliar imagem|Enlarge image/i)
    fireEvent.click(expandBtn)
    const anchor = await screen.findByTitle(/Dois cliques para fechar|Double-click to close/i)

    // A `space-y-*` ancestor applies margin-top to the absolutely positioned
    // overlay and pushes it down, leaving a gap under the host titlebar.
    for (let el: HTMLElement | null = anchor; el && el !== document.body; el = el.parentElement) {
      expect(el.getAttribute('class') || '').not.toMatch(/(^|\s)space-y-5(\s|$)/)
    }
  })

  it('keeps expanded header responsive without overlap', async () => {
    setupServer()
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    const expandBtn = await screen.findByTitle(/Ampliar imagem|Enlarge image/i)
    fireEvent.click(expandBtn)

    await screen.findByTitle(/Dois cliques para fechar|Double-click to close/i)

    const expanded = screen.getByTestId('expanded-camera')
    const header = screen.getByTestId('expanded-header')
    expect(expanded.contains(header)).toBe(true)
    // Header must wrap on narrow widths and the title must truncate.
    expect(header.className).toMatch(/flex-wrap/)
    const title = header.querySelector('h2') as HTMLElement | null
    expect(title).toBeTruthy()
    expect(title!.className).toMatch(/truncate/)
  })
})

describe('VisionPage — fundo da câmera ampliada segue o tema', () => {
  it('não pinta preto nas sobras do vídeo quando há uma câmera só', async () => {
    setupServer()
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    fireEvent.click(await screen.findByTitle(/Ampliar imagem|Enlarge image/i))
    const frame = await screen.findByTitle(/Dois cliques para fechar|Double-click to close/i)

    // Without the thumbnail strip the leftover area around the 16:9 stream is
    // tall; the theme surface keeps it identical to the multi-camera view.
    expect(frame.className).toContain('bg-bg')
    expect(frame.className).not.toContain('bg-black')
    expect((frame.parentElement as HTMLElement).className).not.toContain('bg-black')
  })

  it('placeholder de conexão usa superfície e texto do tema', async () => {
    setupServer()
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    fireEvent.click(await screen.findByTitle(/Ampliar imagem|Enlarge image/i))
    await screen.findByTitle(/Dois cliques para fechar|Double-click to close/i)

    const expanded = screen.getByTestId('expanded-camera')
    const placeholder = within(expanded).getByText('Iniciando...').parentElement as HTMLElement

    expect(placeholder.className).toContain('bg-input/60')
    expect(placeholder.className).toContain('text-text-muted')
    expect(placeholder.className).not.toContain('bg-black')
    expect(placeholder.className).not.toContain('text-white')
  })
})
