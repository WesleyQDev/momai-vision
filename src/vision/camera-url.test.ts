import { describe, it, expect } from 'vitest'
import { validateCameraUrl, assertCameraUrlSafe, type LookupFn } from './camera-url'

describe('validateCameraUrl (síncrono — esquema + literal)', () => {
  it('permite http/https e rtsp', () => {
    expect(validateCameraUrl('http://192.168.0.5:8080/video').ok).toBe(true)
    expect(validateCameraUrl('https://cam.garagem.local/stream').ok).toBe(true)
    expect(validateCameraUrl('rtsp://admin:pass@192.168.0.5:554/stream1').ok).toBe(true)
    expect(validateCameraUrl('http://10.0.0.5:8080/video').ok).toBe(true)
    expect(validateCameraUrl('http://172.16.5.5:8080/video').ok).toBe(true)
  })

  it('rejeita esquemas não suportados (file:, ftp:, data:, gopher:)', () => {
    expect(validateCameraUrl('file:///etc/passwd').ok).toBe(false)
    expect(validateCameraUrl('ftp://192.168.0.5/video').ok).toBe(false)
    expect(validateCameraUrl('data:text/html;base64,xxx').ok).toBe(false)
    expect(validateCameraUrl('gopher://192.168.0.5/').ok).toBe(false)
  })

  it('bloqueia loopback e link-local/metadata', () => {
    expect(validateCameraUrl('http://127.0.0.1:8080/video').ok).toBe(false)
    expect(validateCameraUrl('http://127.0.0.2:8080/video').ok).toBe(false)
    expect(validateCameraUrl('http://169.254.169.254/latest/meta-data/').ok).toBe(false)
    expect(validateCameraUrl('http://169.254.0.5/snapshot.jpg').ok).toBe(false)
    expect(validateCameraUrl('http://[::1]:8080/video').ok).toBe(false)
  })

  it('bloqueia hostname localhost', () => {
    expect(validateCameraUrl('http://localhost:8080/video').ok).toBe(false)
    expect(validateCameraUrl('http://localhost.localdomain/stream').ok).toBe(false)
  })

  it('rejeita URLs inválidas e vazias', () => {
    expect(validateCameraUrl('').ok).toBe(false)
    expect(validateCameraUrl('not a url').ok).toBe(false)
    expect(validateCameraUrl('192.168.0.5').ok).toBe(false)
  })

  it('rejeita IPs reservados/multicast', () => {
    expect(validateCameraUrl('http://0.0.0.0:8080/video').ok).toBe(false)
    expect(validateCameraUrl('http://224.0.0.1:8080/video').ok).toBe(false)
    expect(validateCameraUrl('http://240.0.0.1:8080/video').ok).toBe(false)
  })
})

describe('assertCameraUrlSafe (com resolução de hostname)', () => {
  const resolveTo =
    (addresses: Array<{ address: string; family: number }>): LookupFn =>
    async () => addresses

  it('rejeita hostname que resolve para link-local/metadata', async () => {
    const result = await assertCameraUrlSafe('http://metadata.internal/', resolveTo([
      { address: '169.254.169.254', family: 4 },
      { address: '10.0.0.5', family: 4 }
    ]))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('169.254.169.254')
  })

  it('rejeita hostname que resolve para loopback', async () => {
    const result = await assertCameraUrlSafe('http://intranet.local/video', resolveTo([
      { address: '127.0.0.1', family: 4 }
    ]))
    expect(result.ok).toBe(false)
  })

  it('permite hostname que resolve para IP privado da LAN', async () => {
    const result = await assertCameraUrlSafe('http://cam.garagem.local/video', resolveTo([
      { address: '192.168.1.10', family: 4 },
      { address: '10.0.0.8', family: 4 }
    ]))
    expect(result.ok).toBe(true)
  })

  it('tolera hostname que não resolve (sem risco SSRF — a conexão falha)', async () => {
    const failing: LookupFn = async () => {
      throw new Error('ENOTFOUND')
    }
    expect((await assertCameraUrlSafe('http://nao-existe.local/video', failing)).ok).toBe(true)
  })

  it('não faz DNS para literais de IP', async () => {
    let called = false
    const lookupSpy: LookupFn = async () => {
      called = true
      return []
    }
    expect((await assertCameraUrlSafe('http://192.168.0.5:8080/video', lookupSpy)).ok).toBe(true)
    expect((await assertCameraUrlSafe('http://169.254.169.254/', lookupSpy)).ok).toBe(false)
    expect(called).toBe(false)
  })
})