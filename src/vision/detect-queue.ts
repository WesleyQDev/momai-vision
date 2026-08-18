/**
 * Latest-wins per-camera detection queue (pure, testable).
 *
 * While a detection is running, new payloads REPLACE the pending one
 * (drop-oldest): the queue never holds more than a single pending frame, so a
 * burst of frames during an engine load / slow inference cannot accumulate a
 * backlog. Every caller is resolved (never hangs); waiters are resolved with
 * the result of the detection that completes next.
 */

import type { Detection } from './triggers'

export interface DetectResult {
  boxes: Detection[]
  ms?: number
  error?: string
}

export class LatestWinsQueue {
  private busy = false
  private pending: string | null = null
  private waiters: Array<(r: DetectResult) => void> = []
  private drainPromise: Promise<void> | null = null

  /** True while a run is in flight (or a drain is scheduled). */
  isBusy(): boolean {
    return this.busy
  }

  /**
   * Resolve quando o dreno terminar (busy = false e sem frame pendente).
   * Útil para testes / shutdown aguardarem a fila esvaziar.
   */
  async whenIdle(): Promise<void> {
    while (this.drainPromise) {
      await this.drainPromise
    }
  }

  /**
   * Submits a payload. If the queue is busy the payload replaces the pending
   * one (latest-wins); the returned promise resolves when the next detection
   * completes. The first caller triggers the drain loop.
   */
  submit(payload: string, run: (payload: string) => Promise<DetectResult>): Promise<DetectResult> {
    const own = new Promise<DetectResult>((resolve) => {
      this.waiters.push(resolve)
    })
    this.pending = payload
    if (!this.busy) {
      this.busy = true
      this.drainPromise = this.drain(run).finally(() => {
        this.drainPromise = null
      })
    }
    return own
  }

  private async drain(run: (payload: string) => Promise<DetectResult>): Promise<void> {
    let current: string | null = this.pending
    this.pending = null
    try {
      while (current !== null) {
        let result: DetectResult
        try {
          result = await run(current)
        } catch (err) {
          result = { boxes: [], error: err instanceof Error ? err.message : String(err) }
        }
        const waiters = this.waiters.splice(0)
        for (const w of waiters) w(result)
        // Síncrono a partir daqui até o fim do loop/finally: nenhum await
        // entre este check e `this.busy = false`, então um novo submit não
        // pode chegar no meio (JS não intercala dentro de bloco síncrono).
        current = this.pending
        this.pending = null
      }
    } finally {
      this.busy = false
    }
  }
}