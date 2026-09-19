import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { getSDK } from 'momai:sdk'
import { useI18n } from '../hooks/useI18n'
import { useWindowMaximized } from '../hooks/useWindowMaximized'
import {
  PREVIEW_WIDTH_DEFAULT,
  PREVIEW_WIDTH_OPTIONS,
  RTSP_CODEC_DEFAULT,
  resolvePreviewWidth,
  resolveRtspCodec,
  type RtspCodec
} from '../vision/rtsp'
import visionIconPng from '../../icon.png'

const sdk = getSDK()

export interface EditingCameraTarget {
  id: string
  name: string
  source: 'webcam' | 'ip'
  url: string
  transport: 'tcp' | 'udp'
  previewWidth: number
  codec?: RtspCodec
}

interface EditCameraModalProps {
  target: EditingCameraTarget | null
  onClose: () => void
  onSave: (
    oldId: string,
    payload: { name: string; url: string; transport: 'tcp' | 'udp'; previewWidth: number; codec: RtspCodec }
  ) => Promise<void>
  /** Called after "Limpar Cache e Conexões" succeeds so the parent can leave the modal and watch the reconnect. */
  onCacheCleared?: (cameraId: string) => void
}

function isValidCameraUrl(url: string): boolean {
  const value = url.trim()
  if (!value) return false
  return /^(https?:\/\/|rtsp:\/\/).+/i.test(value)
}

