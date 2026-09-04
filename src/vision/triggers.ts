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

/**
 * Action (MOM-115): "quando este monitor disparar → pedir à extensão `target`
 * que execute `tool` com `args`". Valores de args podem ser fixos, templates
 * com placeholders ({cameraName}, {description}, {ts}, {event.imageDataUri}) ou
 * { from: 'event.<campo>' } — o host resolve contra os dados do alerta.
 */
export interface MonitorAction {
  id?: string
  target: string
  tool: string
  args?: Record<string, unknown>
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
  actions?: MonitorAction[]
  createdAt?: number
  /** Quando true, o monitor está pausado: permanece salvo, mas não executa. */
  paused?: boolean
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
    // Formato HH:MM — horário inválido não pode "derrubar" o schedule inteiro
    // (start/end ruins fariam o monitor nunca disparar, em silêncio).
    const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
    if (!HHMM.test(schedule.start) || !HHMM.test(schedule.end)) return false
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

/** Campos genéricos do Hub de Automações lidos na propagação de tempo. */
export interface AutomationPolicyLike {
  cooldownSeconds?: number
  cooldownMinutes?: number
  maxPerDay?: number
  weekdays?: number[]
  startTime?: string
  endTime?: string
  expiresAt?: string
}

export interface AutomationConditionLike {
  kind?: string
  field?: string
  operator?: string
  value?: unknown
}

export interface AutomationTiming {
  expired?: boolean
  never?: boolean
  cooldownSec?: number | null
  schedule?: Schedule | null
}

function toMinutes(hhmm: string): number {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}

function toHHMM(min: number): string {
  const h = Math.floor(min / 60) % 24
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Janela HH:MM como lista de intervalos inclusivos (suporta overnight). */
function rangesOf(start: string, end: string): Array<[number, number]> {
  const s = toMinutes(start)
  const e = toMinutes(end)
  return s <= e ? [[s, e]] : [[s, 1439], [0, e]]
}

function intersectRanges(
  A: Array<[number, number]>,
  B: Array<[number, number]>
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const [a1, a2] of A)
    for (const [b1, b2] of B) {
      const s = Math.max(a1, b1)
      const e = Math.min(a2, b2)
      if (s <= e) out.push([s, e])
    }
  return out
}

function rangesToWindow(R: Array<[number, number]>): [string | null, string | null] {
  if (R.length === 0) return [null, null]
  if (R.length === 1) return [toHHMM(R[0][0]), toHHMM(R[0][1])]
  const sorted = [...R].sort((x, y) => x[0] - y[0])
  if (sorted.length === 2 && sorted[0][0] === 0 && sorted[1][1] === 1439)
    return [toHHMM(sorted[1][0]), toHHMM(sorted[0][1])]
  const s = Math.min(...R.map((r) => r[0]))
  const e = Math.max(...R.map((r) => r[1]))
  return [toHHMM(s), toHHMM(e)]
}

/**
 * Traduz o tempo de negócio da automação (policy + conditions time_window)
 * para o sensoriamento local. O dono único do tempo é a automação: a extensão
 * propaga em vez de ter tempo próprio (evita snapshot/overlay/LLM
 * desperdiçados quando o Hub barraria o disparo de qualquer forma).
 */
export function automationTimingToMonitor(
  policy: AutomationPolicyLike | null | undefined,
  conditions: AutomationConditionLike[] | null | undefined
): AutomationTiming {
  const p: AutomationPolicyLike = policy && typeof policy === 'object' ? policy : {}
  if (p.expiresAt) {
    const exp = new Date(p.expiresAt).getTime()
    if (!isNaN(exp) && Date.now() > exp) return { expired: true }
  }
  let cd: number | null = null
  if (p.cooldownSeconds !== undefined && p.cooldownSeconds !== null) cd = Number(p.cooldownSeconds)
  else if (p.cooldownMinutes !== undefined && p.cooldownMinutes !== null)
    cd = Number(p.cooldownMinutes) * 60
  // Piso de 5s vale só para monitores vindos de automação (manuais mantêm
  // o clamp 10–3600 de start/update_monitoring).
  const cooldownSec = cd !== null && !isNaN(cd) ? Math.min(Math.max(cd, 5), 3600) : null
  let days: number[] | null = Array.isArray(p.weekdays)
    ? p.weekdays.map(Number).filter((d) => d >= 0 && d <= 6)
    : null
  let window: Array<[number, number]> | null = null
  if (typeof p.startTime === 'string' && p.startTime && typeof p.endTime === 'string' && p.endTime)
    window = rangesOf(p.startTime, p.endTime)
  for (const c of Array.isArray(conditions) ? conditions : []) {
    if (!c || c.kind !== 'time_window') continue
    if (c.field === 'time.weekday' && c.operator === 'in' && Array.isArray(c.value)) {
      const ds = (c.value as unknown[]).map(Number).filter((d) => d >= 0 && d <= 6)
      days = days ? days.filter((d) => ds.includes(d)) : ds
    }
    if (
      c.field === 'time.time' &&
      c.operator === 'between' &&
      Array.isArray(c.value) &&
      c.value.length >= 2
    ) {
      const w = rangesOf(String(c.value[0]), String(c.value[1]))
      window = window ? intersectRanges(window, w) : w
    }
    if (c.field === 'time.time' && c.operator === 'equals' && c.value) {
      const w = rangesOf(String(c.value), String(c.value))
      window = window ? intersectRanges(window, w) : w
    }
  }
  if (days !== null && days.length === 0) return { never: true }
  let winStart: string | null = null
  let winEnd: string | null = null
  if (window !== null) {
    ;[winStart, winEnd] = rangesToWindow(window)
    if (!winStart || !winEnd) return { never: true }
  }
  let schedule: Schedule | null = null
  if ((days && days.length > 0) || winStart) {
    schedule = {}
    if (days && days.length > 0) schedule.days = days
    if (winStart && winEnd) {
      schedule.start = winStart
      schedule.end = winEnd
    }
  }
  return { cooldownSec, schedule }
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
      // Default 0.20: mesmo limite do engine YOLO, para que toda detecção
      // visível na página (frame_pump) também possa disparar o monitor.
      const minConf = trigger.minConfidence ?? 0.20
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
      // Mesmo limite do engine YOLO (0.20): detecções visíveis na página
      // também contam para presença/ausência.
      const minConf = 0.20
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
