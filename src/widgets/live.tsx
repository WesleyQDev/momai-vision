import type { JSX } from 'react'
import { getSDK } from 'momai:sdk'
import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from '../hooks/useI18n'
import type { WidgetProps } from './types'
import { useLiveWidget } from './hooks/useLiveWidget'
import { WidgetLoading, WidgetState } from './components/WidgetState'
import { sendWidgetCommand } from './services/widgetStream'
import { PtzControlCard, PTZ_CARD_DIMENSIONS } from '../components/PtzControlCard'

export interface LiveConfig {
  cameraId?: string
}

function NoActiveCameraState({
  title,
  t,
  onActivate
}: {
  title: string
  t: (key: string) => string
  onActivate: () => void
}): JSX.Element {
  return (
    <div className="w-full h-full flex flex-col justify-between overflow-hidden bg-card select-none">
      <div className="flex-1 flex flex-col items-center justify-center p-3 text-center gap-1.5 min-h-0">
        <div className="w-8 h-8 rounded-full bg-input border border-border/40 text-text-muted flex items-center justify-center shrink-0">
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        </div>
        <div className="flex flex-col gap-0.5 max-w-[260px]">
          <span className="text-xs font-semibold text-text">{t('widget.live.noActiveCamera')}</span>
          <span className="text-[11px] text-text-muted leading-tight">{t('widget.live.askActivate')}</span>
        </div>
        <button
          type="button"
          onClick={onActivate}
          className="mt-1 px-3.5 py-1.5 rounded-lg bg-text text-bg hover:opacity-90 text-xs font-semibold transition-all shadow-sm flex items-center gap-1.5 cursor-pointer active:scale-95 shrink-0"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span>{t('widget.live.activateAction')}</span>
        </button>
      </div>
      <div className="flex items-center justify-between px-2.5 py-1.5 border-t border-border/20 bg-card shrink-0">
        <span className="text-[11px] font-semibold text-text-muted truncate">{title}</span>
      </div>
    </div>
  )
}

