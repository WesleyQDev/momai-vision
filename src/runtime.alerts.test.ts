/**
 * Testes das correções do histórico de alertas (C1/M3):
 *  - buildPersistedAlert NUNCA inclui imageDataUri (a imagem full-res no
 *    storage estourava a quota de 1MB do bridge);
 *  - resizeJpegBase64 limita a largura das imagens embutidas em payloads.
 */
import { describe, it, expect } from 'vitest'
import { encode, decode } from 'jpeg-js'
import { buildPersistedAlert, resizeJpegBase64 } from './runtime'
import type { MonitorConfig } from './vision/triggers'

const NOW = Date.parse('2026-08-04T12:00:00Z')

const config: MonitorConfig = {
  id: 'mon-1',
  cameraId: 'webcam:cam',
  cameraName: 'Garagem',
  triggers: [{ type: 'motion' }],
  createdAt: NOW
}

const alert = {
  triggeredBy: 'motion',
  monitorId: 'mon-1',
  monitorLabel: 'Garagem',
  cameraId: 'webcam:cam',
  cameraName: 'Garagem',
  description: 'Movimento detectado',
  ts: NOW,
  boxes: [{ className: 'person', confidence: 0.9, x1: 0, y1: 0, x2: 1, y2: 1, classId: 0 }]
}

function makeJpeg(width: number, height: number): string {
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const gradient = (x / width) * 255
      data[i] = gradient
      data[i + 1] = 128
      data[i + 2] = 255 - gradient
      data[i + 3] = 255
    }
  }
  return Buffer.from(encode({ data, width, height }, 85).data).toString('base64')
}

describe('buildPersistedAlert (histórico de alertas sem imageDataUri)', () => {
  it('não persiste imageDataUri — só snapshotId + metadados', () => {
    const entry = buildPersistedAlert(config, alert, 'snap-123', 'Movimento detectado', undefined)
    expect(entry.snapshotId).toBe('snap-123')
    expect('imageDataUri' in entry).toBe(false)
    expect(entry.cameraId).toBe('webcam:cam')
    expect(entry.triggeredBy).toBe('motion')
  })

  it('mantém os boxes para o overlay desenhar', () => {
    const entry = buildPersistedAlert(config, alert, undefined, 'Movimento detectado', undefined)
    expect(entry.boxes).toHaveLength(1)
    expect(entry.boxes![0].className).toBe('person')
  })

  it('serializa para JSON bem abaixo da quota de 1MB', () => {
    const entry = buildPersistedAlert(config, alert, 'snap-123', 'Movimento detectado', [
      { id: 'a1', target: 'whatsapp', tool: 'send_message', args: { contact: 'Ana' } }
    ])
    expect(JSON.stringify(entry).length).toBeLessThan(1024 * 1024)
  })
})

describe('resizeJpegBase64 (M3 — imagens embutidas em payloads)', () => {
  it('reduz um frame grande para no máximo 640px de largura', () => {
    const big = makeJpeg(1920, 1080)
    const resized = resizeJpegBase64(big)
    expect(resized).toBeTruthy()
    expect(resized!.length).toBeLessThan(big.length)
    const jpeg = Buffer.from(resized!, 'base64')
    const raw = decode(new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength), { useTArray: true })
    expect(raw.width).toBeLessThanOrEqual(640)
    expect(raw.height).toBeLessThanOrEqual(480)
  })

  it('deixa frames já pequenos intactos (sem re-encode)', () => {
    const small = makeJpeg(320, 240)
    expect(resizeJpegBase64(small)).toBe(small)
  })

  it('retorna null para entrada inválida', () => {
    expect(resizeJpegBase64('not-a-jpeg')).toBeNull()
  })
})