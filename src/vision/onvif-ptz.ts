import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

export type PtzDirection = 'up' | 'down' | 'left' | 'right' | 'zoom_in' | 'zoom_out'

export interface PtzVelocity {
  x: number
  y: number
  zoom?: number
}

export interface PtzPreset {
  token: string
  name: string
}

/**
 * Absolute PTZ coordinates reported by ONVIF `GetStatus`. Values are in the
 * camera's position space (usually normalized -1..1 for pan/tilt and zoom),
 * not degrees: mapping to degrees requires knowing the model's field of view.
 */
export interface PtzPosition {
  pan: number
  tilt: number
  zoom: number | null
  space?: string
}

export interface PtzMoveStatus {
  panTilt?: string
  zoom?: string
}

/** Bounded single-step movement. Short enough to be safe on any PTZ motor. */
export const PTZ_STEP_MIN_MS = 100
export const PTZ_STEP_MAX_MS = 5000
export const PTZ_STEP_DEFAULT_MS = 500

/** Clamps a requested step duration; the tool always auto-stops after it. */
export function clampStepDurationMs(value?: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return PTZ_STEP_DEFAULT_MS
  return Math.min(PTZ_STEP_MAX_MS, Math.max(PTZ_STEP_MIN_MS, Math.round(n)))
}

// A camera without GetStatus would otherwise pay a SOAP timeout on every step.
// Cache the negative capability for a while; successes always clear it.
const PTZ_STATUS_UNSUPPORTED_TTL_MS = 10 * 60 * 1000
const ptzStatusUnsupportedUntil = new Map<string, number>()

/**
 * Converte uma direção nominal e velocidade (0.1 a 1.0) para vetores X/Y/Zoom padrão ONVIF.
 * ONVIF:
 * - X: -1.0 (esquerda) a +1.0 (direita)
 * - Y: -1.0 (baixo) a +1.0 (cima)
 * - Zoom: -1.0 (reduzir) a +1.0 (aproximar)
 */
export function directionToVelocity(direction: PtzDirection, speed = 0.5): PtzVelocity {
  const clamped = Math.max(0.1, Math.min(1.0, speed))
  switch (direction) {
    case 'up':
      return { x: 0, y: clamped }
    case 'down':
      return { x: 0, y: -clamped }
    case 'left':
      return { x: -clamped, y: 0 }
    case 'right':
      return { x: clamped, y: 0 }
    case 'zoom_in':
      return { x: 0, y: 0, zoom: clamped }
    case 'zoom_out':
      return { x: 0, y: 0, zoom: -clamped }
    default:
      return { x: 0, y: 0 }
  }
}

/**
 * Cria o cabeçalho WS-Security UsernameToken padrão ONVIF.
 * Formula: Digest = Base64(SHA1(Nonce + Created + Password))
 */
