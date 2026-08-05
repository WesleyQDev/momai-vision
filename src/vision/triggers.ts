/**
 * Monitoring trigger engine (pure, testable).
 *
 * Evaluates a monitor's triggers against a frame + detections and decides
 * whether an alert fires. `scene` triggers need the vision LLM — the runtime
 * performs those calls and passes answers in via `evaluateScene`; the pure
 * engine only tracks cadence and N-confirmation state.
 */

export interface Detection {
  x1: number
  y1: number
  x2: number
  y2: number
  confidence: number
  classId: number
  className: string
}

export type Trigger =
  | { type: 'motion'; sensitivity?: 'low' | 'med' | 'high'; minArea?: number }
  | { type: 'object'; className: string; minConfidence?: number; present?: boolean }
  | { type: 'presence'; className?: string; event: 'entered' | 'left' | 'still_present'; windowSec?: number }
  | { type: 'absence'; className?: string; event: 'entered' | 'left' | 'still_present'; windowSec?: number }
  | { type: 'scene'; question: string; everySec?: number; onAnswer?: 'yes' | 'no' | 'change'; confirmN?: number }
  | { type: 'periodic'; everySec: number; task?: string }

export interface Schedule {
  days?: number[] // 0-6 (Sunday=0)
  start?: string // "HH:MM"
  end?: string // "HH:MM"
}

export interface MonitorConfig {
  id: string
  cameraId: string
  cameraName?: string
  triggers: Trigger[]
  schedule?: Schedule
  cooldownSec?: number
  notify?: { native?: boolean; chat?: boolean }
  label?: string
  createdAt?: number
}

export interface MonitorState {
  lastAlertTs: number
  lastMotion: boolean
  presence: Record<string, { present: boolean; since: number; lastSeen: number }>
  scene: Record<string, { lastCheckTs: number; lastAnswer: 'yes' | 'no' | null; confirmCount: number }>
  periodic: Record<string, { lastRunTs: number }>
}

export interface AlertInfo {
  triggeredBy: string
  monitorId: string
  monitorLabel?: string
  cameraId: string
  cameraName?: string
  confidence?: number
  className?: string
  description: string
  ts: number
  boxes?: Detection[]
}

export interface TriggerContext {
  motionDetected: boolean
  detections: Detection[]
  now: number
  frameJpeg: string
}

export interface SceneAnswer {
  monitorId: string
  triggerIndex: number
  answer: 'yes' | 'no'
}

export function createMonitorState(): MonitorState {
  return {
    lastAlertTs: 0,
    lastMotion: false,
    presence: {},
    scene: {},
    periodic: {}
  }
}

export function inSchedule(schedule: Schedule | undefined, now: number): boolean {
  if (!schedule) return true
  const date = new Date(now)
  const day = date.getDay()
  if (Array.isArray(schedule.days) && schedule.days.length > 0 && !schedule.days.includes(day)) {
    return false
  }
  if (schedule.start && schedule.end) {
    const minutes = date.getHours() * 60 + date.getMinutes()
    const [sh, sm] = schedule.start.split(':').map(Number)
    const [eh, em] = schedule.end.split(':').map(Number)
    const startMin = sh * 60 + sm
    const endMin = eh * 60 + em
    if (startMin < endMin) {
      if (minutes < startMin || minutes >= endMin) return false
    } else {
      // Overnight window (e.g. 22:00-06:00)
      if (minutes < startMin && minutes >= endMin) return false
    }
  }
  return true
}

function inCooldown(state: MonitorState, monitor: MonitorConfig, now: number): boolean {
  const cooldown = (monitor.cooldownSec ?? 300) * 1000
  return now - state.lastAlertTs < cooldown
}

function findDetections(detections: Detection[], className: string, minConfidence: number): Detection[] {
  const wanted = normalizeClassName(className).toLowerCase()
  return detections.filter((d) => d.className.toLowerCase() === wanted && d.confidence >= minConfidence)
}

function presenceKey(className: string): string {
  return className || 'person'
}

