import { useEffect, useState } from 'react'
import { fetchLastWidgetSnapshot, type WidgetSnapshot } from '../services/visionWidgets'

interface DetectionState {
  loading: boolean
  error: string
  detection: WidgetSnapshot | null
}

export function useLastDetectionWidget(isEditing: boolean): DetectionState {
  const [state, setState] = useState<DetectionState>({ loading: true, error: '', detection: null })

  useEffect(() => {
    if (isEditing) {
      setState((prev) => ({ ...prev, loading: false }))
      return
    }
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const detection = await fetchLastWidgetSnapshot()
        if (!cancelled) setState({ loading: false, error: '', detection })
      } catch (err) {
        if (!cancelled) {
          setState({ loading: false, error: err instanceof Error ? err.message : 'Load failed.', detection: null })
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [isEditing])

  return state
}