export function createWsSecurityHeader(
  username?: string,
  password?: string,
  now?: Date,
  customNonce?: Buffer
): string {
  if (!username) return ''

  const nonce = customNonce || crypto.randomBytes(16)
  const nonceBase64 = nonce.toString('base64')
  const created = (now || new Date()).toISOString()
  const pass = password || ''

  const hasher = crypto.createHash('sha1')
  hasher.update(nonce)
  hasher.update(Buffer.from(created, 'utf8'))
  hasher.update(Buffer.from(pass, 'utf8'))
  const digestBase64 = hasher.digest('base64')

  return `
    <wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
      <wsse:UsernameToken>
        <wsse:Username>${escapeXml(username)}</wsse:Username>
        <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digestBase64}</wsse:Password>
        <wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonceBase64}</wsse:Nonce>
        <wsu:Created>${created}</wsu:Created>
      </wsse:UsernameToken>
    </wsse:Security>`
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Envelope SOAP 1.2 padrão compatível com dispositivos ONVIF.
 */
export function wrapSoapEnvelope(bodyXml: string, securityHeaderXml = ''): string {
  const headerContent = securityHeaderXml.trim()
  const headerBlock = headerContent ? `<s:Header>${headerContent}</s:Header>` : '<s:Header/>'

  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  ${headerBlock}
  <s:Body>
    ${bodyXml}
  </s:Body>
</s:Envelope>`
}

/**
 * Monta requisição GetCapabilities para descobrir os endpoints de PTZ e Media.
 */
export function buildGetCapabilitiesEnvelope(username?: string, password?: string): string {
  const header = createWsSecurityHeader(username, password)
  const body = `<tds:GetCapabilities/>`
  return wrapSoapEnvelope(body, header)
}

/**
 * Monta requisição GetProfiles para obter os tokens dos perfis de mídia.
 */
export function buildGetProfilesEnvelope(username?: string, password?: string): string {
  const header = createWsSecurityHeader(username, password)
  const body = `<trt:GetProfiles/>`
  return wrapSoapEnvelope(body, header)
}

/**
 * Monta a requisição ContinuousMove para iniciar o movimento da câmera.
 */
export function buildContinuousMoveEnvelope(params: {
  profileToken: string
  velocity: PtzVelocity
  timeout?: number
  username?: string
  password?: string
}): string {
  const { profileToken, velocity, timeout, username, password } = params
  const header = createWsSecurityHeader(username, password)
  const zoomPart = velocity.zoom !== undefined ? `<tt:Zoom x="${velocity.zoom}"/>` : ''
  const timeoutPart = timeout && timeout > 0 ? `<tptz:Timeout>PT${timeout}S</tptz:Timeout>` : ''

  const body = `
    <tptz:ContinuousMove>
      <tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
      <tptz:Velocity>
        <tt:PanTilt x="${velocity.x}" y="${velocity.y}"/>
        ${zoomPart}
      </tptz:Velocity>
      ${timeoutPart}
    </tptz:ContinuousMove>`

  return wrapSoapEnvelope(body, header)
}

/**
 * Monta a requisição Stop para parar o movimento da câmera.
 */
export function buildStopEnvelope(params: {
  profileToken: string
  panTilt?: boolean
  zoom?: boolean
  username?: string
  password?: string
}): string {
  const { profileToken, panTilt = true, zoom = true, username, password } = params
  const header = createWsSecurityHeader(username, password)

  const body = `
    <tptz:Stop>
      <tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
      <tptz:PanTilt>${panTilt ? 'true' : 'false'}</tptz:PanTilt>
      <tptz:Zoom>${zoom ? 'true' : 'false'}</tptz:Zoom>
    </tptz:Stop>`

  return wrapSoapEnvelope(body, header)
}

/**
 * Monta a requisição GotoHomePosition (Reposição do PTZ).
 */
export function buildGotoHomeEnvelope(params: {
  profileToken: string
  username?: string
  password?: string
}): string {
  const { profileToken, username, password } = params
  const header = createWsSecurityHeader(username, password)

  const body = `
    <tptz:GotoHomePosition>
      <tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
    </tptz:GotoHomePosition>`

  return wrapSoapEnvelope(body, header)
}

/**
 * Monta a requisição GetPresets (Locais / Posições salvas).
 */
export function buildGetPresetsEnvelope(params: {
  profileToken: string
  username?: string
  password?: string
}): string {
  const { profileToken, username, password } = params
  const header = createWsSecurityHeader(username, password)

  const body = `
    <tptz:GetPresets>
      <tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
    </tptz:GetPresets>`

  return wrapSoapEnvelope(body, header)
}

/**
 * Monta a requisição GetStatus para ler a posição absoluta (pan/tilt/zoom).
 */
export function buildGetStatusEnvelope(params: {
  profileToken: string
  username?: string
  password?: string
}): string {
  const { profileToken, username, password } = params
  const header = createWsSecurityHeader(username, password)
  const body = `
    <tptz:GetStatus>
      <tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
    </tptz:GetStatus>`
  return wrapSoapEnvelope(body, header)
}

/**
 * Monta a requisição GotoPreset para mover para um local salvo.
 */
export function buildGotoPresetEnvelope(params: {
  profileToken: string
  presetToken: string
  username?: string
  password?: string
}): string {
  const { profileToken, presetToken, username, password } = params
  const header = createWsSecurityHeader(username, password)

  const body = `
    <tptz:GotoPreset>
      <tptz:ProfileToken>${escapeXml(profileToken)}</tptz:ProfileToken>
      <tptz:PresetToken>${escapeXml(presetToken)}</tptz:PresetToken>
    </tptz:GotoPreset>`

  return wrapSoapEnvelope(body, header)
}

/**
 * Extrai tokens de perfis de mídia ONVIF (ex: Profile_1, IPCProfilesToken0, etc.)
 */
export function parseOnvifProfiles(xml: string): string[] {
  if (!xml) return []
  const tokens: string[] = []
  const matches = xml.matchAll(/<[^>]*:?Profiles\b[^>]*\btoken="([^"]+)"/gi)
  for (const m of matches) {
    if (m[1] && !tokens.includes(m[1])) {
      tokens.push(m[1])
    }
  }
  return tokens
}

/**
 * Extrai a lista de Presets de uma resposta ONVIF GetPresetsResponse.
 */
export function parseOnvifPresets(xml: string): PtzPreset[] {
  if (!xml) return []
  const presets: PtzPreset[] = []

  const presetBlocks = xml.match(/<(?:\w+:)?Preset\b[^>]*>[\s\S]*?<\/(?:\w+:)?Preset>/gi) || []
  for (const block of presetBlocks) {
    const tokenMatch = block.match(/\btoken="([^"]+)"/i)
    const nameMatch = block.match(/<(?:\w+:)?Name[^>]*>([^<]+)<\/(?:\w+:)?Name>/i)
    if (tokenMatch) {
      const token = tokenMatch[1]
      const name = nameMatch ? nameMatch[1].trim() : `Posição ${token}`
      presets.push({ token, name })
    }
  }

  return presets
}

function readXmlAttr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'i'))
  return match ? match[1] : undefined
}

function roundPosition(value: number): number {
  return Math.round(value * 10000) / 10000
}

/**
 * Parses an ONVIF GetStatusResponse into absolute pan/tilt/zoom coordinates.
 * Returns null when the camera did not report a Position block.
 */
export function parsePtzStatus(
  xml: string
): { position: PtzPosition; moveStatus?: PtzMoveStatus } | null {
  if (!xml) return null
  const positionBlock = xml.match(
    /<(?:\w+:)?Position\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Position>/i
  )?.[1]
  if (!positionBlock) return null

  const panTiltAttrs =
    positionBlock.match(/<(?:\w+:)?PanTilt\b([^>]*)\/?>/i)?.[1] || ''
  const pan = Number(readXmlAttr(panTiltAttrs, 'x'))
  const tilt = Number(readXmlAttr(panTiltAttrs, 'y'))
  if (!Number.isFinite(pan) || !Number.isFinite(tilt)) return null

  const zoomAttrs = positionBlock.match(/<(?:\w+:)?Zoom\b([^>]*)\/?>/i)?.[1] || ''
  const zoomRaw = readXmlAttr(zoomAttrs, 'x')
  const zoom = zoomRaw !== undefined ? Number(zoomRaw) : NaN
  const space = readXmlAttr(panTiltAttrs, 'space')

  const moveStatusBlock =
    xml.match(/<(?:\w+:)?MoveStatus\b[^>]*>([\s\S]*?)<\/(?:\w+:)?MoveStatus>/i)?.[1] || ''
  const panTiltStatus = moveStatusBlock
    .match(/<(?:\w+:)?PanTilt\b[^>]*>([^<]*)<\/(?:\w+:)?PanTilt>/i)?.[1]
    ?.trim()
  const zoomStatus = moveStatusBlock
    .match(/<(?:\w+:)?Zoom\b[^>]*>([^<]*)<\/(?:\w+:)?Zoom>/i)?.[1]
    ?.trim()
  const moveStatus: PtzMoveStatus | undefined =
    panTiltStatus || zoomStatus
      ? {
          ...(panTiltStatus ? { panTilt: panTiltStatus } : {}),
          ...(zoomStatus ? { zoom: zoomStatus } : {})
        }
      : undefined

  return {
    position: {
      pan: roundPosition(pan),
      tilt: roundPosition(tilt),
      zoom: Number.isFinite(zoom) ? roundPosition(zoom) : null,
      ...(space ? { space } : {})
    },
    ...(moveStatus ? { moveStatus } : {})
  }
}

/**
 * Lê a posição absoluta atual da câmera via ONVIF GetStatus.
 */
export async function fetchPtzStatus(
  endpoint: { serviceUrl: string; profileToken: string },
  username?: string,
  password?: string
): Promise<{
  ok: boolean
  position?: PtzPosition
  moveStatus?: PtzMoveStatus
  unsupported?: boolean
  error?: string
}> {
  if (!endpoint?.serviceUrl) return { ok: false, error: 'Serviço ONVIF PTZ não encontrado' }
  const cachedUntil = ptzStatusUnsupportedUntil.get(endpoint.serviceUrl) || 0
  if (Date.now() < cachedUntil) {
    return { ok: false, unsupported: true, error: 'Câmera não expõe posição PTZ (GetStatus)' }
  }
  const envelope = buildGetStatusEnvelope({
    profileToken: endpoint.profileToken,
    username,
    password
  })
  const res = await sendOnvifSoap(endpoint.serviceUrl, envelope, 2500)
  if (!res.ok && !res.body.includes('GetStatusResponse')) {
    if (/NotSupported|ActionNotSupported|<(?:\w+:)?Fault\b/i.test(res.body)) {
      ptzStatusUnsupportedUntil.set(
        endpoint.serviceUrl,
        Date.now() + PTZ_STATUS_UNSUPPORTED_TTL_MS
      )
    }
    const detail = res.body.slice(0, 100) || `status ${res.status}`
    return { ok: false, error: `Falha ao ler posição PTZ: ${detail}` }
  }
  const parsed = parsePtzStatus(res.body)
  if (!parsed) {
    ptzStatusUnsupportedUntil.set(
      endpoint.serviceUrl,
      Date.now() + PTZ_STATUS_UNSUPPORTED_TTL_MS
    )
    return { ok: false, unsupported: true, error: 'Câmera não expõe posição PTZ (GetStatus)' }
  }
  ptzStatusUnsupportedUntil.delete(endpoint.serviceUrl)
  return { ok: true, ...parsed }
}

/**
 * Extrai a URL do serviço PTZ e Media a partir da resposta do GetCapabilities.
 */
export function parseCapabilitiesEndpoints(xml: string): { ptzUrl?: string; mediaUrl?: string } {
  if (!xml) return {}
  let ptzUrl: string | undefined
  let mediaUrl: string | undefined

  // Extrai <tt:PTZ><tt:XAddr>...</tt:XAddr></tt:PTZ>
  const ptzMatch = xml.match(/<[^>]*:?PTZ[^>]*>[\s\S]*?<[^>]*:?XAddr[^>]*>([^<]+)<\/[^>]*:?XAddr>/i)
  if (ptzMatch) {
    ptzUrl = ptzMatch[1].trim()
  }

  // Extrai <tt:Media><tt:XAddr>...</tt:XAddr></tt:Media>
  const mediaMatch = xml.match(/<[^>]*:?Media[^>]*>[\s\S]*?<[^>]*:?XAddr[^>]*>([^<]+)<\/[^>]*:?XAddr>/i)
  if (mediaMatch) {
    mediaUrl = mediaMatch[1].trim()
  }

  return { ptzUrl, mediaUrl }
}

/**
 * Gera lista de URLs candidatas para o endpoint ONVIF de uma câmera na rede local.
 * Prioriza porta 5000 (câmeras Yoosee/comuns), depois 8000, 80, 8080, 8899, 2020.
 */
export function resolvePtzCandidateUrls(host: string, port?: number): string[] {
  const cleanHost = host.trim().replace(/^https?:\/\//i, '').replace(/:\d+.*$/, '')
  if (!cleanHost) return []

  const preferredPorts = [5000, 8000, 80, 8080, 8899, 2020]
  if (port && !preferredPorts.includes(port)) {
    preferredPorts.unshift(port)
  }

  const urls: string[] = []
  for (const p of preferredPorts) {
    urls.push(`http://${cleanHost}:${p}/onvif/device_service`)
    urls.push(`http://${cleanHost}:${p}/onvif/deviceio_service`)
    urls.push(`http://${cleanHost}:${p}/onvif/ptz_service`)
  }

  return urls
}

