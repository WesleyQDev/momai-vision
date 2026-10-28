import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { PtzDirection } from '../vision/onvif-ptz'

export const PTZ_CARD_DIMENSIONS = {
  compact: { width: 144, height: 152 },
  default: { width: 192, height: 205 },
} as const

interface PtzControlCardProps {
  cameraId: string
  cameraName: string
  initialPosition?: { x: number; y: number; compact?: boolean }
  compact?: boolean
  onClose: () => void
  t: (key: string, vars?: any) => string
  sendCommand: (toolName: string, args: Record<string, unknown>) => Promise<any>
}

// Classe exata do root da extensão. Importante: usar igualdade de token
// (`[class~=...]`) e não substring (`[class*="ext-"]`), porque qualquer classe
// `text-*` (text-xs, text-text, text-[11px]...) contém o trecho "ext-" e fazia
// o closest casar com um elemento interno qualquer, com área útil minúscula.
const EXTENSION_ROOT_SELECTOR = '[class~="ext-momai-vision"]'
const EXTENSION_OVERLAY_ROOT_SELECTOR = '#momai-extension-overlay-root'

/** Área visível em coordenadas de tela (client). */
export function getViewportBounds(): { left: number; top: number; right: number; bottom: number } {
  if (typeof window === 'undefined') {
    return { left: 0, top: 0, right: 1200, bottom: 800 }
  }
  const doc = typeof document !== 'undefined' ? document.documentElement : null
  const width = doc?.clientWidth || window.innerWidth || 1200
  const height = doc?.clientHeight || window.innerHeight || 800
  return { left: 0, top: 0, right: width, bottom: height }
}

function isContainingBlockElement(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el)
  if (!style) return false
  return Boolean(
    (el.style.transform && el.style.transform !== 'none') ||
    (style.transform && style.transform !== 'none') ||
    (el.style.perspective && el.style.perspective !== 'none') ||
    (style.perspective && style.perspective !== 'none') ||
    (el.style.filter && el.style.filter !== 'none') ||
    (style.filter && style.filter !== 'none') ||
    (style.willChange && style.willChange.includes('transform'))
  )
}

/**
 * Bloco de contenção real de um elemento `position: fixed`: o ancestral mais
 * próximo com transform/filter/perspective ou, na ausência dele, o root da
 * extensão (ou a viewport).
 */
export function findContainingBlockElement(el?: HTMLElement | null): HTMLElement | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null

  // 1. Bloco raiz de overlay do host (usado por portais de widgets)
  const overlayRoot = el?.closest<HTMLElement>(EXTENSION_OVERLAY_ROOT_SELECTOR)
  if (overlayRoot) return overlayRoot

  let curr = el?.parentElement ?? null
  while (curr && curr !== document.body && curr !== document.documentElement) {
    if (isContainingBlockElement(curr)) return curr
    curr = curr.parentElement
  }

  return (
    el?.closest<HTMLElement>(EXTENSION_ROOT_SELECTOR) ||
    document.querySelector<HTMLElement>(EXTENSION_ROOT_SELECTOR) ||
    document.querySelector<HTMLElement>(EXTENSION_OVERLAY_ROOT_SELECTOR) ||
    null
  )
}

export function getContainingBlockRect(
  el?: HTMLElement | null
): { left: number; top: number; width: number; height: number } {
  const view = getViewportBounds()

  if (typeof window === 'undefined') {
    return { left: 0, top: 0, width: view.right, height: view.bottom }
  }

  const container = findContainingBlockElement(el)
  if (container) {
    const rect = container.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      }
    }
  }

  return { left: 0, top: 0, width: view.right, height: view.bottom }
}

interface DragFrame {
  /** Canto superior esquerdo do card na tela no momento do pointerdown */
  startLeft: number
  startTop: number
  /** Tamanho real do card na tela (já com escala aplicada) */
  clientWidth: number
  clientHeight: number
  /** Área visível útil, em coordenadas de tela */
  boundsLeft: number
  boundsTop: number
  boundsRight: number
  boundsBottom: number
  /** Origem do sistema de coordenadas de left/top, em coordenadas de tela */
  originLeft: number
  originTop: number
  scaleX: number
  scaleY: number
}

