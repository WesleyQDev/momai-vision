import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { getSDK } from 'momai:sdk'
import VisionPage from './page'

interface ServerSnapshot {
  id: string
  ts: number
  description?: string
  imageDataUri?: string
}

function setupServer(initialSnapshots: ServerSnapshot[] = []) {
  const state = { snapshots: [...initialSnapshots] }
  const sdk = getSDK()
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
          return { ok: true, data: { alerts: [] } }
        case 'list_snapshots':
          return { ok: true, data: { snapshots: state.snapshots } }
        default:
          return { ok: true, data: {} }
      }
    }
  )
  return { sdk, state }
}

async function openGalleryTab() {
  fireEvent.click(screen.getByRole('button', { name: /^Prints/ }))
  await screen.findByText('Prints da Câmera')
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

describe('VisionPage — Galeria de Prints', () => {
  it('pagina os prints de 8 em 8 por página', async () => {
    const initialSnapshots = Array.from({ length: 12 }, (_, i) => ({
      id: `snap-${i + 1}`,
      ts: 1000 + i * 100,
      description: `Captura Print ${i + 1}`
    }))
    setupServer(initialSnapshots)
    render(<VisionPage />)
    await screen.findByText('MomAI Vision')
    await openGalleryTab()

    // Na primeira página (1 a 8)
    await waitFor(() => {
      expect(screen.getAllByText(/\bCaptura Print 1\b/).length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText(/\bCaptura Print 8\b/).length).toBeGreaterThanOrEqual(1)
      expect(screen.queryAllByText(/\bCaptura Print 9\b/).length).toBe(0)
    })

    // Navega para a página 2 (9 a 12)
    const page2Button = screen.getByRole('button', { name: '2' })
    fireEvent.click(page2Button)

    await waitFor(() => {
      expect(screen.getAllByText(/\bCaptura Print 9\b/).length).toBeGreaterThanOrEqual(1)
      expect(screen.getAllByText(/\bCaptura Print 12\b/).length).toBeGreaterThanOrEqual(1)
      expect(screen.queryAllByText(/\bCaptura Print 1\b/).length).toBe(0)
    })
  })
})