/**
 * Envia uma requisição SOAP usando node:http com agent: false e Connection: close.
 * Não reutiliza sockets, evitando quebras de conexão em microcontroladores de câmeras IP.
 */
export function sendOnvifSoap(
  urlStr: string,
  xml: string,
  timeoutMs = 4000,
  fastAcknowledge = false
): Promise<{ ok: boolean; status: number; body: string }> {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr)
      const isHttps = u.protocol === 'https:'
      const client = isHttps ? https : http
      const port = u.port ? parseInt(u.port, 10) : isHttps ? 443 : 80

      let resolved = false
      const safeResolve = (val: { ok: boolean; status: number; body: string }) => {
        if (!resolved) {
          resolved = true
          resolve(val)
        }
      }

      const req = client.request(
        {
          hostname: u.hostname,
          port,
          path: `${u.pathname}${u.search}`,
          method: 'POST',
          agent: false, // Sem socket pooling: conexão nova a cada chamada
          headers: {
            'Content-Type': 'application/soap+xml; charset=utf-8',
            'Content-Length': Buffer.byteLength(xml),
            Connection: 'close',
            'User-Agent': 'MomAI-Vision-PTZ/1.0'
          },
          timeout: timeoutMs
        },
        (res) => {
          if (fastAcknowledge) {
            if (typeof res?.resume === 'function') {
              res.resume()
            }
            safeResolve({ ok: true, status: res.statusCode || 200, body: '<SOAP-ENV:Response acknowledged="fast"/>' })
            return
          }
          let body = ''
          res.on('data', (chunk) => {
            body += chunk
          })
          res.on('end', () => {
            const status = res.statusCode || 0
            const ok = status >= 200 && status < 300
            safeResolve({ ok, status, body })
          })
        }
      )

      if (fastAcknowledge) {
        req.on('finish', () => {
          // Assim que o pacote TCP com o SOAP sai do buffer do Node para a câmera (~10ms)
          safeResolve({ ok: true, status: 200, body: '<SOAP-ENV:Response acknowledged="sent"/>' })
        })
      }

      req.on('error', (err: any) => {
        // Se a câmera fechou o socket com ECONNRESET após processar o comando
        if (err?.code === 'ECONNRESET' || err?.message?.includes('socket hang up')) {
          safeResolve({ ok: true, status: 200, body: '<SOAP-ENV:Response acknowledged="reset"/>' })
        } else {
          safeResolve({ ok: false, status: 0, body: err.message })
        }
      })

      req.on('timeout', () => {
        req.destroy()
        safeResolve({ ok: false, status: 0, body: 'Timeout na requisição' })
      })

      req.write(xml)
      req.end()
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      resolve({ ok: false, status: 0, body: message })
    }
  })
}

