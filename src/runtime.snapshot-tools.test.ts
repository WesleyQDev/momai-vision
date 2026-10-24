import { describe, expect, it } from 'vitest'
import { buildSnapshotCard, resolveSnapshotForShow, type SnapshotMeta } from './runtime'

const snapshots: SnapshotMeta[] = [
  { id: 'snap-old', cameraId: 'cam-a', ts: 1000 },
  { id: 'snap-new', cameraId: 'cam-a', ts: 3000 },
  { id: 'snap-b', cameraId: 'cam-b', ts: 2000 }
]

describe('resolveSnapshotForShow', () => {
  it('picks the explicit snapshot id', () => {
    expect(resolveSnapshotForShow(snapshots, { snapshotId: 'snap-b' })?.id).toBe('snap-b')
  })

  it('picks the newest snapshot of the requested camera', () => {
    expect(resolveSnapshotForShow(snapshots, { cameraId: 'cam-a' })?.id).toBe('snap-new')
  })

  it('falls back to the newest snapshot overall', () => {
    expect(resolveSnapshotForShow(snapshots, {})?.id).toBe('snap-new')
  })

  it('returns null for an unknown id or camera', () => {
    expect(resolveSnapshotForShow(snapshots, { snapshotId: 'missing' })).toBeNull()
    expect(resolveSnapshotForShow(snapshots, { cameraId: 'cam-z' })).toBeNull()
    expect(resolveSnapshotForShow([], {})).toBeNull()
  })
})

describe('buildSnapshotCard', () => {
  it('marks the card as a print without a monitor', () => {
    const card = buildSnapshotCard({
      snapshotId: 'snap-1',
      cameraId: 'cam-1',
      cameraName: 'Entrada',
      ts: 123
    })

    expect(card.type).toBe('vision_alert')
    expect(card.data).toMatchObject({
      snapshotId: 'snap-1',
      cameraId: 'cam-1',
      cameraName: 'Entrada',
      triggeredBy: 'snapshot'
    })
    // A manual print has no monitoring behind it: the panel must not offer a
    // pause action for a monitorId that does not exist.
    expect('monitorId' in card.data).toBe(false)
  })

  it('does not invent a caption or an image', () => {
    const card = buildSnapshotCard({ snapshotId: 'snap-1', cameraId: 'cam-1', ts: 123 })
    expect(card.data.description).toBeUndefined()
    expect(card.data.imageDataUri).toBeUndefined()
    expect(card.data.cameraName).toBe('cam-1')
  })

  it('keeps an explicit caption and image', () => {
    const card = buildSnapshotCard({
      snapshotId: 'snap-1',
      cameraId: 'cam-1',
      cameraName: 'Entrada',
      ts: 123,
      description: 'Print da entrada',
      imageDataUri: 'data:image/jpeg;base64,AAA'
    })
    expect(card.data.description).toBe('Print da entrada')
    expect(card.data.imageDataUri).toBe('data:image/jpeg;base64,AAA')
  })
})
