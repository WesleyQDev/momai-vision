import { describe, expect, it } from 'vitest'
import {
  isPointInPolygon,
  isBoxInZone,
  filterDetectionsInZone,
  orderPointsClockwise,
  createBoxFromCorners,
  Point
} from './zone'

describe('zone geometry utilities', () => {
  // Rectangle in center: (0.2, 0.2) to (0.8, 0.8)
  const rectZone: Point[] = [
    { x: 0.2, y: 0.2 },
    { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.8 },
    { x: 0.2, y: 0.8 }
  ]

  // Triangle: (0.5, 0.1), (0.9, 0.9), (0.1, 0.9)
  const triangleZone: Point[] = [
    { x: 0.5, y: 0.1 },
    { x: 0.9, y: 0.9 },
    { x: 0.1, y: 0.9 }
  ]

  describe('isPointInPolygon', () => {
    it('returns true if polygon has fewer than 3 points (unconstrained)', () => {
      expect(isPointInPolygon({ x: 0.5, y: 0.5 }, [])).toBe(true)
      expect(isPointInPolygon({ x: 0.5, y: 0.5 }, [{ x: 0.1, y: 0.1 }])).toBe(true)
      expect(isPointInPolygon({ x: 0.5, y: 0.5 }, [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }])).toBe(true)
    })

    it('identifies points inside and outside a rectangle', () => {
      expect(isPointInPolygon({ x: 0.5, y: 0.5 }, rectZone)).toBe(true)
      expect(isPointInPolygon({ x: 0.3, y: 0.3 }, rectZone)).toBe(true)
      expect(isPointInPolygon({ x: 0.1, y: 0.5 }, rectZone)).toBe(false)
      expect(isPointInPolygon({ x: 0.9, y: 0.5 }, rectZone)).toBe(false)
      expect(isPointInPolygon({ x: 0.5, y: 0.1 }, rectZone)).toBe(false)
      expect(isPointInPolygon({ x: 0.5, y: 0.9 }, rectZone)).toBe(false)
    })

    it('identifies points inside and outside a triangle', () => {
      expect(isPointInPolygon({ x: 0.5, y: 0.5 }, triangleZone)).toBe(true)
      expect(isPointInPolygon({ x: 0.5, y: 0.8 }, triangleZone)).toBe(true)
      expect(isPointInPolygon({ x: 0.1, y: 0.1 }, triangleZone)).toBe(false)
      expect(isPointInPolygon({ x: 0.9, y: 0.1 }, triangleZone)).toBe(false)
      expect(isPointInPolygon({ x: 0.5, y: 0.05 }, triangleZone)).toBe(false)
    })
  })

  describe('isBoxInZone', () => {
    it('returns true if zone is null, empty or < 3 points', () => {
      const box = { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 }
      expect(isBoxInZone(box, null)).toBe(true)
      expect(isBoxInZone(box, undefined)).toBe(true)
      expect(isBoxInZone(box, [])).toBe(true)
    })

    it('detects box completely inside rectangle zone', () => {
      const box = { x1: 0.3, y1: 0.3, x2: 0.5, y2: 0.5 }
      expect(isBoxInZone(box, rectZone)).toBe(true)
    })

    it('detects box partially overlapping rectangle zone', () => {
      // Crosses left edge
      const box = { x1: 0.1, y1: 0.3, x2: 0.4, y2: 0.5 }
      expect(isBoxInZone(box, rectZone)).toBe(true)
    })

    it('rejects box completely outside rectangle zone', () => {
      const box = { x1: 0.01, y1: 0.01, x2: 0.15, y2: 0.15 }
      expect(isBoxInZone(box, rectZone)).toBe(false)
    })

    it('detects box encompassing a polygon vertex', () => {
      const bigBoxOutside = { x1: 0.15, y1: 0.15, x2: 0.25, y2: 0.25 }
      // The vertex (0.2, 0.2) is inside the box
      expect(isBoxInZone(bigBoxOutside, rectZone)).toBe(true)
    })
  })

  describe('filterDetectionsInZone', () => {
    it('filters out detections outside the zone', () => {
      const detections = [
        { className: 'person', confidence: 0.9, x1: 0.4, y1: 0.4, x2: 0.6, y2: 0.6 },
        { className: 'car', confidence: 0.85, x1: 0.01, y1: 0.01, x2: 0.1, y2: 0.1 },
        { className: 'dog', confidence: 0.75, x1: 0.3, y1: 0.3, x2: 0.4, y2: 0.5 }
      ]
      const filtered = filterDetectionsInZone(detections, rectZone)
      expect(filtered).toHaveLength(2)
      expect(filtered.map((d) => d.className)).toEqual(['person', 'dog'])
    })

    it('returns all detections when zone is undefined or < 3 points', () => {
      const detections = [
        { className: 'person', confidence: 0.9, x1: 0.01, y1: 0.01, x2: 0.1, y2: 0.1 }
      ]
      expect(filterDetectionsInZone(detections, undefined)).toEqual(detections)
      expect(filterDetectionsInZone(detections, [])).toEqual(detections)
    })
  })

  describe('orderPointsClockwise', () => {
    it('orders four out-of-order points so lines never cross into an X', () => {
      // Out of order: (0,0), (1,0), (0,1), (1,1) -> (1,0) to (0,1) crosses diagonals
      const unordered: Point[] = [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.1, y: 0.9 },
        { x: 0.9, y: 0.9 }
      ]
      const ordered = orderPointsClockwise(unordered)
      // Check that adjacent pairs are adjacent perimeter sides, not diagonals
      expect(ordered).toHaveLength(4)
      const xs = ordered.map((p) => p.x)
      const ys = ordered.map((p) => p.y)
      // Consecutive points must not jump diagonally across center
      for (let i = 0; i < 4; i++) {
        const next = (i + 1) % 4
        const dist = Math.hypot(ordered[i].x - ordered[next].x, ordered[i].y - ordered[next].y)
        // Diagonal distance is ~1.13, side distance is 0.8
        expect(dist).toBeLessThan(1.0)
      }
    })
  })

  describe('createBoxFromCorners', () => {
    it('creates 4 corners in clockwise order from diagonal drag', () => {
      const box = createBoxFromCorners({ x: 0.8, y: 0.9 }, { x: 0.2, y: 0.3 })
      expect(box).toEqual([
        { x: 0.2, y: 0.3 },
        { x: 0.8, y: 0.3 },
        { x: 0.8, y: 0.9 },
        { x: 0.2, y: 0.9 }
      ])
    })
  })
})
