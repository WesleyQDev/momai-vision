/**
 * Cores de classe para o canvas de boxes — lidas do tema do host.
 *
 * O canvas exige cor como string; em vez de hex hardcoded, a paleta é derivada
 * do token `--accent` do tema (formato `r g b` no app) com rotação de hue, para
 * acompanhar tema claro/escuro. Fallback para a paleta fixa quando o token não
 * está disponível (ex.: jsdom, host sem a variável exposta).
 */

export const DEFAULT_CLASS_COLORS = [
  '#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899',
  '#14b8a6', '#f97316', '#84cc16', '#06b6d4'
]

let cachedPalette: string[] | null = null
let cachedAt = 0

interface Rgb { r: number; g: number; b: number }
interface Hsl { h: number; s: number; l: number }

function parseCssColor(value: string): Rgb | null {
  const v = value.trim()
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    const [r, g, b] = v.slice(1).split('').map((c) => parseInt(c + c, 16))
    return { r, g, b }
  }
  if (/^#[0-9a-f]{6}$/i.test(v)) {
    return { r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16) }
  }
  const parts = v.split(/\s+/).map(Number)
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    return {
      r: Math.max(0, Math.min(255, Math.round(parts[0]))),
      g: Math.max(0, Math.min(255, Math.round(parts[1]))),
      b: Math.max(0, Math.min(255, Math.round(parts[2])))
    }
  }
  return null
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h = 0
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / d + 2) / 6
  else h = ((rn - gn) / d + 4) / 6
  return { h: h * 360, s, l }
}

function hslToRgb({ h, s, l }: Hsl): string {
  const hue = ((h % 360) + 360) % 360 / 360
  const sat = Math.max(0, Math.min(1, s))
  const lig = Math.max(0, Math.min(1, l))
  if (sat === 0) {
    const v = Math.round(lig * 255)
    return `rgb(${v}, ${v}, ${v})`
  }
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat
  const p = 2 * lig - q
  const f = (t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  const r = Math.round(f(hue + 1 / 3) * 255)
  const g = Math.round(f(hue) * 255)
  const b = Math.round(f(hue - 1 / 3) * 255)
  return `rgb(${r}, ${g}, ${b})`
}

function readThemeVar(name: string): string {
  try {
    const computed = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    if (computed) return computed
  } catch {
    // jsdom without computed style falls through to inline lookup below.
  }
  try {
    return document.documentElement.style.getPropertyValue(name).trim()
  } catch {
    return ''
  }
}

function themeRgb(varName: string): Rgb | null {
  const raw = readThemeVar(varName)
  if (!raw) return null
  return parseCssColor(raw)
}

function readAccentToken(): string {
  return readThemeVar('--accent')
}

function buildThemePalette(): string[] | null {
  const value = readAccentToken()
  if (!value) return null
  const base = parseCssColor(value)
  if (!base) return null
  const { h, s, l } = rgbToHsl(base)
  const lightness = Math.max(0.35, Math.min(0.85, l))
  const palette: string[] = []
  for (let i = 0; i < DEFAULT_CLASS_COLORS.length; i++) {
    palette.push(hslToRgb({ h: h + i * 36, s, l: lightness }))
  }
  return palette
}

function themePalette(): string[] {
  const now = Date.now()
  if (!cachedPalette || now - cachedAt > 5000) {
    cachedPalette = buildThemePalette() || DEFAULT_CLASS_COLORS
    cachedAt = now
  }
  return cachedPalette
}

/** Cor estável por classe, derivada do tema quando disponível. */
export function classColor(className: string): string {
  let hash = 0
  for (const ch of className) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  const palette = themePalette()
  return palette[hash % palette.length]
}

const OVERLAY_LABEL_FALLBACK = '#0a0a0a'
const ZONE_FILL_EDITING_FALLBACK = 'rgba(239, 68, 68, 0.16)'
const ZONE_FILL_SAVED_FALLBACK = 'rgba(56, 189, 248, 0.12)'
const ZONE_STROKE_EDITING_FALLBACK = '#ef4444'
const ZONE_STROKE_SAVED_FALLBACK = 'rgba(56, 189, 248, 0.85)'
const ZONE_VERTEX_EDITING_FALLBACK = '#ef4444'
const ZONE_VERTEX_DRAGGING_FALLBACK = '#f59e0b'
const ZONE_VERTEX_STROKE_FALLBACK = '#ffffff'

/** Label drawn on top of a detection tag. Reads the host text token, falls back only without a token. */
export function overlayLabelColor(): string {
  const text = themeRgb('--text-primary')
  if (!text) return OVERLAY_LABEL_FALLBACK
  return `rgb(${text.r}, ${text.g}, ${text.b})`
}

/** Zone polygon fill. Editing uses the error token, saved uses the accent token. */
export function zoneFillColor(isEditing: boolean): string {
  const rgb = themeRgb(isEditing ? '--error' : '--accent')
  if (!rgb) return isEditing ? ZONE_FILL_EDITING_FALLBACK : ZONE_FILL_SAVED_FALLBACK
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${isEditing ? 0.16 : 0.12})`
}

/** Zone polygon stroke. Editing uses the error token, saved uses the accent token. */
export function zoneStrokeColor(isEditing: boolean): string {
  const rgb = themeRgb(isEditing ? '--error' : '--accent')
  if (!rgb) return isEditing ? ZONE_STROKE_EDITING_FALLBACK : ZONE_STROKE_SAVED_FALLBACK
  return isEditing ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.85)`
}

/** Freehand trace uses the editing stroke so the in-progress path matches the polygon. */
export function zoneTraceColor(): string {
  return zoneStrokeColor(true)
}

/** Editable vertex fill. Dragging uses the highlight token, idle uses the error token. */
export function zoneVertexColor(isDragging: boolean): string {
  const rgb = themeRgb(isDragging ? '--highlight' : '--error')
  if (!rgb) return isDragging ? ZONE_VERTEX_DRAGGING_FALLBACK : ZONE_VERTEX_EDITING_FALLBACK
  return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`
}

/** Vertex outline. Reads the host text token for contrast on video, falls back only without a token. */
export function zoneVertexStrokeColor(): string {
  const text = themeRgb('--text-primary')
  if (!text) return ZONE_VERTEX_STROKE_FALLBACK
  return `rgb(${text.r}, ${text.g}, ${text.b})`
}