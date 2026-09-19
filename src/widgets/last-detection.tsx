import type { JSX } from 'react'
import { useI18n } from '../hooks/useI18n'
import type { WidgetProps } from './types'
import { useLastDetectionWidget } from './hooks/useLastDetectionWidget'
import { WidgetLoading, WidgetState } from './components/WidgetState'

export default function VisionLastDetectionWidget({ isEditing = false }: WidgetProps): JSX.Element {
  const { t } = useI18n()
  const { loading, error, detection } = useLastDetectionWidget(isEditing)

  if (loading) return <WidgetLoading message={t('widget.lastDetection.loading')} />
  if (error) return <WidgetState title={t('widget.lastDetection.title')} message={error} />
  if (!detection) return <WidgetState title={t('widget.lastDetection.title')} message={t('widget.lastDetection.empty')} />

  return (
    <div className="w-full h-full flex flex-col min-h-0 overflow-hidden">
      {detection.image ? (
        <img src={detection.image} alt="Last detection" className="w-full flex-1 min-h-0 object-cover" />
      ) : null}
      <div className="p-2.5 border-t border-border/20 bg-card/80 shrink-0">
        <div className="text-[11px] font-bold text-text truncate">{detection.cameraName}</div>
        <div className="text-[11px] text-text-muted truncate">
          {detection.className}
          {detection.triggeredBy ? ` · ${detection.triggeredBy}` : ''}
        </div>
      </div>
    </div>
  )
}
