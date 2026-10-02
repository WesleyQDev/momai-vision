import { describe, expect, it } from 'vitest'
import { shouldKeepWebcamWatch } from './runtime'

const PREVIEW = 'webcam:test-cam'

describe('shouldKeepWebcamWatch (USB preview without monitors)', () => {
  it('keeps a selected and unpaused preview alive', () => {
    expect(shouldKeepWebcamWatch(PREVIEW, new Set(), [PREVIEW], [])).toBe(true)
  })

  it('stops the watch once the camera is deselected', () => {
    expect(shouldKeepWebcamWatch(PREVIEW, new Set(), [], [])).toBe(false)
  })

  it('stops the watch while the preview is paused', () => {
    expect(shouldKeepWebcamWatch(PREVIEW, new Set(), [PREVIEW], [PREVIEW])).toBe(false)
  })

  it('keeps a monitored camera even when it is not selected', () => {
    expect(shouldKeepWebcamWatch(PREVIEW, new Set([PREVIEW]), [], [])).toBe(true)
  })
})
