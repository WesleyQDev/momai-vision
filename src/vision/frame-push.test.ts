import { describe, it, expect } from 'vitest'
import { createFramePushQueue } from './frame-push'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
const decode = (frame: Uint8Array): string => new TextDecoder().decode(frame)

function gatedSender(sent: string[]): { send: (frame: Uint8Array) => Promise<void>; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    send: async (frame: Uint8Array) => {
      sent.push(decode(frame))
      if (sent.length === 1) await gate
    },
    release
  }
}

describe('createFramePushQueue', () => {
  it('sends strictly in order while a send is still in flight', async () => {
    const sent: string[] = []
    const { send, release } = gatedSender(sent)
    const queue = createFramePushQueue({ send })

    queue.push(encode('a'))
    queue.push(encode('b'))
    expect(sent).toEqual(['a'])

    release()
    await queue.idle()
    expect(sent).toEqual(['a', 'b'])
  })

  it('keeps only the latest frame when frames arrive faster than the sender', async () => {
    const sent: string[] = []
    const { send, release } = gatedSender(sent)
    const drops: number[] = []
    const queue = createFramePushQueue({ send, onDrop: () => drops.push(1) })

    queue.push(encode('a'))
    queue.push(encode('b'))
    queue.push(encode('c'))
    release()
    await queue.idle()

    expect(sent).toEqual(['a', 'c'])
    expect(drops).toHaveLength(1)
  })

  it('keeps sending after a failed send and reports the error', async () => {
    const sent: string[] = []
    const errors: unknown[] = []
    const queue = createFramePushQueue({
      send: async (frame: Uint8Array) => {
        sent.push(decode(frame))
        if (decode(frame) === 'a') throw new Error('boom')
      },
      onError: (err) => errors.push(err)
    })

    queue.push(encode('a'))
    queue.push(encode('b'))
    await queue.idle()

    expect(sent).toEqual(['a', 'b'])
    expect(errors).toHaveLength(1)
  })

  it('ignores pushes after dispose', async () => {
    const sent: string[] = []
    const queue = createFramePushQueue({ send: async (frame: Uint8Array) => void sent.push(decode(frame)) })

    queue.push(encode('a'))
    await queue.idle()
    queue.dispose()
    queue.push(encode('b'))
    await queue.idle()

    expect(sent).toEqual(['a'])
  })
})
