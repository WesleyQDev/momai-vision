import { useEffect, useState } from 'react'

/**
 * Reflects whether the MomAI host window is maximized. Same contract the host
 * uses for its own settings card: when the window is resized (not maximized)
 * the card overlays the whole MomAI area; when maximized it shows as a normal
 * centered card.
 */
export function useWindowMaximized(): boolean {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    const api = (window as any).api
    api
      ?.isWindowMaximized?.()
      .then((maximized: boolean) => setIsMaximized(maximized))
      .catch(() => {})
    const unsubscribe = api?.onWindowStateChanged?.((state: { maximized: boolean }) => {
      setIsMaximized(state.maximized)
    })
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  return isMaximized
}
