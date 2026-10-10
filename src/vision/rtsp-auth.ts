export interface ParsedCameraAuth {
  username: string
  password: string
  cleanUrl: string
}

/**
 * Extrai usuário, senha e a URL limpa (sem credenciais).
 */
export function parseCameraAuth(rawUrl: string): ParsedCameraAuth {
  const trimmed = rawUrl.trim()
  const protoMatch = trimmed.match(/^(rtsp|https?):\/\/(.*)$/i)
  if (!protoMatch) {
    return { username: '', password: '', cleanUrl: rawUrl }
  }
  const protocol = protoMatch[1].toLowerCase()
  const rest = protoMatch[2]

  const lastAtIndex = rest.lastIndexOf('@')
  if (lastAtIndex === -1) {
    return { username: '', password: '', cleanUrl: trimmed }
  }

  const authPart = rest.slice(0, lastAtIndex)
  const hostAndPath = rest.slice(lastAtIndex + 1)
  const cleanUrl = `${protocol}://${hostAndPath}`

  // Parse username and password from authPart
  const firstColon = authPart.indexOf(':')
  let username = ''
  let password = ''
  if (firstColon === -1) {
    try {
      username = decodeURIComponent(authPart)
    } catch {
      username = authPart
    }
  } else {
    try {
      username = decodeURIComponent(authPart.slice(0, firstColon))
    } catch {
      username = authPart.slice(0, firstColon)
    }
    let rawPass = authPart.slice(firstColon + 1)
    if (rawPass.includes('@')) {
      const parts = rawPass.split('@').filter(Boolean)
      rawPass = parts[parts.length - 1].replace(/^:/, '')
    }
    try {
      password = decodeURIComponent(rawPass)
    } catch {
      password = rawPass
    }
  }

  return { username, password, cleanUrl }
}

/**
 * Monta uma URL com as credenciais codificadas com segurança (encodeURIComponent).
 */
export function buildAuthenticatedUrl(baseUrl: string, username = '', password = ''): string {
  const trimmed = baseUrl.trim()
  const parsed = parseCameraAuth(trimmed)
  let u = (username.trim() || parsed.username).trim()
  const p = (password.trim() || parsed.password).trim()

  if (!p && !parsed.username && (!username.trim() || username.trim() === 'admin')) {
    return parsed.cleanUrl
  }

  if (!u && !p) {
    return parsed.cleanUrl
  }

  // Se a senha foi informada mas o usuário ficou em branco, assume 'admin' (padrão de mercado para RTSP/ONVIF)
  if (!u && p) {
    u = 'admin'
  }

  const encodedUser = encodeURIComponent(u)
  const encodedPass = encodeURIComponent(p)
  const auth = p ? `${encodedUser}:${encodedPass}@` : `${encodedUser}@`
  return `${parsed.cleanUrl.replace(/^(rtsp|https?):\/\//i, (m) => `${m}${auth}`)}`
}

/**
 * Redige credenciais da URL para exibição segura ou logs (ex: rtsp://user:pass@host -> rtsp://***@host).
 */
export function redactCameraUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return ''
  return rawUrl.replace(/:\/\/[^@]+@/, '://***@')
}

/** Clean URL used as the credential key (credentials stripped). */
export function credentialKey(rawUrl: string): string {
  const clean = parseCameraAuth(String(rawUrl || '')).cleanUrl.trim()
  return clean || String(rawUrl || '').trim()
}



