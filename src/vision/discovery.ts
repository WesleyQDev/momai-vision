import dgram from 'node:dgram'
import net from 'node:net'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface DiscoveredIpCamera {
  id: string
  ip: string
  port?: number
  name: string
  urn?: string
  mac?: string
  xaddrs?: string[]
  suggestedUrl: string
  allSuggestedUrls: string[]
}

const WS_DISCOVERY_PROBE_NVT = `<?xml version="1.0" encoding="utf-8"?>
<Envelope xmlns:dn="http://www.onvif.org/ver10/network/wsdl" xmlns:tdn="http://www.onvif.org/ver10/network/wsdl" xmlns="http://www.w3.org/2003/05/soap-envelope">
  <Header>
    <wsa:MessageID xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing">uuid:${generateUuid()}</wsa:MessageID>
    <wsa:To xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing">urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To>
    <wsa:Action xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action>
  </Header>
  <Body>
    <Probe xmlns="http://schemas.xmlsoap.org/ws/2005/04/discovery">
      <Types>dn:NetworkVideoTransmitter</Types>
    </Probe>
  </Body>
</Envelope>`

const WS_DISCOVERY_PROBE_GENERIC = `<?xml version="1.0" encoding="utf-8"?>
<Envelope xmlns="http://www.w3.org/2003/05/soap-envelope">
  <Header>
    <wsa:MessageID xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing">uuid:${generateUuid()}</wsa:MessageID>
    <wsa:To xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing">urn:schemas-xmlsoap-org:ws:2005:04:discovery</wsa:To>
    <wsa:Action xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</wsa:Action>
  </Header>
  <Body>
    <Probe xmlns="http://schemas.xmlsoap.org/ws/2005/04/discovery"/>
  </Body>
</Envelope>`

function generateUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export function parseWsDiscoveryResponse(xml: string, rinfoAddress: string): DiscoveredIpCamera | null {
  if (!xml || typeof xml !== 'string') return null

  // Ignora respostas de computadores Windows / WSD-Print
  if (xml.includes('wsdp:Device') && xml.includes('pub:Computer')) {
    return null
  }

  // Extract EndpointReference / Address (URN)
  const epMatch = xml.match(/<(?:\w+:)?Address[^>]*>([^<]+)<\/(?:\w+:)?Address>/i)
  const urn = epMatch ? epMatch[1].trim().slice(0, 200) : undefined

  // Extract XAddrs
  const xaddrsMatch = xml.match(/<(?:\w+:)?XAddrs[^>]*>([^<]+)<\/(?:\w+:)?XAddrs>/i)
  const xaddrsRaw = xaddrsMatch ? xaddrsMatch[1].trim() : ''
  const xaddrs = xaddrsRaw ? xaddrsRaw.split(/\s+/).filter(Boolean) : []

  // Extract scopes for hardware/name hints
  const scopesMatch = xml.match(/<(?:\w+:)?Scopes[^>]*>([\s\S]*?)<\/(?:\w+:)?Scopes>/i)
  const scopesRaw = scopesMatch ? scopesMatch[1].trim() : ''
  const scopes = scopesRaw ? scopesRaw.split(/\s+/) : []

  let extractedName = ''
  for (const s of scopes) {
    try {
      const decoded = decodeURIComponent(s)
      if (decoded.includes('onvif://www.onvif.org/name/')) {
        extractedName = decoded.replace(/.*onvif:\/\/www\.onvif\.org\/name\//i, '').trim().slice(0, 100)
      } else if (!extractedName && decoded.includes('onvif://www.onvif.org/hardware/')) {
        extractedName = decoded.replace(/.*onvif:\/\/www\.onvif\.org\/hardware\//i, '').trim().slice(0, 100)
      }
    } catch {}
  }

  // Derive IP address
  let ip = rinfoAddress
  for (const xaddr of xaddrs) {
    try {
      const u = new URL(xaddr)
      if (u.hostname && u.hostname !== '127.0.0.1' && !u.hostname.startsWith('169.254')) {
        ip = u.hostname
        break
      }
    } catch {}
  }

  const id = urn || `onvif:${ip}`
  const name = extractedName || `Câmera ONVIF (${ip})`
  const defaultUrl = `rtsp://${ip}:554/onvif1`
  const allSuggestedUrls = [
    `rtsp://${ip}:554/onvif1`,
    `rtsp://${ip}:554/onvif2`,
    `rtsp://${ip}:554/live/ch0`,
    `rtsp://${ip}:554/h264Preview_01_main`
  ]

  return {
    id,
    ip,
    port: 554,
    name,
    urn,
    xaddrs,
    suggestedUrl: defaultUrl,
    allSuggestedUrls
  }
}

/**
 * Procura o endereço MAC para um IP a partir da tabela ARP do sistema.
 */
export async function lookupArpMac(targetIp: string): Promise<string | null> {
  if (!targetIp || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(targetIp.trim())) {
    return null
  }
  const cleanIp = targetIp.trim()
  try {
    const { stdout } = await execFileAsync('arp', ['-a', cleanIp], { timeout: 2000 })
    const lines = stdout.split('\n')
    for (const line of lines) {
      if (line.includes(cleanIp)) {
        const match = line.match(/([0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2})/)
        if (match) {
          return match[1].toLowerCase().replace(/-/g, ':')
        }
      }
    }
  } catch {}
  return null
}

/**
 * Lê todos os IPs descobertos na tabela ARP do Windows.
 */
export async function listArpIps(): Promise<string[]> {
  const ips: string[] = []
  try {
    const { stdout } = await execFileAsync('arp', ['-a'], { timeout: 2000 })
    const lines = stdout.split('\n')
    for (const line of lines) {
      const match = line.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/)
      if (match) {
        const ip = match[1]
        if (
          !ip.startsWith('127.') &&
          !ip.startsWith('169.254.') &&
          !ip.startsWith('224.') &&
          !ip.startsWith('239.') &&
          !ip.endsWith('.255')
        ) {
          ips.push(ip)
        }
      }
    }
  } catch {}
  return ips
}

/**
 * Testa se uma porta TCP está aberta em um IP com timeout curto.
 */
function probeTcpPort(ip: string, port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    try {
      socket.connect(port, ip)
    } catch {
      resolve(false)
    }
  })
}

/**
 * Dispara sonda WS-Discovery em todas as interfaces de rede locais ativas
 * e faz fallback para scan rápido de portas nos aparelhos da rede local.
 */
