import { useEffect, type JSX } from 'react'
import { getSDK } from 'momai:sdk'
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
  const { loading, error, image, cameraName, refresh } = useLiveWidget(cameraId, isEditing)

  useEffect(() => {
    try {
      void getSDK()
    } catch {}
  }, [])

  if (!cameraId) {
    return <WidgetState title={t('widget.live.title')} message={t('widget.live.needsSetup')} />
  }

  if (loading) return <WidgetLoading message={t('widget.live.loading')} />
  if (error) return <WidgetState title={t('widget.live.title')} message={error} />

  return (
    <div className="w-full h-full flex flex-col min-h-0 overflow-hidden">
      {image ? (
        <img src={image} alt={cameraName || 'Live camera'} className="w-full h-full object-cover" />
      ) : (
        <WidgetState title={t('widget.live.title')} message={t('widget.live.empty')} />
      )}
      <div className="flex items-center justify-between px-2.5 py-1.5 border-t border-border/20 bg-card/80 shrink-0">
        <span className="text-[11px] font-semibold text-text truncate">{cameraName || t('widget.live.title')}</span>
        <button type="button" onClick={() => void refresh()} className="text-[11px] font-semibold text-accent hover:underline">
          {t('widget.live.refresh')}
        </button>
      </div>
    </div>
  )
}
