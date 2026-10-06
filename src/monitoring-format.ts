/**
 * Monitoring trigger/action formatting helpers (pure, testable).
 *
 * Extracted from page.tsx so the dashboard component only owns rendering and
 * state. All functions take the translate function as an argument and fall
 * back to pt-BR defaults when it is absent.
 */

import { ptLabel, PT_CLASS, localizedClassLabel } from './vision/labels'

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string

export interface MonitorTriggerInfo {
  type: string
  className?: string
  sensitivity?: string
  present?: boolean
  event?: string
  windowSec?: number
}

export const TRIGGER_TYPES = [
  { value: 'motion', labelKey: 'monitoring.typeMotion' },
  { value: 'object', labelKey: 'monitoring.typeObject' },
  { value: 'person', labelKey: 'monitoring.typePeople' },
  { value: 'animal', labelKey: 'monitoring.typeAnimals' },
  { value: 'presence', labelKey: 'monitoring.typePresence' },
  { value: 'absence', labelKey: 'monitoring.typeAbsence' }
]

export const SENSITIVITY_OPTIONS = [
  { value: 'med', labelKey: 'monitoring.sensMed' },
  { value: 'low', labelKey: 'monitoring.sensLow' },
  { value: 'high', labelKey: 'monitoring.sensHigh' }
]

export const ANIMAL_KEYS = [
  'dog',
  'cat',
  'bird',
  'horse',
  'sheep',
  'cow',
  'bear',
  'elephant',
  'zebra',
  'giraffe'
]

export function objectOptionLabel(key: string, translate?: TranslateFn): string {
  const base = translate ? localizedClassLabel(key, translate) : ptLabel(key)
  const label = base || key
  return `${label.charAt(0).toUpperCase() + label.slice(1)} (${key})`
}

export function animalObjectOptions(translate?: TranslateFn): Array<{ value: string; label: string }> {
  return ANIMAL_KEYS.map((key) => ({ value: key, label: objectOptionLabel(key, translate) }))
}

export function inanimateObjectOptions(translate?: TranslateFn): Array<{ value: string; label: string }> {
  return Object.entries(PT_CLASS)
    .filter(([key]) => key !== 'person' && !ANIMAL_KEYS.includes(key))
    .map(([key]) => ({ value: key, label: objectOptionLabel(key, translate) }))
}

export function allObjectOptions(translate?: TranslateFn): Array<{ value: string; label: string }> {
  return Object.entries(PT_CLASS).map(([key]) => ({
    value: key,
    label: objectOptionLabel(key, translate)
  }))
}

export const COOLDOWN_PRESETS = [
  { label: '30s', seconds: 30 },
  { label: '1m', seconds: 60 },
  { label: '5m', seconds: 300 },
  { label: '15m', seconds: 900 }
]

export function formatCooldown(sec?: number): string {
  if (!sec || isNaN(sec) || sec <= 0) return '5 min'
  if (sec % 60 === 0) {
    return `${sec / 60} min`
  }
  if (sec >= 60) {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return s > 0 ? `${m}m ${s}s` : `${m} min`
  }
  return `${sec}s`
}

