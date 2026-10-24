import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PtzControlCard, getContainingBlockRect, resolveDragPosition } from './PtzControlCard'

describe('PtzControlCard Component', () => {
  const mockSendCommand = vi.fn().mockResolvedValue({ ok: true })
  const mockT = vi.fn((key: string) => {
    if (key === 'cameras.ptzClose') return 'Fechar PTZ'
    return key
  })

  beforeEach(() => {
    mockSendCommand.mockClear()
  })

  it('renderiza título e botões cardeais', () => {
    render(
      <PtzControlCard
        cameraId="ip:rtsp://192.168.0.50:554/onvif1"
        cameraName="Câmera Garagem"
        onClose={vi.fn()}
        t={mockT}
        sendCommand={mockSendCommand}
      />
    )

    expect(screen.getByText('Câmera Garagem')).toBeDefined()
    // O selo "PTZ" foi removido do cabeçalho: só o nome da câmera aparece
    expect(screen.queryByText('PTZ')).toBeNull()
    expect(screen.getByTitle('Cima')).toBeDefined()
    expect(screen.getByTitle('Baixo')).toBeDefined()
    expect(screen.getByTitle('Esquerda')).toBeDefined()
    expect(screen.getByTitle('Direita')).toBeDefined()
  })

  it('dispara passo rápido com velocidade 1.0 e agenda parada consistente', () => {
    vi.useFakeTimers()
    render(
      <PtzControlCard
        cameraId="ip:rtsp://192.168.0.50:554/onvif1"
        cameraName="Câmera Garagem"
        onClose={vi.fn()}
        t={mockT}
        sendCommand={mockSendCommand}
      />
    )

    // Clique rápido em Cima
    const btnUp = screen.getByTitle('Cima')
    fireEvent.pointerDown(btnUp)
    fireEvent.pointerUp(btnUp)

    expect(mockSendCommand).toHaveBeenCalledWith('control_ptz', {
      cameraId: 'ip:rtsp://192.168.0.50:554/onvif1',
      action: 'move',
      direction: 'up',
      speed: 1.0
    })

    // Ao completar o tempo do passo rápido, para com segurança
    vi.advanceTimersByTime(500)

    expect(mockSendCommand).toHaveBeenCalledWith('control_ptz', {
      cameraId: 'ip:rtsp://192.168.0.50:554/onvif1',
      action: 'stop'
    })

    vi.useRealTimers()
  })

  it('mantém movimento contínuo (keep-alive) ao segurar o botão e para imediatamente ao soltar', () => {
    vi.useFakeTimers()
    render(
      <PtzControlCard
        cameraId="ip:rtsp://192.168.0.50:554/onvif1"
        cameraName="Câmera Garagem"
        onClose={vi.fn()}
        t={mockT}
        sendCommand={mockSendCommand}
      />
    )

    const btnRight = screen.getByTitle('Direita')
    fireEvent.pointerDown(btnRight)

    // Primeiro disparo imediato (0ms de latência percebida)
    expect(mockSendCommand).toHaveBeenCalledWith('control_ptz', {
      cameraId: 'ip:rtsp://192.168.0.50:554/onvif1',
      action: 'move',
      direction: 'right',
      speed: 1.0
    })

    // Avança 250ms (ativação do modo contínuo) e mais 700ms (ciclos de repetição a cada 350ms)
    vi.advanceTimersByTime(250)
    vi.advanceTimersByTime(700)

    const moveCalls = mockSendCommand.mock.calls.filter(
      (call) => call[0] === 'control_ptz' && call[1]?.action === 'move' && call[1]?.direction === 'right'
    )
    expect(moveCalls.length).toBeGreaterThanOrEqual(3)

    // Solta o botão: envia stop imediatamente
    fireEvent.pointerUp(btnRight)

    expect(mockSendCommand).toHaveBeenCalledWith('control_ptz', {
      cameraId: 'ip:rtsp://192.168.0.50:554/onvif1',
      action: 'stop'
    })

    vi.useRealTimers()
  })

  it('arrasta o overlay ao pressionar e mover em qualquer área fora do D-pad', () => {
    const { container } = render(
      <PtzControlCard
        cameraId="ip:rtsp://192.168.0.50:554/onvif1"
        cameraName="Câmera Garagem"
        initialPosition={{ x: 100, y: 100 }}
        onClose={vi.fn()}
        t={mockT}
        sendCommand={mockSendCommand}
      />
    )

    const card = container.firstElementChild as HTMLElement
    const title = screen.getByText('Câmera Garagem')

    fireEvent.pointerDown(title, { button: 0, clientX: 200, clientY: 200, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 260, clientY: 240, pointerId: 1 })
    fireEvent.pointerUp(window, { clientX: 260, clientY: 240, pointerId: 1 })

    expect(card.style.left).toBe('160px')
    expect(card.style.top).toBe('140px')
  })

  it('não arrasta o overlay ao pressionar o círculo do D-pad', () => {
    const { container } = render(
      <PtzControlCard
        cameraId="ip:rtsp://192.168.0.50:554/onvif1"
        cameraName="Câmera Garagem"
        initialPosition={{ x: 100, y: 100 }}
        onClose={vi.fn()}
        t={mockT}
        sendCommand={mockSendCommand}
      />
    )

    const card = container.firstElementChild as HTMLElement
    const btnUp = screen.getByTitle('Cima')

    fireEvent.pointerDown(btnUp, { button: 0, clientX: 200, clientY: 200, pointerId: 2 })
    fireEvent.pointerMove(window, { clientX: 300, clientY: 300, pointerId: 2 })
    fireEvent.pointerUp(window, { clientX: 300, clientY: 300, pointerId: 2 })

    expect(card.style.left).toBe('100px')
    expect(card.style.top).toBe('100px')
  })

  const makeRect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({})
    }) as DOMRect

  const mockRects = (rects: Map<Element, DOMRect>) => {
    const empty = makeRect(0, 0, 0, 0)
    return vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return rects.get(this) ?? empty
      })
  }

  it('não salta ao começar a arrastar e continua descendo mesmo com ancestral text-*', () => {
    const { container } = render(
      <div className="text-xs">
        <PtzControlCard
          cameraId="ip:rtsp://192.168.0.50:554/onvif1"
          cameraName="Câmera Garagem"
          initialPosition={{ x: 100, y: 100 }}
          onClose={vi.fn()}
          t={mockT}
          sendCommand={mockSendCommand}
        />
      </div>
    )

    const wrapper = container.firstElementChild as HTMLElement
    const card = wrapper.firstElementChild as HTMLElement

    // O wrapper "text-xs" tem área minúscula: o antigo seletor [class*="ext-"]
    // casava com ele (por causa de "text-") e travava o card no topo.
    const rectSpy = mockRects(
      new Map<Element, DOMRect>([
        [wrapper, makeRect(0, 0, 300, 120)],
        [card, makeRect(100, 100, 192, 205)]
      ])
    )

    const title = screen.getByText('Câmera Garagem')
    fireEvent.pointerDown(title, { button: 0, clientX: 200, clientY: 200, pointerId: 10 })

    // Nada de salto no clique
    expect(card.style.left).toBe('100px')
    expect(card.style.top).toBe('100px')

    fireEvent.pointerMove(window, { clientX: 200, clientY: 400, pointerId: 10 })
    expect(card.style.top).toBe('300px')

    // Trava no limite visível da tela, não na área do wrapper
    fireEvent.pointerMove(window, { clientX: 200, clientY: 700, pointerId: 10 })
    expect(card.style.top).toBe('563px')

    fireEvent.pointerUp(window, { clientX: 200, clientY: 700, pointerId: 10 })
    rectSpy.mockRestore()
  })

  it('ignora ancestrais cujo nome de classe só contém o trecho "ext-"', () => {
    const wrapper = document.createElement('div')
    wrapper.className = 'text-xs'
    const card = document.createElement('div')
    wrapper.appendChild(card)
    document.body.appendChild(wrapper)

    const rect = getContainingBlockRect(card)
    expect(rect.width).toBe(window.innerWidth)
    expect(rect.height).toBe(window.innerHeight)

    document.body.removeChild(wrapper)
  })

  it('resolveDragPosition prende o card na área visível', () => {
    const frame = {
      startLeft: 100,
      startTop: 100,
      clientWidth: 192,
      clientHeight: 205,
      boundsLeft: 0,
      boundsTop: 0,
      boundsRight: 1024,
      boundsBottom: 768,
      originLeft: 0,
      originTop: 0,
      scaleX: 1,
      scaleY: 1
    }

    expect(resolveDragPosition(frame, 0, -500)).toEqual({ x: 100, y: 0 })
    expect(resolveDragPosition(frame, 2000, 2000)).toEqual({ x: 832, y: 563 })
    expect(resolveDragPosition(frame, 40, 30)).toEqual({ x: 140, y: 130 })
  })

  it('chama onClose ao clicar no botão fechar', () => {
    const mockOnClose = vi.fn()
    render(
      <PtzControlCard
        cameraId="ip:rtsp://192.168.0.50:554/onvif1"
        cameraName="Câmera Garagem"
        onClose={mockOnClose}
        t={mockT}
        sendCommand={mockSendCommand}
      />
    )

    const closeBtn = screen.getByTitle('Fechar PTZ')
    fireEvent.click(closeBtn)
    expect(mockOnClose).toHaveBeenCalledTimes(1)
  })
})