export interface PtzCommandOptions {
  host: string
  action: 'move' | 'step' | 'stop' | 'home' | 'preset' | 'status' | 'warmup'
  direction?: PtzDirection
  speed?: number
  /** Bounded move duration for `step`; clamped to PTZ_STEP_MIN/MAX_MS. */
  durationMs?: number
  presetToken?: string
  username?: string
  password?: string
  customServiceUrl?: string
  customProfileToken?: string
}

export interface PtzDispatchedResult {
  ok: boolean
  action: string
  error?: string
  serviceUrl?: string
  profileToken?: string
  durationMs?: number
  stopped?: boolean
  position?: PtzPosition | null
  positionSupported?: boolean
  moveStatus?: PtzMoveStatus
}

export interface CachedEndpoint {
  serviceUrl: string
  profileToken: string
  mediaUrl?: string
}

const ptzEndpointCache = new Map<string, CachedEndpoint>()

export function setPtzCachedEndpoint(host: string, endpoint: CachedEndpoint): void {
  if (host && endpoint?.serviceUrl) {
    ptzEndpointCache.set(host, endpoint)
  }
}

export function getAllPtzCachedEndpoints(): Record<string, CachedEndpoint> {
  const result: Record<string, CachedEndpoint> = {}
  for (const [k, v] of ptzEndpointCache.entries()) {
    result[k] = v
  }
  return result
}

