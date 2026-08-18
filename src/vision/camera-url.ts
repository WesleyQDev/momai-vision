/**
 * URL de câmera IP — validação de SSRF (pura e testável).
 *
 * Decisão de segurança:
 *   - Esquemas permitidos: `http`, `https` e `rtsp` (RTSP é um esquema
 *     legítimo de câmera desta extensão). Tudo o mais (file:, ftp:, data:,
 *     gopher:, etc.) é rejeitado.
 *   - IPs BLOQUEADOS: loopback (127.0.0.0/8, ::1), link-local/metadata
 *     (169.254.0.0/16 — inclui o metadata service 169.254.169.254, fe80::/10)
 *     e o IPv6 do metadata da AWS (fd00:ec2::254). Hostname `localhost` é
 *     rejeitado por nome.
 *   - IPs privados LOCAIS (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) são
 *     PERMITIDOS: câmeras IP de vigilância residencial vivem na LAN — bloquear
 *     a faixa privada tornaria a extensão inútil. O risco real é o metadata
 *     service de clouds (169.254.169.254), não a LAN do usuário.
 *   - Hostnames (ex.: `cam.garagem.local`) são resolvidos via DNS na validação
 *     assíncrona: se resolverem para um IP bloqueado, a URL é rejeitada. Falha
 *     de resolução é tolerada (a conexão simplesmente falha, sem risco SSRF).
 */

import { lookup } from 'node:dns/promises'

export type UrlValidationResult = { ok: true } | { ok: false; error: string }

/** Resolvedor DNS injetável (o teste passa um fake; produção usa node:dns). */
export type LookupFn = (
  hostname: string,
  options: { all: true }
) => Promise<Array<{ address: string; family: number }>>

const defaultLookup: LookupFn = lookup

function parseIpv4(host: string): number | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => (p === '' ? NaN : Number(p)))
  if (!nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return null
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0
}

/** Faixas IPv4 bloqueadas (por byte alto). */
const BLOCKED_IPV4 = [
  { name: '0.0.0.0/8', test: (o: number) => o >>> 24 === 0 },
  { name: 'loopback 127.0.0.0/8', test: (o: number) => (o >>> 24) === 127 },
  { name: 'link-local/metadata 169.254.0.0/16', test: (o: number) => (o >>> 24) === 169 && ((o >>> 16) & 0xff) === 254 },
  { name: 'multicast 224.0.0.0/4', test: (o: number) => (o >>> 24) >= 224 && (o >>> 24) <= 239 },
  { name: 'reservado 240.0.0.0/4', test: (o: number) => (o >>> 24) >= 240 }
]

function isBlockedIpv4(ip: number): boolean {
  return BLOCKED_IPV4.some((r) => r.test(ip))
}

function isBlockedIpv6(host: string): boolean {
  const h = host.toLowerCase()
  if (h === '::1' || h === '::') return true
  // fe80::/10 — link-local IPv6
  if (h.startsWith('fe80:') || h === 'fe80') return true
  // fd00:ec2::254 — AWS IMDSv2
  if (h.startsWith('fd00:ec2::254')) return true
  return false
}

function normalizeHostname(rawUrl: string): { host: string; ok: boolean; error?: string } {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return { host: '', ok: false, error: 'URL inválida' }
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'rtsp') {
    return { host: '', ok: false, error: `esquema não suportado: ${scheme}` }
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return { host, ok: true }
}

/**
 * Validação síncrona (esquema + literal IP/hostname conhecido). Não resolve
 * DNS; para proteção completa de hostnames use `assertCameraUrlSafe`.
 */
export function validateCameraUrl(rawUrl: string): UrlValidationResult {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return { ok: false, error: 'URL vazia' }
  }
  const { host, ok, error } = normalizeHostname(rawUrl)
  if (!ok) return { ok: false, error: error || 'URL inválida' }
  if (host === 'localhost' || host === 'localhost.localdomain') {
    return { ok: false, error: 'host localhost não permitido' }
  }
  const ipv4 = parseIpv4(host)
  if (ipv4 !== null) {
    if (isBlockedIpv4(ipv4)) {
      return { ok: false, error: `endereço bloqueado: ${host}` }
    }
    return { ok: true }
  }
  if (host.includes(':')) {
    if (isBlockedIpv6(host)) {
      return { ok: false, error: `endereço bloqueado: ${host}` }
    }
    return { ok: true }
  }
  return { ok: true }
}

/**
 * Validação completa: validação síncrona + resolução de hostname. Hostnames que
 * resolvem para um IP bloqueado (ex.: um nome interno apontando para
 * 169.254.169.254) são rejeitados. Falha de DNS é tolerada.
 */
export async function assertCameraUrlSafe(
  rawUrl: string,
  lookupFn: LookupFn = defaultLookup
): Promise<UrlValidationResult> {
  const base = validateCameraUrl(rawUrl)
  if (!base.ok) return base
  const { host } = normalizeHostname(rawUrl)
  if (host === 'localhost' || host === 'localhost.localdomain' || host.includes(':')) {
    return { ok: true }
  }
  if (parseIpv4(host) !== null) return { ok: true }
  try {
    const addresses = await lookupFn(host, { all: true })
    for (const addr of addresses) {
      if (addr.family === 4) {
        const ip = parseIpv4(addr.address)
        if (ip !== null && isBlockedIpv4(ip)) {
          return { ok: false, error: `host ${host} resolve para endereço bloqueado: ${addr.address}` }
        }
      } else if (isBlockedIpv6(addr.address)) {
        return { ok: false, error: `host ${host} resolve para endereço bloqueado: ${addr.address}` }
      }
    }
  } catch {
    // Não resolve — a conexão falha naturalmente; sem risco de SSRF.
  }
  return { ok: true }
}