import { describe, it, expect } from 'vitest'
import { LatestWinsQueue, type DetectResult } from './detect-queue'
import type { Detection } from './triggers'

function det(tag: string): Detection {
  return { className: tag, confidence: 0.9, x1: 0, y1: 0, x2: 1, y2: 1, classId: 0 }
}

function result(tag: string): DetectResult {
  return { boxes: [det(tag)] }
}

function deferred() {
  let resolve!: (r: DetectResult) => void
  const promise = new Promise<DetectResult>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('LatestWinsQueue (drop-oldest / latest-wins)', () => {
  it('processes the first payload and resolves the caller', async () => {
    const q = new LatestWinsQueue()
    const runs: string[] = []
    const p = q.submit('a', async (payload) => {
      runs.push(payload)
      return result(payload)
    })
    const r = await p
    expect(r.boxes).toEqual([det('a')])
    expect(runs).toEqual(['a'])
    expect(q.isBusy()).toBe(false)
  })

  it('drops intermediate payloads while busy (latest-wins) and resolves all callers', async () => {
    const q = new LatestWinsQueue()
    const first = deferred()
    const runs: string[] = []

    // Caller A inicia a fila; a run fica pendurada em `first`.
    const pA = q.submit('a', async (payload) => {
      runs.push(payload)
      return first.promise
    })

    // Enquanto A está em voo, B e C chegam — B é substituído por C (drop-oldest).
    const pB = q.submit('b', async (payload) => {
      runs.push(payload)
      return result(payload)
    })
    const pC = q.submit('c', async (payload) => {
      runs.push(payload)
      return result(payload)
    })

    // Termina a run de A: todos os waiters (A, B, C) são resolvidos com o
    // resultado de A; o frame mais recente (C) é o próximo a rodar.
    first.resolve(result('a'))

    const results = await Promise.all([pA, pB, pC])
    expect(results.map((r) => r.boxes[0]?.className)).toEqual(['a', 'a', 'a'])
    // B nunca rodou (foi substituído por C) — a fila não processou payloads
    // stale em excesso.
    expect(runs).toEqual(['a', 'c'])
    await q.whenIdle()
    expect(q.isBusy()).toBe(false)
  })

  it('resolves callers with an error result when a run throws (no hung promises)', async () => {
    const q = new LatestWinsQueue()

    const pA = q.submit('a', async () => {
      throw new Error('engine exploded')
    })
    const pB = q.submit('b', async (payload) => result(payload))
    const pC = q.submit('c', async (payload) => result(payload))

    const results = await Promise.all([pA, pB, pC])
    // Todos os waiters são resolvidos com o resultado do run que completa a
    // seguir (o que falhou); o frame mais recente (c) ainda roda no dreno.
    expect(results[0].error).toBe('engine exploded')
    expect(results[1].error).toBe('engine exploded')
    expect(results[2].error).toBe('engine exploded')
    await q.whenIdle()
    expect(q.isBusy()).toBe(false)
  })

  it('never keeps more than one pending payload', async () => {
    const q = new LatestWinsQueue()
    const first = deferred()
    const runs: string[] = []

    const pA = q.submit('a', async (payload) => {
      runs.push(payload)
      return first.promise
    })
    for (let i = 0; i < 25; i++) {
      void q.submit(`payload-${i}`, async (payload) => {
        runs.push(payload)
        return result(payload)
      })
    }
    first.resolve(result('a'))
    await pA
    await new Promise((r) => setTimeout(r, 10))

    // Depois de A, apenas o ÚLTIMO payload pendente rodou — os 24 anteriores
    // foram descartados (drop-oldest): a fila não vira backlog.
    expect(runs[0]).toBe('a')
    expect(runs.slice(1)).toEqual(['payload-24'])
    await q.whenIdle()
    expect(q.isBusy()).toBe(false)
  })

  it('drains sequentially: next pending starts only after the current run settles', async () => {
    const q = new LatestWinsQueue()
    const gates: Array<() => void> = []
    const runs: string[] = []
    let active = 0
    let maxActive = 0

    const run = async (payload: string) => {
      active++
      maxActive = Math.max(maxActive, active)
      runs.push(payload)
      const gate = new Promise<void>((r) => gates.push(r))
      await gate
      active--
      return result(payload)
    }

    const pA = q.submit('a', run)
    const pB = q.submit('b', run)
    gates[0]()
    await pA
    gates[1]()
    await pB
    await q.whenIdle()

    expect(runs).toEqual(['a', 'b'])
    expect(maxActive).toBe(1)
    expect(q.isBusy()).toBe(false)
  })
})