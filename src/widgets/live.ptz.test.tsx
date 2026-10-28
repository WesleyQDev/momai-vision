import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { getSDK } from 'momai:sdk'
import VisionLiveWidget from './live'

vi.mock('../hooks/useI18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      const dict: Record<string, string> = {
        'widget.live.title': 'Visão da Câmera',
        'cameras.ptzControl': 'Controle PTZ',
        'cameras.ptzClose': 'Fechar PTZ'
      }
      return dict[key] || key
    }
  })
}))

vi.mock('./hooks/useLiveWidget', () => ({
  useLiveWidget: (cameraId: string) => ({
    status: 'live',
    error: '',
    cameraName: 'Câmera Teste',
    canvasRef: { current: null },
    retry: vi.fn()
  })
}))

describe('VisionLiveWidget — PTZ overlay', () => {
  let overlayRoot: HTMLDivElement

  beforeEach(() => {
    overlayRoot = document.createElement('div')
    overlayRoot.id = 'momai-extension-overlay-root'
    overlayRoot.className = 'pointer-events-none absolute inset-0 z-20 overflow-hidden'
    document.body.appendChild(overlayRoot)

    const sdk = getSDK()
    if (sdk?.ui) {
      sdk.ui.overlayRoot = () => overlayRoot
    }
  })

  afterEach(() => {
    cleanup()
    if (overlayRoot.parentNode) {
      overlayRoot.parentNode.removeChild(overlayRoot)
    }
    vi.restoreAllMocks()
  })

  it('abre overlay do PTZ ao clicar no botão PTZ e fecha no botão Fechar', async () => {
    render(<VisionLiveWidget config={{ cameraId: 'ip:192.168.0.50:554' }} />)

    const ptzButton = screen.getByTitle('Controle PTZ')
    expect(ptzButton).toBeTruthy()

    // Abre o PTZ
    fireEvent.click(ptzButton)

    await waitFor(() => {
      expect(screen.getByTitle('Fechar PTZ')).toBeTruthy()
    })

    // O card tem pointer-events-auto para interatividade
    const closeBtn = screen.getByTitle('Fechar PTZ')
    const card = closeBtn.closest('.pointer-events-auto')
    expect(card).toBeTruthy()

    // Clica no botão fechar
    fireEvent.click(closeBtn)

    await waitFor(() => {
      expect(screen.queryByTitle('Fechar PTZ')).toBeNull()
    })
  })

  it('fecha o overlay do PTZ ao clicar novamente no botão de PTZ (toggle)', async () => {
    render(<VisionLiveWidget config={{ cameraId: 'ip:192.168.0.50:554' }} />)

    const ptzButton = screen.getByTitle('Controle PTZ')
    fireEvent.click(ptzButton)

    await waitFor(() => {
      expect(screen.getByTitle('Fechar PTZ')).toBeTruthy()
    })

    // Toggle off
    fireEvent.click(ptzButton)

    await waitFor(() => {
      expect(screen.queryByTitle('Fechar PTZ')).toBeNull()
    })
  })

  it('fecha o overlay do PTZ ao mudar de aba (evento momai_navigate)', async () => {
    render(<VisionLiveWidget config={{ cameraId: 'ip:192.168.0.50:554' }} />)

    const ptzButton = screen.getByTitle('Controle PTZ')
    fireEvent.click(ptzButton)

    await waitFor(() => {
      expect(screen.getByTitle('Fechar PTZ')).toBeTruthy()
    })

    // Usuário troca de aba (evento disparado pelo router/host)
    act(() => {
      window.dispatchEvent(new CustomEvent('momai_navigate', { detail: { path: '/agenda' } }))
    })

    await waitFor(() => {
      expect(screen.queryByTitle('Fechar PTZ')).toBeNull()
    })
  })

  it('fecha o overlay do PTZ quando a aba do chat fica oculta (aria-hidden ou inert)', async () => {
    const parentContainer = document.createElement('div')
    document.body.appendChild(parentContainer)

    const { container } = render(
      <VisionLiveWidget config={{ cameraId: 'ip:192.168.0.50:554' }} />,
      { container: parentContainer }
    )

    const ptzButton = screen.getByTitle('Controle PTZ')
    fireEvent.click(ptzButton)

    await waitFor(() => {
      expect(screen.getByTitle('Fechar PTZ')).toBeTruthy()
    })

    // Host marca a view do chat como inert/aria-hidden ao trocar de rota
    act(() => {
      parentContainer.setAttribute('aria-hidden', 'true')
    })

    await waitFor(() => {
      expect(screen.queryByTitle('Fechar PTZ')).toBeNull()
    })

    if (parentContainer.parentNode) {
      parentContainer.parentNode.removeChild(parentContainer)
    }
  })

  it('permite arrastar o card sem que ele trave', async () => {
    render(<VisionLiveWidget config={{ cameraId: 'ip:192.168.0.50:554' }} />)

    const ptzButton = screen.getByTitle('Controle PTZ')
    fireEvent.click(ptzButton)

    await waitFor(() => {
      expect(screen.getByTitle('Fechar PTZ')).toBeTruthy()
    })

    const closeBtn = screen.getByTitle('Fechar PTZ')
    const cardEl = closeBtn.closest('.pointer-events-auto') as HTMLElement
    expect(cardEl).toBeTruthy()

    const titleEl = cardEl.querySelector('[data-ptz-title="true"]') as HTMLElement
    expect(titleEl).toBeTruthy()

    const initialLeft = cardEl.style.left
    const initialTop = cardEl.style.top

    // Simula arrasto
    fireEvent.pointerDown(titleEl, { button: 0, clientX: 200, clientY: 200, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 250, clientY: 230, pointerId: 1 })
    fireEvent.pointerUp(window, { clientX: 250, clientY: 230, pointerId: 1 })

    // A posição mudou
    expect(cardEl.style.left).not.toBe(initialLeft)
    expect(cardEl.style.top).not.toBe(initialTop)
  })
})
