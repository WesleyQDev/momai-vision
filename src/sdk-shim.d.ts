/**
 * Minimal type declarations for the host-provided `momai:sdk` module and
 * the preload surface (window.api) available inside extension UIs.
 */

export interface SDKResponse<T = any> {
  ok: boolean
  data?: T
  error?: string
  errorCode?: string
}

export interface MomAISDK {
  api: {
    get<T = any>(path: string, params?: Record<string, any>): Promise<SDKResponse<T>>
    post<T = any>(path: string, body?: any): Promise<SDKResponse<T>>
    put<T = any>(path: string, body?: any): Promise<SDKResponse<T>>
    delete<T = any>(path: string): Promise<SDKResponse<T>>
  }
  storage: {
    get<T = any>(key: string, opts?: { version?: string }): Promise<T | null>
    set(key: string, value: any): Promise<void>
    delete(key: string): Promise<void>
    listKeys(): Promise<string[]>
  }
  events: {
    subscribe<T = any>(type: string, handler: (data: T) => void): () => void
    unsubscribe(type: string, handler: (...args: any[]) => void): void
    once<T = any>(type: string, handler: (data: T) => void): void
  }
  llm: {
    complete(opts: { system?: string; user: string; maxTokens?: number }): Promise<{ text: string }>
  }
  registry: {
    registerRenderer(type: string, component: any): void
    getRenderer(type: string): any
    hasRenderer(type: string): boolean
    listRendererTypes(): string[]
  }
  notifications: {
    send(opts: { title: string; body?: string; action?: string }): Promise<void>
  }
  theme: {
    setColors(colors: Record<string, string>): Promise<void>
  }
  scheduler: {
    cron(schedule: string, handler: () => void): { cancel: () => void }
  }
  oauth: {
    authorize(provider: string, opts: { scope: string[] }): Promise<SDKResponse<{ token: string }>>
  }
  config: {
    get(key: string): Promise<string | null>
    set(key: string, value: string): Promise<void>
    delete(key: string): Promise<void>
  }
  process: {
    spawn(command: string, args?: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>
  }
  system: {
    screen: { capture(): Promise<ArrayBuffer> }
  }
  browser: {
    open(url: string): Promise<void>
    screenshot(): Promise<ArrayBuffer>
  }
  has(method: string): boolean
  dev: {
    reload(): void
    log(...args: any[]): void
  }
}

export declare function getSDK(): MomAISDK

declare global {
  interface Window {
    api?: {
      getSessionToken?: () => string
      getApiBaseUrl?: () => string
      send?: (channel: string, ...args: any[]) => void
      closeOverlay?: (data?: unknown) => void
      reinstateEconomySleep?: () => void
    }
    momaiAPI?: {
      getSessionToken?: () => string
      getApiBaseUrl?: () => string
      send?: (channel: string, ...args: any[]) => void
    }
  }
}
