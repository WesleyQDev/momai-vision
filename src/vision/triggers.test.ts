import { describe, it, expect } from 'vitest'
import {
  createMonitorState,
  evaluateMonitor,
  applySceneAnswer,
  inSchedule,
  type MonitorConfig,
  type Detection,
  type Trigger
} from './triggers'

const NOW = Date.parse('2026-08-04T12:00:00Z')

function monitor(triggers: Trigger[], overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    id: 'mon-1',
    cameraId: 'cam1',
    cameraName: 'Garagem',
    triggers,
    cooldownSec: 120,
    createdAt: NOW,
    ...overrides
  }
}

const person: Detection = {
  x1: 0.1,
  y1: 0.2,
  x2: 0.3,
  y2: 0.8,
  confidence: 0.92,
  classId: 0,
  className: 'person'
}

function ctx(overrides: Partial<Parameters<typeof evaluateMonitor>[2]> = {}) {
  return {
    motionDetected: false,
    detections: [],
    now: NOW,
    frameJpeg: 'fake',
    ...overrides
  }
}

describe('inSchedule', () => {
  it('returns true when no schedule is set', () => {
    expect(inSchedule(undefined, NOW)).toBe(true)
  })

  it('respects day filters (2026-08-04 is a Tuesday = 2)', () => {
    const date = new Date(NOW)
    expect(date.getDay()).toBe(2)
    expect(inSchedule({ days: [2] }, NOW)).toBe(true)
    expect(inSchedule({ days: [0] }, NOW)).toBe(false)
  })

  it('respects overnight windows (22:00-06:00)', () => {
    const at = Date.parse('2026-08-05T03:00:00Z')
    expect(inSchedule({ start: '22:00', end: '06:00' }, at)).toBe(true)
    const noon = Date.parse('2026-08-05T12:00:00Z')
    expect(inSchedule({ start: '22:00', end: '06:00' }, noon)).toBe(false)
  })
})

describe('evaluateMonitor — motion', () => {
  it('fires an alert on motion', () => {
    const config = monitor([{ type: 'motion', sensitivity: 'med' }])
    const state = createMonitorState()
    const { alerts } = evaluateMonitor(config, state, ctx({ motionDetected: true }))
    expect(alerts).toHaveLength(1)
    expect(alerts[0].triggeredBy).toBe('motion')
  })

  it('respects cooldown', () => {
    const config = monitor([{ type: 'motion', sensitivity: 'med' }])
    const state = createMonitorState()
    evaluateMonitor(config, state, ctx({ motionDetected: true, now: NOW }))
    const later = evaluateMonitor(config, state, ctx({ motionDetected: true, now: NOW + 60_000 }))
    expect(later.alerts).toHaveLength(0)
    const afterCooldown = evaluateMonitor(config, state, ctx({ motionDetected: true, now: NOW + 121_000 }))
    expect(afterCooldown.alerts).toHaveLength(1)
  })
})

describe('evaluateMonitor — object', () => {
  it('fires when the object class is present', () => {
    const config = monitor([{ type: 'object', className: 'person', minConfidence: 0.4 }])
    const state = createMonitorState()
    const { alerts } = evaluateMonitor(config, state, ctx({ detections: [person] }))
    expect(alerts).toHaveLength(1)
    expect(alerts[0].triggeredBy).toBe('object:person')
    expect(alerts[0].confidence).toBe(0.92)
  })

  it('fires when present:false and the object is absent', () => {
    const config = monitor([{ type: 'object', className: 'car', present: false }])
    const state = createMonitorState()
    const { alerts } = evaluateMonitor(config, state, ctx({ detections: [] }))
    expect(alerts).toHaveLength(1)
    expect(alerts[0].description).toContain('ausente')
  })

  it('ignores detections below minConfidence', () => {
    const config = monitor([{ type: 'object', className: 'person', minConfidence: 0.95 }])
    const state = createMonitorState()
    const { alerts } = evaluateMonitor(config, state, ctx({ detections: [person] }))
    expect(alerts).toHaveLength(0)
  })
})