export default function EditCameraModal({ target, onClose, onSave, onCacheCleared }: EditCameraModalProps): JSX.Element | null {
  const { t } = useI18n()
  const isMaximized = useWindowMaximized()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [transport, setTransport] = useState<'tcp' | 'udp'>('udp')
  const [previewWidth, setPreviewWidth] = useState<number>(PREVIEW_WIDTH_DEFAULT)
  const [codec, setCodec] = useState<RtspCodec>(RTSP_CODEC_DEFAULT)
  const [modalError, setModalError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [clearingCache, setClearingCache] = useState(false)
  const [clearCacheSuccess, setClearCacheSuccess] = useState(false)

  useEffect(() => {
    if (!target) return
    setName(target.name || '')
    setUrl(target.url || '')
    setTransport(target.transport === 'tcp' ? 'tcp' : 'udp')
    setPreviewWidth(resolvePreviewWidth(target.previewWidth))
    setCodec(resolveRtspCodec(target.codec))
    setModalError(null)
    setSubmitting(false)
  }, [target])

  useEffect(() => {
    if (!target) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [target, onClose])

  if (!target) return null

  const isIp = target.source === 'ip'
  const trimmedName = name.trim()
  const trimmedUrl = url.trim()
  const urlChanged = isIp && trimmedUrl !== target.url
  const canSave = isIp
    ? trimmedName !== '' &&
      (urlChanged ||
        transport !== target.transport ||
        previewWidth !== resolvePreviewWidth(target.previewWidth) ||
        codec !== resolveRtspCodec(target.codec) ||
        trimmedName !== target.name) &&
      isValidCameraUrl(trimmedUrl) &&
      !submitting
    : trimmedName !== '' && trimmedName !== target.name && !submitting

  const handleSubmit = async () => {
    if (!canSave || !target) return
    setSubmitting(true)
    setModalError(null)
    try {
      await onSave(target.id, {
        name: trimmedName,
        url: trimmedUrl || target.url,
        transport: isIp ? transport : 'tcp',
        previewWidth,
        codec
      })
      onClose()
    } catch (err) {
      setModalError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleClearCache = async () => {
    if (clearingCache || !target) return
    setClearingCache(true)
    setClearCacheSuccess(false)
    setModalError(null)
    try {
      await sdk.api.post('/extensions/momai-vision/command', {
        toolName: 'clear_camera_cache',
        args: {
          cameraId: target.id,
          url: trimmedUrl || target.url
        }
      })
      setClearCacheSuccess(true)
      if (onCacheCleared) {
        onCacheCleared(target.id)
      } else {
        setTimeout(() => setClearCacheSuccess(false), 4000)
      }
    } catch (err) {
      setModalError(err instanceof Error ? err.message : String(err))
    } finally {
      setClearingCache(false)
    }
  }

  const modalContent = (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className={`absolute inset-0 z-[100] animate-fadeIn overflow-y-auto pointer-events-auto ${
        isMaximized ? 'grid place-items-center p-6 bg-black/60 backdrop-blur-sm' : 'flex flex-col bg-bg'
      }`}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="vision-edit-camera-title"
        className={`flex flex-col bg-card shadow-2xl overflow-hidden ${
          isMaximized
            ? 'w-full max-w-[560px] max-h-[min(88dvh,640px)] rounded-2xl border border-border/40'
            : 'w-full h-full max-w-none max-h-none rounded-none border-0 flex-1 min-h-0'
        }`}
      >
        <div className="flex items-center gap-3 px-4 sm:px-6 py-4 border-b border-border/30 shrink-0">
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.back')}
            className="w-8 h-8 rounded-full bg-input hover:bg-card border border-border/40 text-text-muted hover:text-text flex items-center justify-center shrink-0 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border/40"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1 flex items-center justify-center gap-2.5 min-w-0">
            <span className="w-7 h-7 rounded-lg bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center shrink-0">
              <img src={visionIconPng} alt="MomAI Vision" className="w-3.5 h-3.5 object-contain inline-block shrink-0" draggable={false} />
            </span>
            <h2 id="vision-edit-camera-title" className="text-[14px] font-semibold text-text tracking-tight">
              {t('cameras.edit')}
            </h2>
          </div>
          <span className="w-8 h-8 shrink-0" aria-hidden="true" />
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar min-h-0 px-6 pt-5 pb-3 space-y-4">
          <div>
            <label htmlFor="vision-edit-name" className="block text-[11px] font-medium text-text-muted mb-1.5">
              {t('cameras.addModal.nameLabel')}
            </label>
            <input
              id="vision-edit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('cameras.addModal.namePlaceholder')}
              className="w-full bg-input border border-border/40 rounded-lg px-3 py-2 text-xs text-text placeholder-text-muted/60 focus:outline-none focus:border-border focus:ring-1 focus:ring-accent/20 transition-colors"
            />
          </div>

          <div>
            <label htmlFor="vision-edit-url" className="block text-[11px] font-medium text-text-muted mb-1.5">
              {t('cameras.addModal.urlLabel')}
            </label>
            <input
              id="vision-edit-url"
              value={url}
              disabled={!isIp}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('cameras.addModal.urlPlaceholder')}
              className="w-full bg-input border border-border/40 rounded-lg px-3 py-2 text-xs text-text placeholder-text-muted/60 focus:outline-none focus:border-border focus:ring-1 focus:ring-accent/20 transition-colors disabled:opacity-60"
            />
            {!isIp ? (
              <p className="text-[11px] text-text-muted mt-2">{t('cameras.optWebcam')}</p>
            ) : null}
          </div>

          {isIp ? (
            <div>
              <span id="vision-edit-transport-label" className="block text-[11px] font-medium text-text-muted mb-1.5">
                {t('cameras.addModal.transportLabel')}
              </span>
              <div role="radiogroup" aria-labelledby="vision-edit-transport-label" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {(['udp', 'tcp'] as const).map((mode) => {
                  const selected = transport === mode
                  return (
                    <label
                      key={mode}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors cursor-pointer ${selected
                        ? 'bg-emerald-500/10 border-emerald-500/50'
                        : 'bg-input border-border/40'
                        }`}
                    >
                      <input
                        type="radio"
                        name="vision-edit-transport"
                        value={mode}
                        checked={selected}
                        onChange={() => setTransport(mode)}
                        className="w-3.5 h-3.5 shrink-0"
                      />
                      <span className="text-xs font-medium text-text">
                        {t(mode === 'tcp' ? 'cameras.addModal.transportTcp' : 'cameras.addModal.transportUdp')}
                      </span>
                    </label>
                  )
                })}
              </div>

              {/* Preview width caps the MJPEG scale; the stream never
                  upscales, so a smaller source keeps its size. */}
              <div className="pt-3">
                <label htmlFor="vision-edit-preview-width" className="block text-[11px] font-medium text-text-muted mb-1.5">
                  {t('cameras.addModal.previewWidthLabel')}
                </label>
                <select
                  id="vision-edit-preview-width"
                  value={previewWidth}
                  onChange={(e) => setPreviewWidth(resolvePreviewWidth(Number(e.target.value)))}
                  className="w-full bg-input border border-border/40 rounded-lg px-3 py-2 text-xs text-text focus:outline-none focus:border-border focus:ring-1 focus:ring-accent/20 transition-colors"
                >
                  {PREVIEW_WIDTH_OPTIONS.map((width) => (
                    <option key={width} value={width}>
                      {t(`cameras.addModal.previewWidth${width}`)}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-text-muted mt-2">{t('cameras.addModal.previewWidthHelp')}</p>
              </div>

              {/* Protocol / Codec: H.264 (default stable) or H.265 (HEVC lower bandwidth) */}
              <div className="pt-3">
                <label htmlFor="vision-edit-codec" className="block text-[11px] font-medium text-text-muted mb-1.5">
                  {t('cameras.addModal.codecLabel')}
                </label>
                <select
                  id="vision-edit-codec"
                  value={codec}
                  onChange={(e) => setCodec(resolveRtspCodec(e.target.value))}
                  className="w-full bg-input border border-border/40 rounded-lg px-3 py-2 text-xs text-text focus:outline-none focus:border-border focus:ring-1 focus:ring-accent/20 transition-colors"
                >
                  <option value="h264">{t('cameras.addModal.codecH264')}</option>
                  <option value="h265">{t('cameras.addModal.codecH265')}</option>
                </select>
                <p className="text-[11px] text-text-muted mt-2">{t('cameras.addModal.codecHelp')}</p>
              </div>

              <div className="flex items-center justify-between gap-2 pt-2">
                <button
                  type="button"
                  disabled={clearingCache}
                  onClick={handleClearCache}
                  title={t('cameras.addModal.clearCacheHelp')}
                  className="inline-flex items-center gap-1.5 rounded-full bg-input hover:bg-card border border-border/40 text-text-muted hover:text-text text-[11px] font-medium px-3 py-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border/40 disabled:opacity-50 cursor-pointer"
                >
                  <svg className={`w-3.5 h-3.5 ${clearingCache ? 'animate-spin' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                    <path d="M21 3v5h-5" />
                    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                    <path d="M3 21v-5h5" />
                  </svg>
                  <span>{clearingCache ? t('cameras.addModal.clearCacheLoading') : t('cameras.addModal.clearCacheBtn')}</span>
                </button>
              </div>
              {clearCacheSuccess ? (
                <p role="status" className="text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-1.5 flex items-center gap-2 mt-2">
                  <span>✓</span>
                  <span>{t('cameras.addModal.clearCacheSuccess')}</span>
                </p>
              ) : null}
            </div>
          ) : null}

          {urlChanged ? (
            <p className="text-[11px] leading-relaxed text-text-muted bg-card border border-border/40 rounded-lg px-3 py-2">
              {target.id}
            </p>
          ) : null}
        </div>

        <div className="shrink-0 px-4 sm:px-6 py-3 sm:py-4 border-t border-border/30 bg-card flex flex-col gap-2 sm:gap-3">
          {modalError ? (
            <p className="w-full text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2.5 text-left leading-relaxed">
              {modalError}
            </p>
          ) : null}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full bg-input hover:bg-card border border-border/40 text-text-muted hover:text-text px-4 py-2 text-[11px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-border/40"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={submitting || !canSave}
              onClick={() => void handleSubmit()}
              className={`rounded-full px-4 py-2 text-[11px] font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-border/40 border ${!canSave
                ? 'bg-input/40 border-border/20 text-text-muted/40 cursor-not-allowed'
                : 'bg-emerald-600 hover:bg-emerald-500 border-transparent text-white shadow-md'
                }`}
            >
              {submitting ? t('monitoring.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )

  const portalTarget = sdk.ui?.overlayRoot?.()
  return portalTarget ? createPortal(modalContent, portalTarget) : modalContent
}