export function clearPtzCache(host?: string): void {
  if (host) {
    const endpoint = ptzEndpointCache.get(host)
    if (endpoint) ptzStatusUnsupportedUntil.delete(endpoint.serviceUrl)
    ptzEndpointCache.delete(host)
  } else {
    ptzEndpointCache.clear()
    ptzStatusUnsupportedUntil.clear()
  }
}

/**
 * Descobre o endpoint ONVIF PTZ de alta performance para o host fornecido via GetCapabilities.
 * Retorna imediatamente com token default IPCProfilesToken0 sem bloquear em GetProfiles.
 */
export async function resolveOrProbePtzEndpoint(
  host: string,
  username?: string,
  password?: string
): Promise<CachedEndpoint | null> {
  const cached = ptzEndpointCache.get(host)
  if (cached) return cached

  const cleanHost = host.trim().replace(/^https?:\/\//i, '').replace(/:\d+.*$/, '')
  const capEnvelope = buildGetCapabilitiesEnvelope(username, password)

  // 1. Testa primeiramente o endpoint mais comum (porta 5000) sem sobrecarregar a câmera
  const primary5000Url = `http://${cleanHost}:5000/onvif/device_service`
  const primaryRes = await sendOnvifSoap(primary5000Url, capEnvelope, 2000)
  if (primaryRes.ok && primaryRes.body.includes('Capabilities')) {
    const endpoints = parseCapabilitiesEndpoints(primaryRes.body)
    const serviceUrl = endpoints.ptzUrl || primary5000Url
    const mediaUrl = endpoints.mediaUrl

    // Resposta ultra-rápida: assume token padrão sem esperar segundos pelo GetProfiles
    const entry: CachedEndpoint = { serviceUrl, profileToken: 'IPCProfilesToken0', mediaUrl }
    ptzEndpointCache.set(host, entry)

    if (mediaUrl) {
      void (async () => {
        try {
          const profEnvelope = buildGetProfilesEnvelope(username, password)
          const profRes = await sendOnvifSoap(mediaUrl, profEnvelope, 2000)
          if (profRes.ok) {
            const foundTokens = parseOnvifProfiles(profRes.body)
            if (foundTokens.length > 0 && foundTokens[0] !== entry.profileToken) {
              entry.profileToken = foundTokens[0]
            }
          }
        } catch {}
      })()
    }

    return entry
  }

  // 2. Se a porta 5000 não responder, testa as demais portas candidatas em série
  const candidates = resolvePtzCandidateUrls(host).filter((url) => url !== primary5000Url)
  for (const url of candidates) {
    const res = await sendOnvifSoap(url, capEnvelope, 1500)
    if (res.ok && res.body.includes('Capabilities')) {
      const endpoints = parseCapabilitiesEndpoints(res.body)
      const serviceUrl = endpoints.ptzUrl || url
      const mediaUrl = endpoints.mediaUrl

      const entry: CachedEndpoint = { serviceUrl, profileToken: 'IPCProfilesToken0', mediaUrl }
      ptzEndpointCache.set(host, entry)

      if (mediaUrl) {
        void (async () => {
          try {
            const profEnvelope = buildGetProfilesEnvelope(username, password)
            const profRes = await sendOnvifSoap(mediaUrl, profEnvelope, 1500)
            if (profRes.ok) {
              const foundTokens = parseOnvifProfiles(profRes.body)
              if (foundTokens.length > 0 && foundTokens[0] !== entry.profileToken) {
                entry.profileToken = foundTokens[0]
              }
            }
          } catch {}
        })()
      }

      return entry
    }
  }

  // Fallback rápido na porta 5000
  const fallback: CachedEndpoint = {
    serviceUrl: `http://${host}:5000/onvif/deviceio_service`,
    profileToken: 'IPCProfilesToken0'
  }
  ptzEndpointCache.set(host, fallback)
  return fallback
}

/**
 * Despacha um comando PTZ completo para a câmera IP.
 */
export async function dispatchPtzCommand(options: PtzCommandOptions): Promise<PtzDispatchedResult> {
  const { host, action, direction = 'up', speed = 0.5, presetToken, username, password } = options
  if (!host) {
    return { ok: false, action, error: 'Host da câmera não fornecido' }
  }

  const endpoint = options.customServiceUrl
    ? {
        serviceUrl: options.customServiceUrl,
        profileToken: options.customProfileToken || 'IPCProfilesToken0'
      }
    : await resolveOrProbePtzEndpoint(host, username, password)

  if (!endpoint) {
    return { ok: false, action, error: 'Serviço ONVIF PTZ não encontrado' }
  }

  if (action === 'warmup') {
    return { ok: true, action: 'warmup', serviceUrl: endpoint.serviceUrl, profileToken: endpoint.profileToken }
  }

  const { serviceUrl, profileToken } = endpoint

  if (action === 'status') {
    const status = await fetchPtzStatus({ serviceUrl, profileToken }, username, password)
    if (!status.ok) {
      return {
        ok: false,
        action,
        error: status.error || 'Posição PTZ indisponível',
        serviceUrl,
        profileToken
      }
    }
    return {
      ok: true,
      action,
      serviceUrl,
      profileToken,
      position: status.position ?? null,
      positionSupported: true,
      ...(status.moveStatus ? { moveStatus: status.moveStatus } : {})
    }
  }

  if (action === 'step') {
    // Bounded single step: start moving, wait the requested duration and always
    // stop. Relying only on the camera's ContinuousMove Timeout is unsafe — many
    // firmwares ignore it and the motor would keep running indefinitely.
    const durationMs = clampStepDurationMs(options.durationMs)
    const moveEnvelope = buildContinuousMoveEnvelope({
      profileToken,
      velocity: directionToVelocity(direction, speed),
      username,
      password
    })
    const moveRes = await sendOnvifSoap(serviceUrl, moveEnvelope, 4000)
    if (!moveRes.ok && !moveRes.body.includes('Response')) {
      return {
        ok: false,
        action,
        error: `Falha na câmera (status ${moveRes.status}): ${moveRes.body.slice(0, 100)}`,
        serviceUrl,
        profileToken
      }
    }

    await new Promise((resolve) => setTimeout(resolve, durationMs))

    const stopEnvelope = buildContinuousMoveEnvelope({
      profileToken,
      velocity: { x: 0, y: 0 },
      username,
      password
    })
    const stopRes = await sendOnvifSoap(serviceUrl, stopEnvelope, 4000, true)
    const stopped = stopRes.ok || stopRes.body.includes('Response')

    const status = await fetchPtzStatus({ serviceUrl, profileToken }, username, password).catch(
      () => null
    )
    return {
      ok: true,
      action,
      serviceUrl,
      profileToken,
      durationMs,
      stopped,
      position: status?.ok ? status.position ?? null : null,
      positionSupported: Boolean(status?.ok),
      ...(status?.ok && status.moveStatus ? { moveStatus: status.moveStatus } : {})
    }
  }

  let envelope = ''

  switch (action) {
    case 'move':
      envelope = buildContinuousMoveEnvelope({
        profileToken,
        velocity: directionToVelocity(direction, speed),
        username,
        password
      })
      break
    case 'stop':
      // Para câmeras que fecham o socket no <tptz:Stop>, ContinuousMove com {x: 0, y: 0}
      // é o padrão universal que para o motor instantaneamente com 100% de confiabilidade.
      envelope = buildContinuousMoveEnvelope({
        profileToken,
        velocity: { x: 0, y: 0 },
        username,
        password
      })
      break
    case 'home':
      envelope = buildGotoHomeEnvelope({ profileToken, username, password })
      break
    case 'preset':
      if (!presetToken) {
        return { ok: false, action, error: 'presetToken é obrigatório para a ação preset' }
      }
      envelope = buildGotoPresetEnvelope({ profileToken, presetToken, username, password })
      break
    default:
      return { ok: false, action, error: `Ação PTZ desconhecida: ${String(action)}` }
  }

  const fast = action === 'move' || action === 'stop'
  const res = await sendOnvifSoap(serviceUrl, envelope, 4000, fast)
  if (res.ok || res.body.includes('Response')) {
    return { ok: true, action, serviceUrl, profileToken }
  }

  return {
    ok: false,
    action,
    error: `Falha na câmera (status ${res.status}): ${res.body.slice(0, 100)}`,
    serviceUrl,
    profileToken
  }
}

/**
 * Busca a lista de posições salvas (Presets) da câmera.
 */
export async function fetchPtzPresets(
  host: string,
  username?: string,
  password?: string
): Promise<{ ok: boolean; presets: PtzPreset[]; error?: string }> {
  const endpoint = await resolveOrProbePtzEndpoint(host, username, password)
  if (!endpoint) {
    return { ok: false, presets: [], error: 'Serviço ONVIF PTZ não encontrado' }
  }

  const envelope = buildGetPresetsEnvelope({ profileToken: endpoint.profileToken, username, password })
  const res = await sendOnvifSoap(endpoint.serviceUrl, envelope, 2000)

  if (res.ok && res.body.includes('GetPresetsResponse')) {
    const presets = parseOnvifPresets(res.body)
    return { ok: true, presets }
  }

  return {
    ok: false,
    presets: [],
    error: 'Esta câmera não suporta lista de locais pré-gravados via ONVIF'
  }
}
