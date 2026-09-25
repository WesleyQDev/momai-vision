import type { JSX } from 'react'
import { getSDK } from 'momai:sdk'
import { useEffect } from 'react'
import { useI18n } from '../hooks/useI18n'
import type { WidgetProps } from './types'
import { useLiveWidget } from './hooks/useLiveWidget'
import { WidgetLoading, WidgetState } from './components/WidgetState'

export interface LiveConfig {
  cameraId?: string
}

export default function VisionLiveWidget({ config, isEditing = false }: WidgetProps<LiveConfig>): JSX.Element {
  const { t } = useI18n()
  const cameraId = config?.cameraId ?? ''
  const { status, error, cameraName, canvasRef, retry } = useLiveWidget(cameraId, isEditing)

  useEffect(() => {
    try {
      void getSDK()
    } catch {}
  }, [])

  if (!cameraId) {
    return <WidgetState title={t('widget.live.title')} message={t('widget.live.needsSetup')} />
  }

  if (isEditing) {
    return <WidgetState title={t('widget.live.title')} message={t('widget.live.empty')} />
  }

  return (
    <div className="w-full h-full flex flex-col min-h-0 overflow-hidden relative bg-black">
      <canvas ref={canvasRef} className="w-full flex-1 min-h-0 object-cover" />
      {(status === 'connecting' || status === 'idle') && (
        <div className="absolute inset-0 flex items-center justify-center bg-card/80">
          <WidgetLoading message={t('widget.live.loading')} />
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-card/90 p-4 text-center">
          <WidgetState title={t('widget.live.title')} message={error} />
          <button
            type="button"
            onClick={retry}
            className="text-[11px] font-semibold text-accent hover:underline"
          >
            {t('widget.live.retry')}
          </button>
        </div>
      )}
      <div className="flex items-center justify-between px-2.5 py-1.5 border-t border-border/20 bg-card/80 shrink-0">
        <span className="text-[11px] font-semibold text-text truncate">{cameraName || t('widget.live.title')}</span>
        {(status === 'live' || status === 'polling') && (
          <span className="flex items-center gap-1.5 text-[10px] font-bold text-error shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-error animate-pulse" />
            {t('widget.live.liveBadge')}
          </span>
        )}
      </div>
    </div>
  )
}
