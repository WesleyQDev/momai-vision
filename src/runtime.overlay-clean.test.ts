import { describe, it, expect } from 'vitest'
import { resolveOverlayBoxes } from './runtime'

const sampleBoxes = [{ className: 'person', confidence: 0.88, x1: 0.4, y1: 0.3, x2: 0.5, y2: 0.6 }]

describe('resolveOverlayBoxes — overlay limpo por padrao', () => {
  it('retorna vazio por padrao mesmo com boxes no ultimo alerta', () => {
    expect(resolveOverlayBoxes(undefined, sampleBoxes, {})).toEqual([])
  })

  it('inclui boxes do alerta quando includeBoxes e true', () => {
    expect(resolveOverlayBoxes(undefined, sampleBoxes, { includeBoxes: true })).toEqual(sampleBoxes)
  })
})
