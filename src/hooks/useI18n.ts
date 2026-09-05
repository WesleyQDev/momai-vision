/**
 * Extension-local i18n hook for MomAI Vision.
 *
 * Reads locale files from `locales/` directory and syncs with the host app
 * via `sdk.i18n.getLocale()` and locale change events.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getSDK } from 'momai:sdk'

import ptBR from '../../locales/pt-BR.json'
import enUS from '../../locales/en-US.json'
import es from '../../locales/es.json'
import de from '../../locales/de.json'
import fr from '../../locales/fr.json'
import it from '../../locales/it.json'

const dictionaries: Record<string, Record<string, unknown>> = {
  'pt-BR': ptBR as Record<string, unknown>,
  'en-US': enUS as Record<string, unknown>,
  es: es as Record<string, unknown>,
  de: de as Record<string, unknown>,
  fr: fr as Record<string, unknown>,
  it: it as Record<string, unknown>
}

const DEFAULT_LOCALE = 'pt-BR'

export function normalizeLocale(value?: string | null): string {
  if (!value || typeof value !== 'string') return DEFAULT_LOCALE
  if (value in dictionaries) return value
  const short = value.toLowerCase().split('-')[0]
  if (short === 'pt') return 'pt-BR'
  if (short === 'en') return 'en-US'
  if (short === 'es') return 'es'
  if (short === 'de') return 'de'
  if (short === 'fr') return 'fr'
  if (short === 'it') return 'it'
  return DEFAULT_LOCALE
}

function getNestedValue(obj: unknown, path: string): string | undefined {
  if (!path || typeof path !== 'string') return undefined
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return typeof current === 'string' ? current : undefined
}

export function useI18n() {
  const [locale, setLocaleState] = useState<string>(() => {
    try {
      const sdk = getSDK()
      const sdkLoc = sdk?.i18n?.getLocale?.()
      if (sdkLoc) return normalizeLocale(sdkLoc)
      return normalizeLocale(
        (window as any).__MOMAI_LOCALE__ || localStorage.getItem('momai_locale')
      )
    } catch {
      return DEFAULT_LOCALE
    }
  })

  useEffect(() => {
    let unsubscribeSdk: (() => void) | undefined
    try {
      const sdk = getSDK()
      if (sdk?.i18n?.onLocaleChange) {
        unsubscribeSdk = sdk.i18n.onLocaleChange((newLocale: string) => {
          setLocaleState(normalizeLocale(newLocale))
        })
      }
    } catch {}

    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<{ locale: string }>
      const newLocale =
        customEvent?.detail?.locale ||
        (window as any).__MOMAI_LOCALE__ ||
        localStorage.getItem('momai_locale') ||
        DEFAULT_LOCALE
      setLocaleState(normalizeLocale(newLocale))
    }

    window.addEventListener('momai:locale-changed', handler)

    const storageHandler = (e: StorageEvent) => {
      if (e.key === 'momai_locale' && e.newValue) {
        setLocaleState(normalizeLocale(e.newValue))
      }
    }
    window.addEventListener('storage', storageHandler)

    return () => {
      if (unsubscribeSdk) unsubscribeSdk()
      window.removeEventListener('momai:locale-changed', handler)
      window.removeEventListener('storage', storageHandler)
    }
  }, [])

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>): string => {
      if (!key || typeof key !== 'string') return ''
      const dict = dictionaries[locale] || dictionaries[DEFAULT_LOCALE]
      let text = getNestedValue(dict, key) ?? getNestedValue(dictionaries[DEFAULT_LOCALE], key) ?? key
      if (vars && typeof text === 'string') {
        for (const [varKey, varValue] of Object.entries(vars)) {
          text = text.replaceAll(`{${varKey}}`, String(varValue))
          text = text.replaceAll(`{{${varKey}}}`, String(varValue))
        }
      }
      return text
    },
    [locale]
  )

  return useMemo(() => ({ locale, t }), [locale, t])
}