export default function VisionLiveWidget({ config, isEditing = false }: WidgetProps<LiveConfig>): JSX.Element {
  const { t } = useI18n()
  const configuredCameraId = config?.cameraId ?? ''
  const { status, error, activeCameraId, cameraName, canvasRef, retry, isNoActiveCamera } = useLiveWidget(
    configuredCameraId,
    isEditing
  )
  const cameraId = activeCameraId || configuredCameraId
  const rootRef = useRef<HTMLDivElement>(null)
  const [showPtz, setShowPtz] = useState(false)
  const [ptzInitialPosition, setPtzInitialPosition] = useState<{ x: number; y: number; compact: boolean } | null>(null)
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null)

  const findPtzPortalTarget = (widgetRoot: HTMLElement | null): HTMLElement | null => {
    if (typeof document === 'undefined') return null
    // Prefer the host-provided overlay root (main content area of the chat tab)
    // so the PTZ panel can move across the whole chat page.
    try {
      const sdk = getSDK()
      const overlayRoot = sdk?.ui?.overlayRoot?.()
      if (overlayRoot) return overlayRoot
    } catch {}
    let el = widgetRoot?.parentElement ?? null
    while (el) {
      if (el.classList?.contains('ext-momai-vision')) return el
      el = el.parentElement
    }
    return document.body
  }
  const isPtzCamera = cameraId !== '' && !cameraId.startsWith('webcam:')

  useEffect(() => {
    try {
      void getSDK()
    } catch {}
  }, [])

  const closePtz = useCallback(() => {
    setShowPtz(false)
    setPtzInitialPosition(null)
    setPortalTarget(null)
  }, [])

  useEffect(() => {
    if (isEditing && showPtz) {
      closePtz()
    }
  }, [isEditing, showPtz, closePtz])

  // Close the PTZ overlay when leaving the chat tab, switching widget tabs, or hiding
  useEffect(() => {
    if (!showPtz) return

    const isWidgetVisible = (): boolean => {
      const el = rootRef.current
      if (!el || typeof document === 'undefined') return false
      if (!el.isConnected || !document.contains(el)) return false
      if (el.closest('[aria-hidden="true"]') || el.closest('[inert]') || el.closest('.hidden')) return false
      try {
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') return false
      } catch {}
      try {
        const rect = el.getBoundingClientRect()
        // If banished offscreen by the host's background tab positioning (-top-[99999px])
        if (rect && rect.top < -1000) return false
      } catch {}
      return true
    }

    const checkVisibility = () => {
      if (!isWidgetVisible()) {
        closePtz()
      }
    }

    const interval = window.setInterval(checkVisibility, 150)

    window.addEventListener('momai_navigate', closePtz)
    window.addEventListener('popstate', closePtz)
    window.addEventListener('hashchange', closePtz)

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        closePtz()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    let observer: MutationObserver | null = null
    try {
      if (typeof MutationObserver !== 'undefined' && rootRef.current) {
        let parent: HTMLElement | null = rootRef.current.parentElement
        while (parent && parent !== document.body) {
          if (parent.hasAttribute('inert') || parent.hasAttribute('aria-hidden') || parent.classList.contains('hidden')) {
            break
          }
          parent = parent.parentElement
        }
        const targetToWatch = parent || rootRef.current.parentElement || rootRef.current
        observer = new MutationObserver(() => {
          checkVisibility()
        })
        observer.observe(targetToWatch, {
          attributes: true,
          attributeFilter: ['class', 'style', 'aria-hidden', 'inert']
        })
      }
    } catch {}

    return () => {
      window.clearInterval(interval)
      window.removeEventListener('momai_navigate', closePtz)
      window.removeEventListener('popstate', closePtz)
      window.removeEventListener('hashchange', closePtz)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      observer?.disconnect()
    }
  }, [showPtz, closePtz])

  const handleOpenAddCamera = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    const targetId = cameraId || ''
    const initialTab =
      targetId && (targetId.startsWith('ip:') || targetId.includes('rtsp') || targetId.includes('http'))
        ? 'ip'
        : 'webcam'
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('momai-vision:auto-add-camera', initialTab)
      }
    } catch {}
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('momai_navigate', {
          detail: {
            path: '/extensions/momai-vision',
            state: { openAddCamera: true, initialTab }
          }
        })
      )
      window.dispatchEvent(
        new CustomEvent('momai-vision:open-add-camera', {
          detail: { initialTab }
        })
      )
    }
  }

  if (isEditing) {
    return <WidgetState title={t('widget.live.title')} message={t('widget.live.empty')} />
  }

  if (isNoActiveCamera) {
    return (
      <NoActiveCameraState
        title={cameraName || t('widget.live.title')}
        t={t}
        onActivate={handleOpenAddCamera}
      />
    )
  }

  const handleTogglePtz = (e?: React.MouseEvent) => {
    e?.stopPropagation()
    if (showPtz) {
      closePtz()
      return
    }
    const rect = rootRef.current?.getBoundingClientRect() ?? null
    const target = findPtzPortalTarget(rootRef.current)
    setPortalTarget(target)
    const containerRect = target?.getBoundingClientRect() ?? rect
    const compact = !rect || rect.width < 550 || rect.height < 320
    const dims = compact ? PTZ_CARD_DIMENSIONS.compact : PTZ_CARD_DIMENSIONS.default
    let x = 8
    let y = 8
    if (rect && containerRect) {
      x = Math.max(8, rect.left - containerRect.left + (rect.width - dims.width) / 2)
      y = Math.max(8, rect.top - containerRect.top + (rect.height - dims.height) / 2)
      x = Math.min(x, Math.max(8, containerRect.width - dims.width - 8))
      y = Math.min(y, Math.max(8, containerRect.height - dims.height - 8))
    }
    setPtzInitialPosition({ x, y, compact })
    setShowPtz(true)
  }

  const handleOpenExpanded = (e?: React.MouseEvent) => {
    if (isEditing) return
    e?.stopPropagation()
    if (isNoActiveCamera) {
      handleOpenAddCamera(e)
      return
    }
    const targetId = cameraId || 'first'
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('momai-vision:auto-expand', targetId)
      }
    } catch {}
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('momai_navigate', {
          detail: {
            path: '/extensions/momai-vision',
            state: { expandCameraId: targetId }
          }
        })
      )
      window.dispatchEvent(
        new CustomEvent('momai-vision:expand-camera', {
          detail: { cameraId: targetId }
        })
      )
    }
  }

  return (
    <div
      ref={rootRef}
      onDoubleClick={handleOpenExpanded}
      title={t('widget.live.doubleClickToExpand')}
      className="w-full h-full flex flex-col min-h-0 overflow-hidden relative bg-black cursor-pointer group"
      style={{ transform: 'translateZ(0)' }}
    >
      <canvas
        ref={canvasRef}
        onDoubleClick={handleOpenExpanded}
        className="w-full flex-1 min-h-0 object-cover cursor-pointer"
      />
      {(status === 'connecting' || status === 'idle') && (
        <div className="absolute inset-0 flex items-center justify-center bg-card/80">
          <WidgetLoading message={t('widget.live.loading')} />
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-card/95">
          {isNoActiveCamera ? (
            <NoActiveCameraState
              title={cameraName || t('widget.live.title')}
              t={t}
              onActivate={handleOpenAddCamera}
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 p-4 text-center">
              <WidgetState title={t('widget.live.title')} message={error} />
              <button
                type="button"
                onClick={retry}
                className="text-[11px] font-semibold text-text-muted hover:text-text hover:underline"
              >
                {t('widget.live.retry')}
              </button>
            </div>
          )}
        </div>
      )}
      <div
        className="flex items-center justify-between px-2.5 py-1.5 border-t border-border/20 bg-card/80 shrink-0 select-none"
      >
        <span className="text-[11px] font-semibold text-text truncate">{cameraName || t('widget.live.title')}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          {isPtzCamera && (
            <button
              type="button"
              onClick={handleTogglePtz}
              onDoubleClick={(e) => e.stopPropagation()}
              title={t('cameras.ptzControl')}
              className="flex items-center justify-center w-5 h-5 rounded-md text-text-muted hover:text-accent hover:bg-accent/10 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <circle cx="12" cy="12" r="9.5" strokeWidth="1.6" />
                <circle cx="12" cy="12" r="3.2" strokeWidth="1.2" opacity="0.6" />
                <circle cx="12" cy="6.2" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="12" cy="17.8" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="6.2" cy="12" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="17.8" cy="12" r="1.4" fill="currentColor" stroke="none" />
              </svg>
            </button>
          )}
          {(status === 'live' || status === 'polling') && (
            <span className="flex items-center gap-1.5 text-[10px] font-bold text-error shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-error animate-pulse" />
              {t('widget.live.liveBadge')}
            </span>
          )}
        </div>
      </div>
      {showPtz && ptzInitialPosition && (portalTarget ?? (typeof document !== 'undefined' ? document.body : null)) && createPortal(
        <PtzControlCard
          cameraName={cameraName || t('widget.live.title')}
          cameraId={cameraId}
          initialPosition={ptzInitialPosition}
          onClose={closePtz}
          t={t}
          sendCommand={sendWidgetCommand}
        />,
        (portalTarget ?? (typeof document !== 'undefined' ? document.body : null)) as HTMLElement
      )}
    </div>
  )
}