/** Converte o deslocamento do ponteiro em posição local (left/top) já presa na área útil. */
export function resolveDragPosition(
  frame: DragFrame,
  dx: number,
  dy: number
): { x: number; y: number } {
  const maxLeft = Math.max(frame.boundsLeft, frame.boundsRight - frame.clientWidth)
  const maxTop = Math.max(frame.boundsTop, frame.boundsBottom - frame.clientHeight)
  const left = Math.min(Math.max(frame.startLeft + dx, frame.boundsLeft), maxLeft)
  const top = Math.min(Math.max(frame.startTop + dy, frame.boundsTop), maxTop)
  return {
    x: Math.round((left - frame.originLeft) / (frame.scaleX || 1)),
    y: Math.round((top - frame.originTop) / (frame.scaleY || 1))
  }
}

export const PtzControlCard: React.FC<PtzControlCardProps> = ({
  cameraId,
  cameraName,
  initialPosition,
  compact = false,
  onClose,
  t,
  sendCommand
}) => {
  const [activeDirection, setActiveDirection] = useState<PtzDirection | null>(null)
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stepStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isHoldingRef = useRef(false)
  const cardRef = useRef<HTMLDivElement>(null)

  // Modo compacto responsivo para modo janela / telas menores
  const isCompact = compact || Boolean(initialPosition?.compact)
  const cardWidth = isCompact ? PTZ_CARD_DIMENSIONS.compact.width : PTZ_CARD_DIMENSIONS.default.width
  const cardHeight = isCompact ? PTZ_CARD_DIMENSIONS.compact.height : PTZ_CARD_DIMENSIONS.default.height
  const hasUserDraggedRef = useRef(false)
  const [position, setPosition] = useState<{ x: number; y: number }>(() => {
    if (initialPosition) return initialPosition
    if (typeof window === 'undefined') return { x: 100, y: 100 }
    const containerRect = getContainingBlockRect(null)
    const x = Math.max(16, (containerRect.width - cardWidth) / 2)
    const y = Math.max(16, (containerRect.height - cardHeight) / 2)
    return { x, y }
  })

  // Sincroniza a posição quando uma nova posição inicial for repassada (ex: resize de janela, modo janela/maximizado, tela cheia)
  const lastInitialRef = useRef<{ x: number; y: number; compact?: boolean } | null>(null)
  useEffect(() => {
    if (!initialPosition) return

    // Ignora reprops com os mesmos valores (o pai recria o objeto a cada render)
    const last = lastInitialRef.current
    const changed =
      !last ||
      last.x !== initialPosition.x ||
      last.y !== initialPosition.y ||
      Boolean(last.compact) !== Boolean(initialPosition.compact)
    if (!changed) return
    lastInitialRef.current = {
      x: initialPosition.x,
      y: initialPosition.y,
      compact: initialPosition.compact
    }

    if (!hasUserDraggedRef.current) {
      setPosition({ x: initialPosition.x, y: initialPosition.y })
      return
    }

    // Se o usuário arrastou manualmente, garante que o card continue visível na área útil
    const containerRect = getContainingBlockRect(cardRef.current)
    const width = containerRect.width || (typeof window !== 'undefined' ? window.innerWidth : 1200)
    const height = containerRect.height || (typeof window !== 'undefined' ? window.innerHeight : 800)
    const maxX = Math.max(0, width - cardWidth)
    const maxY = Math.max(0, height - cardHeight)
    setPosition((prev) => ({
      x: Math.min(Math.max(0, prev.x), maxX),
      y: Math.min(Math.max(0, prev.y), maxY)
    }))
  }, [initialPosition, cardWidth, cardHeight])

  const isDraggingRef = useRef(false)
  const [isDragging, setIsDragging] = useState(false)
  const dragFrameRef = useRef<DragFrame | null>(null)
  const dragStartRef = useRef<{ pointerX: number; pointerY: number }>({ pointerX: 0, pointerY: 0 })
  const dragCleanupRef = useRef<(() => void) | null>(null)

  // Mede o card de verdade (posição, escala, área visível) no início do arrasto.
  // Trabalhar em coordenadas de tela evita o salto quando o card é re-renderizado:
  // a posição local só é recalculada a partir do deslocamento real do ponteiro.
  const buildDragFrame = useCallback(
    (card: HTMLElement, current: { x: number; y: number }): DragFrame => {
      const rect = card.getBoundingClientRect()
      const offsetWidth = card.offsetWidth || cardWidth
      const offsetHeight = card.offsetHeight || cardHeight
      const scaleX = rect.width > 0 && offsetWidth > 0 ? rect.width / offsetWidth : 1
      const scaleY = rect.height > 0 && offsetHeight > 0 ? rect.height / offsetHeight : 1

      // Origem do sistema de coordenadas usado em `left`/`top` (canto do bloco de contenção)
      const originLeft = rect.left - current.x * scaleX
      const originTop = rect.top - current.y * scaleY

      const view = getViewportBounds()
      let boundsLeft = view.left
      let boundsTop = view.top
      let boundsRight = view.right
      let boundsBottom = view.bottom

      // Recorta para o container da extensão apenas quando ele realmente for o
      // bloco de contenção (origem medida coincidindo com o canto dele)
      const container = findContainingBlockElement(card)
      if (container) {
        const cRect = container.getBoundingClientRect()
        const isAncestor = container.contains(card)
        const matchesOrigin =
          isAncestor || (Math.abs(cRect.left - originLeft) <= 2 && Math.abs(cRect.top - originTop) <= 2)
        if (matchesOrigin && cRect.width > 0 && cRect.height > 0) {
          boundsLeft = Math.max(boundsLeft, cRect.left)
          boundsTop = Math.max(boundsTop, cRect.top)
          boundsRight = Math.min(boundsRight, cRect.right)
          boundsBottom = Math.min(boundsBottom, cRect.bottom)
        }
      }

      return {
        startLeft: rect.left,
        startTop: rect.top,
        clientWidth: rect.width || offsetWidth,
        clientHeight: rect.height || offsetHeight,
        boundsLeft,
        boundsTop,
        boundsRight,
        boundsBottom,
        originLeft,
        originTop,
        scaleX: scaleX || 1,
        scaleY: scaleY || 1
      }
    },
    [cardWidth, cardHeight]
  )

  const endDrag = useCallback(() => {
    isDraggingRef.current = false
    dragFrameRef.current = null
    setIsDragging(false)
    if (dragCleanupRef.current) {
      dragCleanupRef.current()
      dragCleanupRef.current = null
    }
  }, [])

  // Arrastar pelo card inteiro; o D-pad (círculo com as bolinhas) fica de fora
  const handleCardPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const target = e.target as HTMLElement | null
    if (target?.closest('[data-ptz-nodrag="true"]')) return

    e.preventDefault()
    if (dragCleanupRef.current) {
      dragCleanupRef.current()
      dragCleanupRef.current = null
    }

    const card = e.currentTarget
    const frame = buildDragFrame(card, position)
    dragFrameRef.current = frame

    isDraggingRef.current = true
    setIsDragging(true)
    dragStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY
    }

    try {
      card.setPointerCapture?.(e.pointerId)
    } catch {}

    const onPointerMove = (moveEv: PointerEvent) => {
      if (!isDraggingRef.current || !dragFrameRef.current) return
      const dx = moveEv.clientX - dragStartRef.current.pointerX
      const dy = moveEv.clientY - dragStartRef.current.pointerY
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        hasUserDraggedRef.current = true
      }
      setPosition(resolveDragPosition(dragFrameRef.current, dx, dy))
    }

    const onPointerUp = (upEv: PointerEvent) => {
      try {
        if (card.hasPointerCapture?.(upEv.pointerId)) card.releasePointerCapture(upEv.pointerId)
      } catch {}
      endDrag()
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)

    dragCleanupRef.current = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }

  // Preaquece o canal ONVIF PTZ no instante em que o card for aberto
  useEffect(() => {
    void sendCommand('control_ptz', { cameraId, action: 'warmup' }).catch(() => {})
  }, [cameraId, sendCommand])

  const pressStartRef = useRef<number>(0)
  const isContinuousRef = useRef<boolean>(false)

  const clearAllTimers = useCallback(() => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current)
      repeatIntervalRef.current = null
    }
    if (stepStopTimerRef.current) {
      clearTimeout(stepStopTimerRef.current)
      stepStopTimerRef.current = null
    }
    if (flashTimerRef.current) {
      clearTimeout(flashTimerRef.current)
      flashTimerRef.current = null
    }
  }, [])

  // Ao pressionar: envia o comando de mover IMEDIATAMENTE (0ms de latência) com velocidade máxima (1.0)
  const handlePointerDown = useCallback(
    (direction: PtzDirection, event?: React.PointerEvent) => {
      if (event?.currentTarget && 'setPointerCapture' in event.currentTarget) {
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {}
      }

      clearAllTimers()

      pressStartRef.current = Date.now()
      isHoldingRef.current = true
      isContinuousRef.current = false
      setActiveDirection(direction)

      const speed = 1.0

      // Dispara imediatamente no pointerDown com velocidade máxima
      void sendCommand('control_ptz', {
        cameraId,
        action: 'move',
        direction,
        speed
      })

      // Se o usuário continuar segurando por >250ms, transiciona para movimento contínuo
      // com loop de renovação periódica (keep-alive) a cada 350ms, mantendo o watchdog da câmera alimentado
      holdTimerRef.current = setTimeout(() => {
        if (isHoldingRef.current) {
          isContinuousRef.current = true
          void sendCommand('control_ptz', {
            cameraId,
            action: 'move',
            direction,
            speed
          })

          repeatIntervalRef.current = setInterval(() => {
            if (isHoldingRef.current) {
              void sendCommand('control_ptz', {
                cameraId,
                action: 'move',
                direction,
                speed
              })
            }
          }, 350)
        }
      }, 250)
    },
    [cameraId, sendCommand, clearAllTimers]
  )

  // Ao soltar: se estava segurando (>250ms), envia stop imediatamente. Se foi clique rápido, completa o passo firme (~450ms)
  const handlePointerUp = useCallback(
    (direction: PtzDirection, event?: React.PointerEvent) => {
      if (event?.currentTarget && 'releasePointerCapture' in event.currentTarget) {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch {}
      }

      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current)
        holdTimerRef.current = null
      }
      if (repeatIntervalRef.current) {
        clearInterval(repeatIntervalRef.current)
        repeatIntervalRef.current = null
      }

      const wasContinuous = isContinuousRef.current
      const elapsed = Date.now() - (pressStartRef.current || 0)
      isHoldingRef.current = false
      isContinuousRef.current = false

      if (wasContinuous || elapsed >= 250) {
        setActiveDirection(null)
        void sendCommand('control_ptz', {
          cameraId,
          action: 'stop'
        })
      } else {
        // Clique rápido (Tap / Step): para garantir um passo consistente e visível (~15 a 20 graus),
        // aguarda o tempo de passo mínimo de 450ms antes de enviar o stop
        const remaining = Math.max(50, 450 - elapsed)
        stepStopTimerRef.current = setTimeout(() => {
          void sendCommand('control_ptz', {
            cameraId,
            action: 'stop'
          })
          setActiveDirection((prev) => (prev === direction ? null : prev))
        }, remaining)
      }
    },
    [cameraId, sendCommand]
  )

  const handlePointerCancel = useCallback(
    (event?: React.PointerEvent) => {
      if (event?.currentTarget && 'releasePointerCapture' in event.currentTarget) {
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch {}
      }
      clearAllTimers()
      const shouldStop = isHoldingRef.current || isContinuousRef.current
      isHoldingRef.current = false
      isContinuousRef.current = false
      setActiveDirection(null)
      if (shouldStop) {
        void sendCommand('control_ptz', {
          cameraId,
          action: 'stop'
        })
      }
    },
    [cameraId, sendCommand, clearAllTimers]
  )

  // Para o movimento caso o componente seja desmontado
  useEffect(() => {
    return () => {
      clearAllTimers()
      if (isHoldingRef.current || isContinuousRef.current) {
        isHoldingRef.current = false
        isContinuousRef.current = false
        void sendCommand('control_ptz', { cameraId, action: 'stop' })
      }
      if (dragCleanupRef.current) {
        dragCleanupRef.current()
        dragCleanupRef.current = null
      }
    }
  }, [cameraId, sendCommand, clearAllTimers])

  return (
    <div
      ref={cardRef}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        zIndex: 9999,
        touchAction: 'none'
      }}
      className={`absolute pointer-events-auto flex flex-col items-center justify-between ${
        isCompact ? 'p-2 w-36 rounded-xl' : 'p-3 w-48 rounded-2xl'
      } bg-card border border-border shadow-2xl select-none text-text ${
        isDragging ? 'cursor-grabbing' : 'cursor-grab'
      }`}
      onPointerDown={handleCardPointerDown}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header com Nome da Câmera à esquerda e Botão Fechar à direita na parte superior */}
      <div
        className={`w-full flex items-center justify-between gap-1.5 ${
          isCompact ? 'pb-1' : 'pb-1.5'
        } border-b border-border/40`}
      >
        <div className="flex items-center justify-start gap-1.5 min-w-0 flex-1 pl-0.5" data-ptz-title="true">
          <svg className={`${isCompact ? 'w-3 h-3' : 'w-3.5 h-3.5'} text-text-muted/70 shrink-0`} viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="8" r="1.5" />
            <circle cx="15" cy="8" r="1.5" />
            <circle cx="9" cy="12" r="1.5" />
            <circle cx="15" cy="12" r="1.5" />
            <circle cx="9" cy="16" r="1.5" />
            <circle cx="15" cy="16" r="1.5" />
          </svg>
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
          <span className={`font-semibold text-text truncate ${isCompact ? 'text-[11px] max-w-[95px]' : 'text-xs max-w-[130px]'}`} title={cameraName}>
            {cameraName}
          </span>
        </div>

        <button
          data-ptz-nodrag="true"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className={`${
            isCompact ? 'w-6 h-6' : 'w-7 h-7'
          } shrink-0 ml-auto rounded-md bg-input/80 hover:bg-input hover:text-text border border-border/50 text-text-muted transition-all flex items-center justify-center active:scale-95 cursor-pointer`}
          title={t('cameras.ptzClose')}
          aria-label={t('cameras.ptzClose')}
        >
          <svg className={`${isCompact ? 'w-3.5 h-3.5' : 'w-4 h-4'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* D-Pad Circular Central (área excluída do arrasto) */}
      <div
        data-ptz-nodrag="true"
        className={`relative ${isCompact ? 'w-28 h-28 my-1' : 'w-36 h-36 my-2'} flex items-center justify-center shrink-0 cursor-default`}
      >
        {/* Disco Externo Neutro */}
        <div className="absolute inset-0 rounded-full bg-input/70 border border-border/60 shadow-inner flex items-center justify-center pointer-events-none">
          {/* Orifício / Círculo Central Vazio */}
          <div className={`${isCompact ? 'w-10 h-10' : 'w-14 h-14'} rounded-full bg-card border border-border/50 shadow-sm flex items-center justify-center`}>
            <div className={`${isCompact ? 'w-2.5 h-2.5' : 'w-3 h-3'} rounded-full border-2 border-border/40 opacity-50`} />
          </div>
        </div>

        {/* Botão Superior (Cima / Tilt Up) */}
        <button
          type="button"
          onPointerDown={(e) => handlePointerDown('up', e)}
          onPointerUp={(e) => handlePointerUp('up', e)}
          onPointerCancel={handlePointerCancel}
          style={{ top: isCompact ? 6 : 10, left: '50%', transform: 'translateX(-50%)' }}
          className={`absolute ${isCompact ? 'w-8 h-8' : 'w-10 h-10'} rounded-full flex items-center justify-center cursor-pointer group z-10 transition-transform duration-150 active:scale-90`}
          title="Cima"
          aria-label="Cima"
        >
          <span
            className={`${isCompact ? 'w-2.5 h-2.5' : 'w-3 h-3'} rounded-full transition-all duration-300 ease-out shadow-sm ${
              activeDirection === 'up'
                ? 'bg-text scale-125 ring-2 ring-border shadow-md'
                : 'bg-text-muted/40 group-hover:bg-text-muted/80 group-hover:scale-135 group-hover:ring-4 group-hover:ring-border/40 group-hover:shadow-md'
            }`}
          />
        </button>

        {/* Botão Inferior (Baixo / Tilt Down) */}
        <button
          type="button"
          onPointerDown={(e) => handlePointerDown('down', e)}
          onPointerUp={(e) => handlePointerUp('down', e)}
          onPointerCancel={handlePointerCancel}
          style={{ bottom: isCompact ? 6 : 10, left: '50%', transform: 'translateX(-50%)' }}
          className={`absolute ${isCompact ? 'w-8 h-8' : 'w-10 h-10'} rounded-full flex items-center justify-center cursor-pointer group z-10 transition-transform duration-150 active:scale-90`}
          title="Baixo"
          aria-label="Baixo"
        >
          <span
            className={`${isCompact ? 'w-2.5 h-2.5' : 'w-3 h-3'} rounded-full transition-all duration-300 ease-out shadow-sm ${
              activeDirection === 'down'
                ? 'bg-text scale-125 ring-2 ring-border shadow-md'
                : 'bg-text-muted/40 group-hover:bg-text-muted/80 group-hover:scale-135 group-hover:ring-4 group-hover:ring-border/40 group-hover:shadow-md'
            }`}
          />
        </button>

        {/* Botão Esquerdo (Esquerda / Pan Left) */}
        <button
          type="button"
          onPointerDown={(e) => handlePointerDown('left', e)}
          onPointerUp={(e) => handlePointerUp('left', e)}
          onPointerCancel={handlePointerCancel}
          style={{ left: isCompact ? 6 : 10, top: '50%', transform: 'translateY(-50%)' }}
          className={`absolute ${isCompact ? 'w-8 h-8' : 'w-10 h-10'} rounded-full flex items-center justify-center cursor-pointer group z-10 transition-transform duration-150 active:scale-90`}
          title="Esquerda"
          aria-label="Esquerda"
        >
          <span
            className={`${isCompact ? 'w-2.5 h-2.5' : 'w-3 h-3'} rounded-full transition-all duration-300 ease-out shadow-sm ${
              activeDirection === 'left'
                ? 'bg-text scale-125 ring-2 ring-border shadow-md'
                : 'bg-text-muted/40 group-hover:bg-text-muted/80 group-hover:scale-135 group-hover:ring-4 group-hover:ring-border/40 group-hover:shadow-md'
            }`}
          />
        </button>

        {/* Botão Direito (Direita / Pan Right) */}
        <button
          type="button"
          onPointerDown={(e) => handlePointerDown('right', e)}
          onPointerUp={(e) => handlePointerUp('right', e)}
          onPointerCancel={handlePointerCancel}
          style={{ right: isCompact ? 6 : 10, top: '50%', transform: 'translateY(-50%)' }}
          className={`absolute ${isCompact ? 'w-8 h-8' : 'w-10 h-10'} rounded-full flex items-center justify-center cursor-pointer group z-10 transition-transform duration-150 active:scale-90`}
          title="Direita"
          aria-label="Direita"
        >
          <span
            className={`${isCompact ? 'w-2.5 h-2.5' : 'w-3 h-3'} rounded-full transition-all duration-300 ease-out shadow-sm ${
              activeDirection === 'right'
                ? 'bg-text scale-125 ring-2 ring-border shadow-md'
                : 'bg-text-muted/40 group-hover:bg-text-muted/80 group-hover:scale-135 group-hover:ring-4 group-hover:ring-border/40 group-hover:shadow-md'
            }`}
          />
        </button>
      </div>
    </div>
  )
}

export default PtzControlCard