describe('evaluateMonitor — presence', () => {
  it('fires entered when someone appears', () => {
    const config = monitor([{ type: 'presence', className: 'person', event: 'entered' }])
    const state = createMonitorState()
    const { alerts } = evaluateMonitor(config, state, ctx({ detections: [person] }))
    expect(alerts).toHaveLength(1)
    expect(alerts[0].triggeredBy).toBe('presence:entered')
  })

  it('fires left when someone leaves after being present', () => {
    const config = monitor([{ type: 'presence', className: 'person', event: 'left' }])
    const state = createMonitorState()
    evaluateMonitor(config, state, ctx({ detections: [person], now: NOW }))
    const { alerts } = evaluateMonitor(config, state, ctx({ detections: [], now: NOW + 60_000 }))
    expect(alerts).toHaveLength(1)
    expect(alerts[0].triggeredBy).toBe('presence:left')
  })

  it('fires still_present after the window', () => {
    const config = monitor([{ type: 'presence', className: 'person', event: 'still_present', windowSec: 120 }])
    const state = createMonitorState()
    evaluateMonitor(config, state, ctx({ detections: [person], now: NOW }))
    const before = evaluateMonitor(config, state, ctx({ detections: [person], now: NOW + 60_000 }))
    expect(before.alerts).toHaveLength(0)
    const after = evaluateMonitor(config, state, ctx({ detections: [person], now: NOW + 121_000 }))
    expect(after.alerts).toHaveLength(1)
    expect(after.alerts[0].description).toContain('parado')
  })
})

describe('evaluateMonitor — scene', () => {
  it('marks the trigger as due on cadence', () => {
    const config = monitor([{ type: 'scene', question: 'tem um gato?', everySec: 30 }])
    const state = createMonitorState()
    const { sceneDue } = evaluateMonitor(config, state, ctx({}))
    expect(sceneDue).toHaveLength(1)
    expect(sceneDue[0].question).toBe('tem um gato?')
  })

  it('does not fire before everySec elapses', () => {
    const config = monitor([{ type: 'scene', question: 'x?', everySec: 300 }])
    const state = createMonitorState()
    evaluateMonitor(config, state, ctx({ now: NOW }))
    const again = evaluateMonitor(config, state, ctx({ now: NOW + 60_000 }))
    expect(again.sceneDue).toHaveLength(0)
  })
})

describe('applySceneAnswer', () => {
  it('fires after confirmN consecutive yes answers', () => {
    const config = monitor([{ type: 'scene', question: 'porta aberta?', onAnswer: 'yes', confirmN: 2 }])
    const state = createMonitorState()
    const first = applySceneAnswer(config, state, 0, 'yes', NOW)
    expect(first).toBeNull()
    const second = applySceneAnswer(config, state, 0, 'yes', NOW + 30_000)
    expect(second).not.toBeNull()
    expect(second!.triggeredBy).toBe('scene:0')
  })

  it('resets the counter on a non-matching answer', () => {
    const config = monitor([{ type: 'scene', question: 'x?', onAnswer: 'yes', confirmN: 2 }])
    const state = createMonitorState()
    applySceneAnswer(config, state, 0, 'yes', NOW)
    applySceneAnswer(config, state, 0, 'no', NOW + 30_000)
    const third = applySceneAnswer(config, state, 0, 'yes', NOW + 60_000)
    expect(third).toBeNull()
  })

  it('fires on change when onAnswer is change', () => {
    const config = monitor([{ type: 'scene', question: 'luz acesa?', onAnswer: 'change', confirmN: 1 }])
    const state = createMonitorState()
    applySceneAnswer(config, state, 0, 'yes', NOW)
    const changed = applySceneAnswer(config, state, 0, 'no', NOW + 30_000)
    expect(changed).not.toBeNull()
  })

  it('respects cooldown for repeated scene alerts', () => {
    const config = monitor([{ type: 'scene', question: 'x?', onAnswer: 'yes', confirmN: 1 }], { cooldownSec: 120 })
    const state = createMonitorState()
    applySceneAnswer(config, state, 0, 'yes', NOW)
    const within = applySceneAnswer(config, state, 0, 'yes', NOW + 60_000)
    expect(within).toBeNull()
    const after = applySceneAnswer(config, state, 0, 'yes', NOW + 121_000)
    expect(after).not.toBeNull()
  })
})

describe('evaluateMonitor — periodic', () => {
  it('is due on its cadence', () => {
    const config = monitor([{ type: 'periodic', everySec: 60, task: 'descreva' }])
    const state = createMonitorState()
    const { sceneDue } = evaluateMonitor(config, state, ctx({ now: NOW }))
    expect(sceneDue).toHaveLength(1)
    const again = evaluateMonitor(config, state, ctx({ now: NOW + 30_000 }))
    expect(again.sceneDue).toHaveLength(0)
  })
})
