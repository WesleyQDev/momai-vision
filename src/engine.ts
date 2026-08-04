/**
 * MomAI Vision — CV engine process.
 *
 * Runs OUTSIDE the extension worker sandbox (spawned by runtime.js as a
 * sidecar, the same pattern node-core uses for its own subprocesses), so it
 * can use onnxruntime-web WASM with normal Node.js access. All model files
 * live inside the extension bundle (dist/cv, dist/models).
 *
 * Protocol (IPC messages with the parent worker):
 *   in:  { type: 'detect', id, pixelsBase64, width, height, confThreshold }
 *   out: { type: 'detect-result', id, boxes, ms }
 *   in:  { type: 'shutdown' }
 */

import * as ort from 'onnxruntime-web'
import { decode } from 'jpeg-js'
import path from 'node:path'
import fs from 'node:fs'

const ENGINE_DIR = __dirname
const MODEL_PATH = path.join(ENGINE_DIR, '..', 'models', 'yolo11n.onnx')
const WASM_PATH = path.join(ENGINE_DIR, 'ort-wasm-simd-threaded.wasm')

const INPUT_W = 640
const INPUT_H = 480

const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
  'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
  'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
  'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
  'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
  'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
  'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator',
  'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush'
]

let session: ort.InferenceSession | null = null
let sessionPromise: Promise<ort.InferenceSession> | null = null

function ensureSession(): Promise<ort.InferenceSession> {
  if (session) return Promise.resolve(session)
  if (!sessionPromise) {
    ort.env.wasm.numThreads = 1
    ort.env.wasm.wasmBinary = fs.readFileSync(WASM_PATH)
    sessionPromise = ort.InferenceSession.create(fs.readFileSync(MODEL_PATH), {
      executionProviders: ['wasm']
    }).then((s) => {
      session = s
      return s
    })
  }
  return sessionPromise
}

function letterbox(
  rgb: Uint8Array,
  width: number,
  height: number
): { data: Float32Array; scale: number; padX: number; padY: number } {
  const scale = Math.min(INPUT_W / width, INPUT_H / height)
  const newW = Math.round(width * scale)
  const newH = Math.round(height * scale)
  const padX = Math.floor((INPUT_W - newW) / 2)
  const padY = Math.floor((INPUT_H - newH) / 2)

  const plane = INPUT_H * INPUT_W
  const data = new Float32Array(3 * plane).fill(114 / 255)
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const sx = Math.min(Math.floor(x / scale), width - 1)
      const sy = Math.min(Math.floor(y / scale), height - 1)
      // jpeg-js decodes to RGBA (stride 4).
      const sIdx = (sy * width + sx) * 4
      const dstIdx = (padY + y) * INPUT_W + padX + x
      // NCHW planar layout: all R, then all G, then all B.
      data[dstIdx] = rgb[sIdx] / 255
      data[plane + dstIdx] = rgb[sIdx + 1] / 255
      data[2 * plane + dstIdx] = rgb[sIdx + 2] / 255
    }
  }
  return { data, scale, padX, padY }
}

function nms(boxes: Array<{ x1: number; y1: number; x2: number; y2: number; score: number; classId: number }>, iouThreshold: number) {
  const sorted = boxes.slice().sort((a, b) => b.score - a.score)
  const picked: typeof sorted = []
  for (const box of sorted) {
    let keep = true
    for (const p of picked) {
      if (box.classId !== p.classId) continue
      const ix1 = Math.max(box.x1, p.x1)
      const iy1 = Math.max(box.y1, p.y1)
      const ix2 = Math.min(box.x2, p.x2)
      const iy2 = Math.min(box.y2, p.y2)
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1)
      const union = (box.x2 - box.x1) * (box.y2 - box.y1) + (p.x2 - p.x1) * (p.y2 - p.y1) - inter
      if (union > 0 && inter / union > iouThreshold) {
        keep = false
        break
      }
    }
    if (keep) picked.push(box)
  }
  return picked
}

