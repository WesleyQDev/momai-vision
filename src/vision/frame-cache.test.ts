// @vitest-environment jsdom
/**
 * Last-frame cache for camera cards.
 *
 * Opening/closing MomAI or switching tabs remounts the cards: the cached frame
 * shows immediately while the card waits for the live stream (reload spinner).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  readCachedFrame,
  storeCachedFrame,
  clearCachedFrame,
  shouldCaptureFrameCache,
  resetFrameCacheThrottle,
  FRAME_CACHE_THROTTLE_MS
} from './frame-cache'

const CAM = 'ip:rtsp://192.168.0.2:554/onvif2'
const JPEG = 'data:image/jpeg;base64,AAAA'

describe('frame cache', () => {
  beforeEach(() => {
    localStorage.clear()
    resetFrameCacheThrottle()
  })

  it('stores and reads the last frame per camera', () => {
    storeCachedFrame(CAM, JPEG)

    expect(readCachedFrame(CAM)).toBe(JPEG)
    expect(readCachedFrame('webcam:x')).toBeNull()
  })

  it('ignores values that are not image data urls', () => {
    localStorage.setItem('momai-vision:lastframe:webcam:x', 'not-an-image')

    expect(readCachedFrame('webcam:x')).toBeNull()
  })

  it('throttles captures to one per window', () => {
    const now = 1_000_000

    expect(shouldCaptureFrameCache(CAM, now)).toBe(true)
    expect(shouldCaptureFrameCache(CAM, now + FRAME_CACHE_THROTTLE_MS - 1)).toBe(false)
    expect(shouldCaptureFrameCache(CAM, now + FRAME_CACHE_THROTTLE_MS)).toBe(true)
  })

  it('clears a camera frame', () => {
    storeCachedFrame(CAM, JPEG)

    clearCachedFrame(CAM)

    expect(readCachedFrame(CAM)).toBeNull()
  })

  it('never throws when storage is unavailable or full', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })

    expect(() => storeCachedFrame(CAM, JPEG)).not.toThrow()
    expect(localStorage.getItem('momai-vision:lastframe:' + CAM)).toBeNull()

    setItem.mockRestore()
  })
})
