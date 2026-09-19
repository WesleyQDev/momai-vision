import { useCallback, useEffect, useState } from 'react'
import { captureWidgetFrame } from '../services/visionWidgets'

interface LiveState {
  loading: boolean
  error: string
  image: string
  cameraName: string
  refresh: () => Promise<void>
}

export function useLiveWidget(cameraId: string, isEditing: boolean): LiveState {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [image, setImage] = useState('')
  const [cameraName, setCameraName] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    if (!cameraId || isEditing) return
    try {
      const frame = await captureWidgetFrame(cameraId)
      setImage(frame.image)
      if (frame.cameraName) setCameraName(frame.cameraName)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Capture failed.')
    }
  }, [cameraId, isEditing])

  useEffect(() => {
    if (!cameraId || isEditing) {
      setLoading(false)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null
    async function first(): Promise<void> {
      setLoading(true)
      setError('')
      await refresh()
      if (!cancelled) {
        setLoading(false)
        timer = setInterval(() => void refresh(), 5000)
      }
    }
    void first()
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [cameraId, isEditing, refresh])

  return { loading, error, image, cameraName, refresh }
}
