/**
 * Region of Interest (ROI) / Detection Zone geometry utilities.
 * Coordinates are normalized from 0.0 to 1.0 relative to video dimensions.
 */

export interface Point {
  x: number
  y: number
}

export interface BoundingBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * Standard Ray Casting algorithm to test if a point is inside a polygon.
 * Returns true if inside or on edge.
 */
export function isPointInPolygon(point: Point, polygon: Point[]): boolean {
  if (!polygon || polygon.length < 3) return true

  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x
    const yi = polygon[i].y
    const xj = polygon[j].x
    const yj = polygon[j].y

    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi || 1e-9) + xi

    if (intersect) inside = !inside
  }

  return inside
}

/**
 * Checks if a bounding box intersects or lies inside the polygon zone.
 * If polygon has fewer than 3 points, it's considered unconstrained (returns true).
 */
export function isBoxInZone(box: BoundingBox, polygon?: Point[] | null): boolean {
  if (!polygon || polygon.length < 3) return true

  // 1. Center of the box
  const cx = (box.x1 + box.x2) / 2
  const cy = (box.y1 + box.y2) / 2
  if (isPointInPolygon({ x: cx, y: cy }, polygon)) return true

  // 2. Bottom center (ground contact point for people, vehicles, pets)
  const bx = cx
  const by = box.y2
  if (isPointInPolygon({ x: bx, y: by }, polygon)) return true

  // 3. Any corner of the box
  if (isPointInPolygon({ x: box.x1, y: box.y1 }, polygon)) return true
  if (isPointInPolygon({ x: box.x2, y: box.y1 }, polygon)) return true
  if (isPointInPolygon({ x: box.x1, y: box.y2 }, polygon)) return true
  if (isPointInPolygon({ x: box.x2, y: box.y2 }, polygon)) return true

  // 4. Any polygon vertex inside the box
  for (const vertex of polygon) {
    if (
      vertex.x >= box.x1 &&
      vertex.x <= box.x2 &&
      vertex.y >= box.y1 &&
      vertex.y <= box.y2
    ) {
      return true
    }
  }

  return false
}

/**
 * Filter an array of detections, keeping only those within the polygon zone.
 */
export function filterDetectionsInZone<T extends BoundingBox>(
  detections: T[],
  polygon?: Point[] | null
): T[] {
  if (!polygon || polygon.length < 3) return detections
  return detections.filter((d) => isBoxInZone(d, polygon))
}

/**
 * Sorts points radially around their centroid (clockwise).
 * Ensures that points forming a polygon (including 4-point quadrilaterals) never cross or form an "X".
 */
export function orderPointsClockwise(points: Point[]): Point[] {
  if (points.length <= 2) return points
  const cx = points.reduce((acc, p) => acc + p.x, 0) / points.length
  const cy = points.reduce((acc, p) => acc + p.y, 0) / points.length
  return [...points].sort((a, b) => {
    const angleA = Math.atan2(a.y - cy, a.x - cx)
    const angleB = Math.atan2(b.y - cy, b.x - cx)
    return angleA - angleB
  })
}

/**
 * Creates 4 corner points in clockwise order from a diagonal drag (start to end).
 */
export function createBoxFromCorners(p1: Point, p2: Point): Point[] {
  const x1 = Math.min(p1.x, p2.x)
  const y1 = Math.min(p1.y, p2.y)
  const x2 = Math.max(p1.x, p2.x)
  const y2 = Math.max(p1.y, p2.y)
  return [
    { x: Number(x1.toFixed(4)), y: Number(y1.toFixed(4)) },
    { x: Number(x2.toFixed(4)), y: Number(y1.toFixed(4)) },
    { x: Number(x2.toFixed(4)), y: Number(y2.toFixed(4)) },
    { x: Number(x1.toFixed(4)), y: Number(y2.toFixed(4)) }
  ]
}