const COCO_SYNONYMS: Record<string, string> = {
  pessoa: 'person', pessoas: 'person', gente: 'person', homem: 'person', mulher: 'person',
  rapaz: 'person', crianca: 'person', criança: 'person', pessoa1: 'person',
  gato: 'cat', gatos: 'cat', cachorro: 'dog', cachorros: 'dog', cao: 'dog', cão: 'dog',
  caes: 'dog', cães: 'dog', cadelo: 'dog', dog: 'dog',
  carro: 'car', carros: 'car', veiculo: 'car', veículo: 'car',
  moto: 'motorcycle', motos: 'motorcycle', motocicleta: 'motorcycle',
  bicicleta: 'bicycle', bike: 'bicycle',
  onibus: 'bus', ônibus: 'bus', caminhao: 'truck', caminhão: 'truck',
  celular: 'cell phone', celulares: 'cell phone', telefone: 'cell phone', smartphone: 'cell phone',
  passaro: 'bird', pássaro: 'bird', passaros: 'bird', pássaros: 'bird', passarinho: 'bird',
  livro: 'book', livros: 'book', mochila: 'backpack', cadeira: 'chair', sofa: 'couch', sofá: 'couch',
  tv: 'tv', televisao: 'tv', televisão: 'tv', notebook: 'laptop', computador: 'laptop', pc: 'laptop',
  garrafa: 'bottle', copo: 'cup', xicara: 'cup', xícara: 'cup', vaso: 'vase',
  planta: 'potted plant', 'vaso de planta': 'potted plant', 'vaso de flores': 'potted plant'
}

/**
 * Normalizes a class name (e.g. Portuguese synonyms) to the English COCO
 * label the detector emits, so monitoring matches regardless of the language
 * the model used to describe the target.
 */
export function normalizeClassName(name: string): string {
  if (!name) return ''
  const key = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase()
  return COCO_SYNONYMS[key] || name.trim()
}

/**
 * Evaluates all triggers of a monitor. Returns alerts to fire. The runtime
 * calls this every tick with the latest frame data; `scene` triggers that
 * are due are returned in `sceneDue` so the runtime can query the vision
 * LLM and then call `applySceneAnswer`.
 */
