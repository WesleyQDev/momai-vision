type IpcMessage = {
  type?: string
  requestId?: string
  method?: string
  args?: unknown[]
  result?: { ok?: boolean; value?: unknown; error?: string; errorCode?: string }
}

type SendFn = (msg: unknown) => void
type OnResponseFn = (fn: (msg: IpcMessage) => void) => void

type PendingEntry = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type StorageBridge = {
  storageDir: string
  get: (key: string, opts?: unknown) => Promise<unknown>
  set: (key: string, value: unknown, opts?: unknown) => Promise<void>
  getMany?: (...args: unknown[]) => Promise<unknown>
  setMany?: (...args: unknown[]) => Promise<unknown>
  delete?: (key: string, opts?: unknown) => Promise<void>
  listKeys?: (...args: unknown[]) => Promise<unknown>
  migrate?: (...args: unknown[]) => Promise<unknown>
}

export type VisionCollectionsBridge = {
  insert: (name: string, record: unknown) => Promise<{ id: number }>
  list: (name: string, opts?: { limit?: number }) => Promise<any[]>
  remove: (name: string, id: number) => Promise<unknown>
  clear: (name: string, opts?: { olderThanMs?: number }) => Promise<{ removed: number }>
  count?: (...args: unknown[]) => Promise<unknown>
  search?: (...args: unknown[]) => Promise<unknown>
  upsert?: (...args: unknown[]) => Promise<unknown>
  upsertMany?: (...args: unknown[]) => Promise<unknown>
}

export type VisionSessionFilesBridge = Record<string, (...args: unknown[]) => Promise<unknown>>

function codedError(code: string, message: string): Error & { code?: string } {
  const err = new Error(message) as Error & { code?: string }
  err.code = code
  return err
}

export function createIpcVisionStorage({
  send,
  onResponse,
  storageDir,
  timeoutMs = 30000
}: {
  send: SendFn
  onResponse: OnResponseFn
  storageDir: string
  timeoutMs?: number
}) {
  let seq = 0
  const pending = new Map<string, PendingEntry>()

  onResponse((msg) => {
    if (!msg || msg.type !== 'storage-response' || !msg.requestId) return
    const entry = pending.get(msg.requestId)
    if (!entry) return
    pending.delete(msg.requestId)
    clearTimeout(entry.timer)
    const result = msg.result ?? {}
    if (result.ok === false) {
      entry.reject(codedError(result.errorCode ?? 'storage_error', result.error ?? 'storage request failed'))
      return
    }
    entry.resolve(result.value)
  })

  function call(method: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = `vision-${Date.now()}.${seq++}`
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`storage IPC timeout: ${method}`))
      }, timeoutMs)
      if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
        ;(timer as unknown as { unref: () => void }).unref()
      }
      pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })
      try {
        send({ type: 'storage-request', requestId, method, args })
      } catch (err) {
        pending.delete(requestId)
        clearTimeout(timer)
        reject(err as Error)
      }
    })
  }

  const area = (prefix: string, methods: string[]): VisionSessionFilesBridge =>
    Object.fromEntries(methods.map((name) => [name, (...args: unknown[]) => call(`${prefix}.${name}`, args)]))

  const storageMethods = area('storage', [
    'get',
    'set',
    'getMany',
    'setMany',
    'delete',
    'listKeys',
    'migrate'
  ])
  const storage: StorageBridge = {
    storageDir,
    get: storageMethods['get'] as StorageBridge['get'],
    set: (async (key: string, value: unknown, opts?: unknown) => {
      await call('storage.set', opts === undefined ? [key, value] : [key, value, opts])
    }) as StorageBridge['set'],
    getMany: storageMethods['getMany'],
    setMany: storageMethods['setMany'],
    delete: (async (key: string, opts?: unknown) => {
      await call('storage.delete', opts === undefined ? [key] : [key, opts])
    }) as StorageBridge['delete'],
    listKeys: storageMethods['listKeys'],
    migrate: storageMethods['migrate']
  }

  const collectionMethods = area('collections', [
    'insert',
    'list',
    'count',
    'search',
    'remove',
    'clear',
    'upsert',
    'upsertMany'
  ])
  const collections = collectionMethods as unknown as VisionCollectionsBridge

  return {
    storage,
    collections,
    sessionFiles: area('sessionFiles', ['write', 'read', 'list', 'remove'])
  }
}