export function formatTriggerPortuguese(trigger: MonitorTriggerInfo, translate?: TranslateFn): string {
  const pick = (key: string, fallback: string, vars?: Record<string, string | number>): string => {
    if (!translate) return fallback
    const translated = vars ? translate(key, vars) : translate(key)
    return translated && translated !== key ? translated : fallback
  }
  const classLabel = (name?: string, fallback = ''): string =>
    translate ? localizedClassLabel(name, translate) || fallback : ptLabel(name) || fallback
  switch (trigger.type) {
    case 'motion':
      return `${pick('monitoring.sumMotion', 'Movimento')} (${trigger.sensitivity === 'high' ? pick('monitoring.sumHigh', 'Alta sensibilidade') : trigger.sensitivity === 'low' ? pick('monitoring.sumLow', 'Baixa sensibilidade') : pick('monitoring.sumMed', 'Sensibilidade média')})`
    case 'object':
      if (trigger.className === 'person') {
        return `${pick('monitoring.sumPeople', 'Pessoas')} (${trigger.present === false ? pick('monitoring.sumAbsent', 'Ausente') : pick('monitoring.sumDetectPresence', 'Detectar presença')})`
      }
      if (ANIMAL_KEYS.includes(trigger.className || '')) {
        return `${pick('monitoring.sumAnimal', 'Animal')}: ${classLabel(trigger.className)} (${trigger.present === false ? pick('monitoring.sumAbsent', 'Ausente') : pick('monitoring.sumPresent', 'Presente')})`
      }
      return `${pick('monitoring.sumObject', 'Objeto')}: ${classLabel(trigger.className, 'objeto')} (${trigger.present === false ? pick('monitoring.sumAbsent', 'Ausente') : pick('monitoring.sumPresent', 'Presente')})`
    case 'presence':
      return `${pick('monitoring.sumPresence', 'Presença')}: ${classLabel(trigger.className, 'pessoa')} (${trigger.event === 'entered' ? pick('monitoring.sumEntered', 'Entrou') : trigger.event === 'left' ? pick('monitoring.sumLeft', 'Saiu') : pick('monitoring.sumStayed', 'Permaneceu')}${trigger.windowSec ? `, ${trigger.windowSec}s` : ''})`
    case 'absence':
      return `${pick('monitoring.sumAbsence', 'Ausência')}: ${classLabel(trigger.className, 'pessoa')}${trigger.windowSec ? ` (${trigger.windowSec}s)` : ''}`
    default:
      if (
        !trigger.type ||
        trigger.type === 'momai-vision.vision_alert' ||
        trigger.type === 'vision_alert' ||
        trigger.type === 'vision:detection'
      ) {
        return ''
      }
      return trigger.type
  }
}

export function eventPlaceholders(translate?: TranslateFn): Array<{ token: string; label: string }> {
  const pick = (key: string, fallback: string): string => {
    if (!translate) return fallback
    const translated = translate(key)
    return translated && translated !== key ? translated : fallback
  }
  return [
    { token: '{cameraName}', label: pick('monitoring.phCamera', 'Câmera') },
    { token: '{description}', label: pick('monitoring.phDescription', 'Descrição') },
    { token: '{ts}', label: pick('monitoring.phTime', 'Horário') },
    { token: '{event.imageDataUri}', label: pick('monitoring.phImage', 'Imagem') }
  ]
}

/**
 * Switches an action image template between the clean snapshot and the
 * annotated variant with detection boxes burned in. Preserves the brace
 * style the action already uses ({event.*} or {{trigger.payload.*}}), so
 * the toggle works for both legacy monitors and Hub automations. Missing
 * images fall back to the clean default (no change needed for opt-out).
 */
export function withBoxesImageTemplate(image: unknown, enable: boolean): unknown {
  if (enable) {
    if (typeof image === 'string' && image.includes('imageDataUri')) {
      if (image.includes('annotatedImageDataUri')) return image
      return image.split('imageDataUri').join('annotatedImageDataUri')
    }
    return '{event.annotatedImageDataUri}'
  }
  if (typeof image === 'string' && image.includes('annotatedImageDataUri')) {
    return image.split('annotatedImageDataUri').join('imageDataUri')
  }
  return image
}

export function isOverlayAction(item: {
  target?: string
  tool?: string
  action?: string
  action_id?: string
}): boolean {
  const tool = String(item.tool || '')
  const actionId = String(
    (item as { action?: unknown }).action || (item as { action_id?: unknown }).action_id || ''
  )
  return tool === 'show_overlay' || actionId.includes('show_overlay')
}

// Human-readable fallback labels (pt-BR) for tool and field names shown in
// the action selector. The locale dictionary takes precedence when a
// translate function is provided; the technical name stays as last resort.
const TOOL_LABEL_KEYS: Record<string, string> = {
  send_message: 'monitoring.tools.sendMessage',
  list_contacts: 'monitoring.tools.listContacts',
  add_contact: 'monitoring.tools.addContact',
  remove_contact: 'monitoring.tools.removeContact',
  get_stats: 'monitoring.tools.getStats',
  get_history: 'monitoring.tools.getHistory',
  get_wa_contacts: 'monitoring.tools.getWaContacts',
  get_wa_groups: 'monitoring.tools.getWaGroups',
  control_device: 'monitoring.tools.controlDevice',
  set_light_color: 'monitoring.tools.setLightColor',
  control_tv_remote: 'monitoring.tools.controlTv',
  control_climate: 'monitoring.tools.controlClimate',
  call_ha_service: 'monitoring.tools.callHa',
  list_devices: 'monitoring.tools.listDevices',
  query_device: 'monitoring.tools.queryDevice',
  capture_snapshot: 'monitoring.tools.captureSnapshot',
  start_monitoring: 'monitoring.tools.startMonitoring',
  set_actions: 'monitoring.tools.setActions',
  get_actions: 'monitoring.tools.getActions'
}

