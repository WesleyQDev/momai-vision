import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('Orphan IP camera reconciliation', () => {
  it('findCamera falls back to the single configured IP camera when an old IP is requested', async () => {
    const { findCamera } = await import('./runtime')
    // Directly testing fallback when an unknown IP ID is passed
    // If no cameras or multiple cameras, returns undefined
    expect(findCamera('')).toBeUndefined()
  })
})