function parseOutput(
  output: Float32Array,
  stride: number,
  width: number,
  height: number,
  scale: number,
  padX: number,
  padY: number,
  confThreshold: number
) {
  const boxes: Array<{ x1: number; y1: number; x2: number; y2: number; score: number; classId: number }> = []
  // Tensor [1, 84, N] is channel-major: row c has stride N. Rows 0-3 are
  // cx,cy,w,h (pixels); rows 4-83 are the 80 COCO class scores — the
  // ultralytics export already applies sigmoid to them.
  for (let i = 0; i < stride; i++) {
    const cx = output[i]
    const cy = output[stride + i]
    const w = output[2 * stride + i]
    const h = output[3 * stride + i]
    let bestClass = -1
    let bestScore = 0
    for (let c = 0; c < 80; c++) {
      const s = output[(4 + c) * stride + i]
      if (s > bestScore) {
        bestScore = s
        bestClass = c
      }
    }
    if (bestScore < confThreshold) continue
    // letterbox inverse
    const x1 = (cx - w / 2 - padX) / scale
    const y1 = (cy - h / 2 - padY) / scale
    const x2 = (cx + w / 2 - padX) / scale
    const y2 = (cy + h / 2 - padY) / scale
    boxes.push({
      x1: Math.max(0, x1 / width),
      y1: Math.max(0, y1 / height),
      x2: Math.min(1, Math.max(0, x2 / width)),
      y2: Math.min(1, Math.max(0, y2 / height)),
      score: bestScore,
      classId: bestClass
    })
  }
  return nms(boxes, 0.45)
}

async function detect(pixelsBase64: string, width: number, height: number, confThreshold: number) {
  const s = await ensureSession()
  const rgb = Buffer.from(pixelsBase64, 'base64')
  const { data, scale, padX, padY } = letterbox(new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.byteLength), width, height)
  const feeds: Record<string, ort.Tensor> = {}
  feeds[s.inputNames[0]] = new ort.Tensor('float32', data, [1, 3, INPUT_H, INPUT_W])
  const results = await s.run(feeds)
  const outName = Object.keys(results)[0]
  const output = results[outName].data as Float32Array
  const stride = Math.floor(output.length / 84)
  const boxes = parseOutput(output, stride, width, height, scale, padX, padY, confThreshold)
  return boxes.map((b) => ({
    x1: b.x1,
    y1: b.y1,
    x2: b.x2,
    y2: b.y2,
    confidence: Math.round(b.score * 1000) / 1000,
    classId: b.classId,
    className: COCO_CLASSES[b.classId] || 'unknown'
  }))
}

function decodeJpeg(jpegBase64: string): { pixels: Buffer; width: number; height: number } {
  const jpeg = Buffer.from(jpegBase64, 'base64')
  const raw = decode(new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength), { useTArray: true, maxMemoryUsageInMB: 256 })
  return { pixels: Buffer.from(raw.data), width: raw.width, height: raw.height }
}

process.on('message', async (msg: unknown) => {
  if (!msg || typeof msg !== 'object') return
  const message = msg as { type?: string; id?: string }
  if (message.type === 'detect') {
    const m = message as { type: 'detect'; id: string; jpegBase64: string; confThreshold?: number }
    const id = m.id
    try {
      const { pixels, width, height } = decodeJpeg(m.jpegBase64)
      const t0 = Date.now()
      const boxes = await detect(pixels.toString('base64'), width, height, Number(m.confThreshold) || 0.25)
      process.send?.({ type: 'detect-result', id, boxes, ms: Date.now() - t0 })
    } catch (err) {
      process.send?.({ type: 'detect-result', id, error: err instanceof Error ? err.message : String(err) })
    }
    return
  }
  if (message.type === 'shutdown') {
    process.exit(0)
  }
})

// If the parent worker dies, the IPC channel closes — exit instead of
// leaking an orphaned process.
process.on('disconnect', () => {
  process.exit(0)
})

process.send?.({ type: 'ready' })