export function evaluateMonitor(
  monitor: MonitorConfig,
  state: MonitorState,
  ctx: TriggerContext
): { alerts: AlertInfo[]; sceneDue: Array<{ triggerIndex: number; question: string }> } {
  const alerts: AlertInfo[] = []
  const sceneDue: Array<{ triggerIndex: number; question: string }> = []
  const now = ctx.now

  if (!inSchedule(monitor.schedule, now)) return { alerts, sceneDue }
  state.lastMotion = ctx.motionDetected

  monitor.triggers.forEach((trigger, index) => {
    const base = {
      monitorId: monitor.id,
      monitorLabel: monitor.label,
      cameraId: monitor.cameraId,
      cameraName: monitor.cameraName,
      ts: now,
      boxes: ctx.detections && ctx.detections.length > 0 ? ctx.detections : undefined
    }

    if (trigger.type === 'motion') {
      if (ctx.motionDetected && !inCooldown(state, monitor, now)) {
        state.lastAlertTs = now
        alerts.push({ ...base, triggeredBy: 'motion', description: 'Movimento detectado' })
      }
      return
    }

    if (trigger.type === 'object') {
      const className = trigger.className || 'person'
      const minConf = trigger.minConfidence ?? 0.4
      const found = findDetections(ctx.detections, className, minConf).length > 0
      const wantPresent = trigger.present !== false
      if (found === wantPresent && !inCooldown(state, monitor, now)) {
        state.lastAlertTs = now
        const det = findDetections(ctx.detections, className, minConf)[0]
        alerts.push({
          ...base,
          triggeredBy: `object:${className}`,
          confidence: det?.confidence,
          className,
          description: wantPresent
            ? `${capitalize(className)} detectado`
            : `${capitalize(className)} ausente`
        })
      }
      return
    }

    if (trigger.type === 'presence' || trigger.type === 'absence') {
      const className = trigger.className || 'person'
      const minConf = 0.4
      const key = presenceKey(className)
      const present = findDetections(ctx.detections, className, minConf).length > 0
      const entry = state.presence[key] || { present: false, since: now, lastSeen: now }
      const wasPresent = entry.present
      entry.present = present
      if (present) entry.lastSeen = now
      if (!wasPresent && present) entry.since = now
      state.presence[key] = entry

      const isAbsence = trigger.type === 'absence'
      const entered = present && !wasPresent
      const left = !present && wasPresent
      const still = present && now - entry.since >= (trigger.windowSec ?? 60) * 1000

      let fire = false
      let label = ''
      if (trigger.event === 'entered') {
        fire = isAbsence ? left : entered
        label = isAbsence ? 'ausência iniciada' : 'presença detectada'
      } else if (trigger.event === 'left') {
        fire = isAbsence ? entered : left
        label = isAbsence ? 'presença iniciada' : 'presença encerrada'
      } else if (trigger.event === 'still_present') {
        fire = still
        label = 'parado há mais de ' + (trigger.windowSec ?? 60) + 's'
      }

      if (fire && !inCooldown(state, monitor, now)) {
        state.lastAlertTs = now
        alerts.push({
          ...base,
          triggeredBy: `${trigger.type}:${trigger.event}`,
          className,
          description: `${capitalize(className)}: ${label}`
        })
      }
      return
    }

    if (trigger.type === 'scene') {
      const every = Math.max(15, trigger.everySec ?? 60) * 1000
      const entry = state.scene[index] || { lastCheckTs: 0, lastAnswer: null, confirmCount: 0 }
      if (now - entry.lastCheckTs >= every) {
        entry.lastCheckTs = now
        state.scene[index] = entry
        sceneDue.push({ triggerIndex: index, question: trigger.question })
      }
      return
    }

    if (trigger.type === 'periodic') {
      const every = Math.max(15, trigger.everySec) * 1000
      const entry = state.periodic[index] || { lastRunTs: 0 }
      if (now - entry.lastRunTs >= every) {
        entry.lastRunTs = now
        state.periodic[index] = entry
        sceneDue.push({ triggerIndex: index, question: trigger.task || 'Descreva o que mudou na cena' })
      }
      return
    }
  })

  return { alerts, sceneDue }
}

/**
 * Applies a vision answer to a scene trigger. Fires an alert when the answer
 * matches (yes/no) or when it changes from the previous answer (change),
 * after N consecutive identical answers (anti-flapping).
 */
export function applySceneAnswer(
  monitor: MonitorConfig,
  state: MonitorState,
  triggerIndex: number,
  answer: 'yes' | 'no',
  now: number
): AlertInfo | null {
  const trigger = monitor.triggers[triggerIndex]
  if (!trigger || trigger.type !== 'scene') return null

  const entry = state.scene[triggerIndex] || { lastCheckTs: now, lastAnswer: null, confirmCount: 0 }
  const confirmN = trigger.confirmN ?? 1

  let shouldFire = false
  const answerMode = trigger.onAnswer || 'yes'
  if (answerMode === 'change') {
    if (entry.lastAnswer !== null && answer !== entry.lastAnswer) {
      entry.confirmCount++
      if (entry.confirmCount >= confirmN) shouldFire = true
    } else {
      entry.confirmCount = 0
    }
  } else {
    if (answer === answerMode) {
      entry.confirmCount++
      if (entry.confirmCount >= confirmN) shouldFire = true
    } else {
      entry.confirmCount = 0
    }
  }
  entry.lastAnswer = answer
  state.scene[triggerIndex] = entry

  if (shouldFire && !inCooldown(state, monitor, now)) {
    state.lastAlertTs = now
    entry.confirmCount = 0
    state.scene[triggerIndex] = entry
    return {
      monitorId: monitor.id,
      monitorLabel: monitor.label,
      cameraId: monitor.cameraId,
      cameraName: monitor.cameraName,
      ts: now,
      triggeredBy: `scene:${triggerIndex}`,
      description: trigger.question
    }
  }
  return null
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
