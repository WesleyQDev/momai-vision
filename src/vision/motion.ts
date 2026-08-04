/**
 * Cheap motion gate in pure JS — no OpenCV needed.
 *
 * Downscales the frame to a coarse grid (block averages) and compares it to
 * a baseline. Runs in ~1ms so it can gate the expensive YOLO/scene stages.
 */

export type Sensitivity = 'low' | 'med' | 'high'

const GRID_W = 40
const GRID_H = 30

const THRESHOLDS: Record<Sensitivity, number> = {
  low: 14,
  med: 9,
  high: 5
}

export interface MotionOptions {
  sensitivity?: Sensitivity
  minArea?: number // min blocks above threshold (default 3)
}

export class MotionGate {
  private baseline: Float32Array | null = null

  reset(): void {
    this.baseline = null
  }

  /**
   * Returns true when the frame differs from the previous one beyond the
   * configured sensitivity. Caller feeds grayscale-ish block averages.
   */
  check(rgb: Uint8Array, width: number, height: number, options: MotionOptions = {}): boolean {
    const threshold = THRESHOLDS[options.sensitivity || 'med']
    const minArea = options.minArea ?? 3
    const blocks = this.toGrid(rgb, width, height)
    if (!this.baseline) {
      this.baseline = blocks
      return false
    }
    const prev = this.baseline
    let changed = 0
    for (let i = 0; i < blocks.length; i++) {
      if (Math.abs(blocks[i] - prev[i]) > threshold) changed++
    }
    this.baseline = blocks
    return changed >= minArea
  }

  private toGrid(rgb: Uint8Array, width: number, height: number): Float32Array {
    const grid = new Float32Array(GRID_W * GRID_H)
    const bw = Math.max(1, Math.floor(width / GRID_W))
    const bh = Math.max(1, Math.floor(height / GRID_H))
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        let sum = 0
        let count = 0
        for (let y = gy * bh; y < (gy + 1) * bh && y < height; y++) {
          for (let x = gx * bw; x < (gx + 1) * bw && x < width; x++) {
            const i = (y * width + x) * 3
            sum += rgb[i] + rgb[i + 1] + rgb[i + 2]
            count++
          }
        }
        grid[gy * GRID_W + gx] = count > 0 ? sum / (count * 3) : 0
      }
    }
    return grid
  }
}
