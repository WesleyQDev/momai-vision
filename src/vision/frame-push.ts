/**
 * Serial frame push queue — one send in flight, latest frame wins.
 *
 * Preview frames are live: overlapping fire-and-forget sends can reach the
 * host out of order and an older frame lands after a newer one, making the
 * video step back before resuming. A single in-flight send plus a pending
 * slot that is overwritten preserves temporal order; frames that lose the
 * race are dropped instead of buffered (correct for a live preview).
 */

export interface FramePushQueue {
  push(frame: Uint8Array): void
  /** Drops any pending frame; an in-flight send still completes. */
  dispose(): void
  /** Resolves when no send is in flight and no frame is pending. */
  idle(): Promise<void>
}

export interface FramePushQueueOptions {
  send: (frame: Uint8Array) => Promise<void>
  /** Called when a pending frame is replaced by a newer one. */
  onDrop?: () => void
  /** Called when a send fails; the queue keeps draining. */
  onError?: (err: unknown) => void
}

export function createFramePushQueue(options: FramePushQueueOptions): FramePushQueue {
  let pending: Uint8Array | null = null
  let draining: Promise<void> | null = null
  let disposed = false

  const drain = async (): Promise<void> => {
    while (!disposed && pending) {
      const frame = pending
      pending = null
      try {
        await options.send(frame)
      } catch (err) {
        options.onError?.(err)
      }
    }
    draining = null
  }

  return {
    push(frame: Uint8Array): void {
      if (disposed) return
      if (pending) options.onDrop?.()
      pending = frame
      if (!draining) draining = drain()
    },
    dispose(): void {
      disposed = true
      pending = null
    },
    idle(): Promise<void> {
      return draining ?? Promise.resolve()
    }
  }
}
