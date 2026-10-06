/**
 * Benchmark: image embedding cost for vision alerts.
 *
 * Compares the header-only fast path (frames already <= 640px) against the old
 * full decode path, and measures the payload reduction for a 1080p frame.
 *
 * Run from the momai repo:
 *   pnpm --filter @momai/server exec tsx "<path>/bench-embed-image.mts"
 */
import { encode, decode } from 'jpeg-js'
import { annotateJpegWithBoxes, readJpegWidth, resizeJpegBase64 } from '../../src/runtime'

function makeJpeg(width: number, height: number): string {
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = (x * 7) % 255
      data[i + 1] = (y * 5) % 255
      data[i + 2] = 60
      data[i + 3] = 255
    }
  }
  return Buffer.from(encode({ data, width, height }, 85).data).toString('base64')
}

const small = makeJpeg(640, 480)
const big = makeJpeg(1920, 1080)
const ITERATIONS = 50

function measure(fn: () => void): { meanMs: number; totalMs: number } {
  const start = performance.now()
  for (let i = 0; i < ITERATIONS; i += 1) fn()
  const totalMs = performance.now() - start
  return { meanMs: totalMs / ITERATIONS, totalMs }
}

// Header-only width read (the new fast path for small frames)
const header = measure(() => {
  readJpegWidth(small)
})

// Old behavior for a small frame: full decode just to discover the width
const oldDecode = measure(() => {
  const jpeg = Buffer.from(small, 'base64')
  decode(new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength), {
    useTArray: true,
    maxMemoryUsageInMB: 128
  })
})

// New resize call on a small frame (must return the original untouched)
const newSmall = measure(() => {
  resizeJpegBase64(small)
})

// Large frame: full path (decode + nearest-neighbor resize + encode)
const bigStart = performance.now()
const resizedBig = resizeJpegBase64(big)
const bigMs = performance.now() - bigStart

const fullBytes = Buffer.from(big, 'base64').length
const resizedBytes = resizedBig ? Buffer.from(resizedBig, 'base64').length : 0

// Annotated-image flow for a 1080p frame with boxes.
const boxes = [{ className: 'person', confidence: 0.9, x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5 }]
const oldAnnotateStart = performance.now()
const annotatedFull = annotateJpegWithBoxes(big, boxes)
const resizedAnnotated = annotatedFull ? resizeJpegBase64(annotatedFull) : null
const oldAnnotateMs = performance.now() - oldAnnotateStart

const newAnnotateStart = performance.now()
const smallSource = resizeJpegBase64(big) || big
const annotatedSmall = annotateJpegWithBoxes(smallSource, boxes)
const newAnnotateMs = performance.now() - newAnnotateStart

console.log(
  JSON.stringify(
    {
      iterations: ITERATIONS,
      smallFrame: {
        bytes: Buffer.from(small, 'base64').length,
        headerReadMs: Number(header.meanMs.toFixed(4)),
        oldDecodeMs: Number(oldDecode.meanMs.toFixed(3)),
        newResizeMs: Number(newSmall.meanMs.toFixed(4)),
        speedupVsOldDecode: Number((oldDecode.meanMs / Math.max(newSmall.meanMs, 0.0001)).toFixed(1))
      },
      largeFrame: {
        fullBytes,
        resizedBytes,
        payloadReductionPercent: Number((100 - (resizedBytes / fullBytes) * 100).toFixed(1)),
        resizeMs: Number(bigMs.toFixed(2))
      },
      annotated1080p: {
        oldFlowMs: Number(oldAnnotateMs.toFixed(2)),
        newFlowMs: Number(newAnnotateMs.toFixed(2)),
        savedMs: Number((oldAnnotateMs - newAnnotateMs).toFixed(2)),
        annotatedBytes: annotatedSmall ? Buffer.from(annotatedSmall, 'base64').length : 0,
        resizedAnnotatedBytes: resizedAnnotated ? Buffer.from(resizedAnnotated, 'base64').length : 0
      }
    },
    null,
    2
  )
)
