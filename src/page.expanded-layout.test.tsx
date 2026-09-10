import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
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

    const root = container.firstElementChild as HTMLElement
    const expanded = root.querySelector('[title*="para fechar"], [title*="to close"]')?.closest('div.flex-1')
      ?.parentElement?.parentElement as HTMLElement | null
    expect(expanded).toBeTruthy()
    // Must be contained in the page (absolute), never a viewport-fixed layer
    // that competes with the host sidebar stacking order.
    expect(expanded!.className).toMatch(/\babsolute\b/)
    expect(expanded!.className).not.toMatch(/\bfixed\b/)
  })

  it('keeps expanded header responsive without overlap', async () => {
    setupServer()
    const { container } = render(<VisionPage />)
    await screen.findByText('MomAI Vision')

    const expandBtn = await screen.findByTitle(/Ampliar imagem|Enlarge image/i)
    fireEvent.click(expandBtn)

    await screen.findByTitle(/Dois cliques para fechar|Double-click to close/i)

    const root = container.firstElementChild as HTMLElement
    const expanded = root.querySelector('[title*="para fechar"], [title*="to close"]')?.closest('div.flex-1')
      ?.parentElement?.parentElement as HTMLElement | null
    expect(expanded).toBeTruthy()
    // Header must wrap on narrow widths and the title must truncate.
    const header = expanded!.querySelector('div.border-b') as HTMLElement | null
    expect(header).toBeTruthy()
    expect(header!.className).toMatch(/flex-wrap/)
    const title = header!.querySelector('h2') as HTMLElement | null
    expect(title).toBeTruthy()
    expect(title!.className).toMatch(/truncate/)
  })
})