const TOOL_LABEL_FALLBACK: Record<string, string> = {
  send_message: 'Enviar mensagem',
  list_contacts: 'Listar contatos',
  add_contact: 'Adicionar contato',
  remove_contact: 'Remover contato',
  get_stats: 'Estatísticas',
  get_history: 'Histórico',
  get_wa_contacts: 'Buscar contatos',
  get_wa_groups: 'Buscar grupos',
  control_device: 'Controlar dispositivo',
  set_light_color: 'Cor da luz',
  control_tv_remote: 'Controle da TV',
  control_climate: 'Controlar clima',
  call_ha_service: 'Serviço da casa',
  list_devices: 'Listar dispositivos',
  query_device: 'Consultar dispositivo',
  capture_snapshot: 'Capturar print',
  start_monitoring: 'Iniciar monitoramento',
  set_actions: 'Configurar ações',
  get_actions: 'Ver ações'
}

const PARAM_LABEL_KEYS: Record<string, string> = {
  contact: 'monitoring.params.contact',
  message: 'monitoring.params.message',
  image: 'monitoring.params.image',
  media: 'monitoring.params.media',
  device_name: 'monitoring.params.deviceName',
  action: 'monitoring.params.action',
  brightness: 'monitoring.params.brightness',
  color: 'monitoring.params.color',
  temperature: 'monitoring.params.temperature',
  domain: 'monitoring.params.domain',
  service: 'monitoring.params.service',
  data: 'monitoring.params.data',
  room: 'monitoring.params.room',
  cameraId: 'monitoring.params.cameraId',
  camera: 'monitoring.params.camera',
  monitorId: 'monitoring.params.monitorId',
  label: 'monitoring.params.label'
}

const PARAM_LABELS: Record<string, string> = {
  contact: 'Contato ou número',
  message: 'Mensagem',
  image: 'Imagem',
  media: 'Imagem',
  device_name: 'Dispositivo',
  action: 'Ação',
  brightness: 'Brilho',
  color: 'Cor',
  temperature: 'Temperatura',
  domain: 'Domínio',
  service: 'Serviço',
  data: 'Dados',
  room: 'Cômodo',
  cameraId: 'Câmera',
  camera: 'Câmera',
  monitorId: 'Monitor',
  label: 'Rótulo'
}

export function humanizeKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function lookupLabel(
  keys: Record<string, string>,
  fallback: Record<string, string>,
  name: string,
  translate?: TranslateFn
): string {
  const key = keys[name]
  if (translate && key) {
    const translated = translate(key)
    if (translated && translated !== key) return translated
  }
  return fallback[name] || humanizeKey(name)
}

export function toolLabel(name: string, translate?: TranslateFn): string {
  return lookupLabel(TOOL_LABEL_KEYS, TOOL_LABEL_FALLBACK, name, translate)
}

export function paramLabel(key: string, translate?: TranslateFn): string {
  return lookupLabel(PARAM_LABEL_KEYS, PARAM_LABELS, key, translate)
}

// Formata os args de uma ação em texto legível, ex.: "Dispositivo: Luz, Cor: verde".
export function formatActionArgs(args?: Record<string, unknown>, translate?: TranslateFn): string {
  if (!args) return ''
  return Object.entries(args)
    .filter(([, v]) => !(typeof v === 'string' && !v.trim()))
    .map(([k, v]) => {
      const val = v && typeof v === 'object' ? JSON.stringify(v) : String(v)
      return `${paramLabel(k, translate)}: ${val}`
    })
    .join(' · ')
}