export async function discoverOnvifCameras(timeoutMs = 2500): Promise<DiscoveredIpCamera[]> {
  const results = new Map<string, DiscoveredIpCamera>()
  const ifaces = os.networkInterfaces()
  const activeLocalInterfaces: Array<{ name: string; ip: string; broadcastIp?: string }> = []

  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list || []) {
      if (info.family === 'IPv4' && !info.internal && !info.address.startsWith('169.254')) {
        let broadcastIp: string | undefined
        if (info.netmask && info.address) {
          const ipParts = info.address.split('.').map(Number)
          const maskParts = info.netmask.split('.').map(Number)
          if (ipParts.length === 4 && maskParts.length === 4) {
            const bcast = ipParts.map((p, i) => (p | (~maskParts[i] & 255)) >>> 0).join('.')
            broadcastIp = bcast
          }
        }
        activeLocalInterfaces.push({ name, ip: info.address, broadcastIp })
      }
    }
  }

  // 1. Descoberta WS-Discovery via UDP em todas as interfaces
  await new Promise<void>((resolve) => {
    const sockets: dgram.Socket[] = []
    let closed = false

    const cleanup = () => {
      if (closed) return
      closed = true
      for (const s of sockets) {
        try { s.close() } catch {}
      }
      resolve()
    }

    const timer = setTimeout(cleanup, Math.min(timeoutMs, 2200))

    for (const iface of activeLocalInterfaces) {
      try {
        const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
        sockets.push(socket)

        socket.on('message', (msg, rinfo) => {
          try {
            const parsed = parseWsDiscoveryResponse(msg.toString('utf8'), rinfo.address)
            if (parsed && !results.has(parsed.ip)) {
              results.set(parsed.ip, parsed)
            }
          } catch {}
        })

        socket.on('error', () => {})

        socket.bind({ address: iface.ip, port: 0 }, () => {
          try {
            socket.setBroadcast(true)
            socket.setMulticastTTL(4)

            const bufNvt = Buffer.from(WS_DISCOVERY_PROBE_NVT, 'utf8')
            const bufGen = Buffer.from(WS_DISCOVERY_PROBE_GENERIC, 'utf8')

            // Multicast standard
            socket.send(bufNvt, 0, bufNvt.length, 3702, '239.255.255.250')
            socket.send(bufGen, 0, bufGen.length, 3702, '239.255.255.250')

            // Broadcast geral
            socket.send(bufNvt, 0, bufNvt.length, 3702, '255.255.255.255')
            socket.send(bufGen, 0, bufGen.length, 3702, '255.255.255.255')

            // Broadcast da subrede específica
            if (iface.broadcastIp) {
              socket.send(bufNvt, 0, bufNvt.length, 3702, iface.broadcastIp)
              socket.send(bufGen, 0, bufGen.length, 3702, iface.broadcastIp)
            }
          } catch {}
        })
      } catch {}
    }

    if (sockets.length === 0) {
      clearTimeout(timer)
      resolve()
    }
  })

  // 2. Fallback: Se nenhuma câmera foi encontrada ou para enriquecer com aparelhos que fecham UDP,
  // testa portas RTSP (554) e ONVIF (5000/8000/80) nos IPs da tabela ARP
  try {
    const arpIps = await listArpIps()
    const candidates = arpIps.filter((ip) => !results.has(ip))

    await Promise.all(
      candidates.map(async (ip) => {
        const hasRtsp = await probeTcpPort(ip, 554, 500)
        const hasOnvifPort = hasRtsp || (await probeTcpPort(ip, 5000, 500)) || (await probeTcpPort(ip, 8000, 500))

        if (hasRtsp || hasOnvifPort) {
          const mac = await lookupArpMac(ip)
          const fallbackEntry: DiscoveredIpCamera = {
            id: `ip:${ip}`,
            ip,
            port: 554,
            name: `Câmera de Rede (${ip})`,
            mac: mac || undefined,
            suggestedUrl: `rtsp://${ip}:554/onvif1`,
            allSuggestedUrls: [
              `rtsp://${ip}:554/onvif1`,
              `rtsp://${ip}:554/onvif2`,
              `rtsp://${ip}:554/live/ch0`
            ]
          }
          if (!results.has(ip)) {
            results.set(ip, fallbackEntry)
          }
        }
      })
    )
  } catch {}

  return Array.from(results.values())
}

/**
 * Atualiza o IP em uma URL RTSP preservando usuário, senha, porta e rota.
 */
export function replaceUrlHost(rawUrl: string, newIp: string): string {
  try {
    const trimmed = rawUrl.trim()
    const match = trimmed.match(/^(rtsp|https?):\/\/(?:([^:@]+):([^@]+)@)?([^:/]+)(?::(\d+))?(\/.*)?$/i)
    if (!match) return rawUrl
    const [, protocol, user, pass, , port, path] = match
    const auth = user && pass ? `${user}:${pass}@` : user ? `${user}@` : ''
    const portStr = port ? `:${port}` : ''
    const pathStr = path || ''
    return `${protocol}://${auth}${newIp}${portStr}${pathStr}`
  } catch {
    return rawUrl
  }
}

/**
 * Extrai o IP/host de uma URL de câmera.
 */
export function extractUrlHost(rawUrl: string): string | null {
  try {
    const match = rawUrl.trim().match(/^(?:rtsp|https?):\/\/(?:[^@]+@)?([^:/]+)/i)
    return match ? match[1] : null
  } catch {
    return null
  }
}
