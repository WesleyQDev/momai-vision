import { describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import {
  directionToVelocity,
  createWsSecurityHeader,
  wrapSoapEnvelope,
  buildContinuousMoveEnvelope,
  buildStopEnvelope,
  buildGotoHomeEnvelope,
  buildGetPresetsEnvelope,
  buildGotoPresetEnvelope,
  buildGetStatusEnvelope,
  parseOnvifProfiles,
  parseOnvifPresets,
  parseCapabilitiesEndpoints,
  parsePtzStatus,
  clampStepDurationMs,
  resolvePtzCandidateUrls,
  dispatchPtzCommand,
  fetchPtzPresets,
  clearPtzCache
} from './onvif-ptz'

describe('ONVIF PTZ Module', () => {
  it('converte direções para vetores de velocidade corretos', () => {
    expect(directionToVelocity('up', 0.6)).toEqual({ x: 0, y: 0.6 })
    expect(directionToVelocity('down', 0.6)).toEqual({ x: 0, y: -0.6 })
    expect(directionToVelocity('left', 0.8)).toEqual({ x: -0.8, y: 0 })
    expect(directionToVelocity('right', 0.8)).toEqual({ x: 0.8, y: 0 })
    expect(directionToVelocity('zoom_in', 0.5)).toEqual({ x: 0, y: 0, zoom: 0.5 })
    expect(directionToVelocity('zoom_out', 0.5)).toEqual({ x: 0, y: 0, zoom: -0.5 })
  })

  it('gera cabeçalho WS-Security com hash SHA-1 válido', () => {
    const fixedNonce = Buffer.from('0123456789abcdef')
    const fixedDate = new Date('2026-10-24T12:00:00.000Z')
    const header = createWsSecurityHeader('admin', '123456', fixedDate, fixedNonce)

    expect(header).toContain('<wsse:Username>admin</wsse:Username>')
    expect(header).toContain('<wsse:Password Type=')
    expect(header).toContain('<wsse:Nonce EncodingType=')
    expect(header).toContain('<wsu:Created>2026-10-24T12:00:00.000Z</wsu:Created>')
  })

  it('retorna cabeçalho vazio se não houver usuário', () => {
    expect(createWsSecurityHeader('', '')).toBe('')
    expect(createWsSecurityHeader(undefined, '123')).toBe('')
  })

  it('monta envelope ContinuousMove com profileToken e velocidade', () => {
    const xml = buildContinuousMoveEnvelope({
      profileToken: 'IPCProfilesToken0',
      velocity: { x: 0.5, y: -0.5 },
      username: 'admin',
      password: 'pass'
    })

    expect(xml).toContain('<tptz:ContinuousMove>')
    expect(xml).toContain('<tptz:ProfileToken>IPCProfilesToken0</tptz:ProfileToken>')
    expect(xml).toContain('x="0.5" y="-0.5"')
    expect(xml).toContain('<wsse:Username>admin</wsse:Username>')
  })

  it('monta envelope ContinuousMove com timeout para passo rápido', () => {
    const xml = buildContinuousMoveEnvelope({
      profileToken: 'IPCProfilesToken0',
      velocity: { x: 0.7, y: 0 },
      timeout: 0.35
    })

    expect(xml).toContain('<tptz:ContinuousMove>')
    expect(xml).toContain('<tptz:Timeout>PT0.35S</tptz:Timeout>')
  })

  it('monta envelope Stop para interromper movimento', () => {
    const xml = buildStopEnvelope({
      profileToken: 'IPCProfilesToken0',
      panTilt: true,
      zoom: true
    })

    expect(xml).toContain('<tptz:Stop>')
    expect(xml).toContain('<tptz:ProfileToken>IPCProfilesToken0</tptz:ProfileToken>')
    expect(xml).toContain('<tptz:PanTilt>true</tptz:PanTilt>')
  })

  it('monta envelope GotoHomePosition para reposição do PTZ', () => {
    const xml = buildGotoHomeEnvelope({
      profileToken: 'IPCProfilesToken0'
    })

    expect(xml).toContain('<tptz:GotoHomePosition>')
    expect(xml).toContain('<tptz:ProfileToken>IPCProfilesToken0</tptz:ProfileToken>')
  })

  it('monta envelope GetStatus para ler a posição PTZ', () => {
    const xml = buildGetStatusEnvelope({ profileToken: 'IPCProfilesToken0' })
    expect(xml).toContain('<tptz:GetStatus>')
    expect(xml).toContain('<tptz:ProfileToken>IPCProfilesToken0</tptz:ProfileToken>')
  })

  it('limita a duração do passo a uma faixa segura', () => {
    expect(clampStepDurationMs(undefined)).toBe(500)
    expect(clampStepDurationMs(0)).toBe(500)
    expect(clampStepDurationMs(50)).toBe(100)
    expect(clampStepDurationMs(750)).toBe(750)
    expect(clampStepDurationMs(999999)).toBe(5000)
  })

  it('extrai pan/tilt/zoom e MoveStatus do GetStatusResponse', () => {
    const xml = `
      <s:Envelope><s:Body><tptz:GetStatusResponse><tptz:PTZStatus>
        <tt:Position>
          <tt:PanTilt x="0.25" y="-0.1" space="http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace"/>
          <tt:Zoom x="0.4"/>
        </tt:Position>
        <tt:MoveStatus><tt:PanTilt>IDLE</tt:PanTilt><tt:Zoom>IDLE</tt:Zoom></tt:MoveStatus>
      </tptz:PTZStatus></tptz:GetStatusResponse></s:Body></s:Envelope>`

    expect(parsePtzStatus(xml)).toEqual({
      position: {
        pan: 0.25,
        tilt: -0.1,
        zoom: 0.4,
        space: 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/PositionGenericSpace'
      },
      moveStatus: { panTilt: 'IDLE', zoom: 'IDLE' }
    })
  })

  it('retorna null quando a câmera não reporta Position', () => {
    expect(parsePtzStatus('<tptz:GetStatusResponse><tptz:PTZStatus/></tptz:GetStatusResponse>')).toBeNull()
    expect(parsePtzStatus('')).toBeNull()
  })

  it('monta envelopes de GetPresets e GotoPreset para locais salvos', () => {
    const getXml = buildGetPresetsEnvelope({ profileToken: 'IPCProfilesToken0' })
    expect(getXml).toContain('<tptz:GetPresets>')

    const gotoXml = buildGotoPresetEnvelope({
      profileToken: 'IPCProfilesToken0',
      presetToken: 'Preset_Portao'
    })
    expect(gotoXml).toContain('<tptz:GotoPreset>')
    expect(gotoXml).toContain('<tptz:PresetToken>Preset_Portao</tptz:PresetToken>')
  })

  it('extrai tokens de perfis ONVIF do XML de resposta', () => {
    const mockXml = `
      <trt:GetProfilesResponse>
        <trt:Profiles token="IPCProfilesToken0" fixed="true">
          <tt:Name>MainStream</tt:Name>
        </trt:Profiles>
        <trt:Profiles token="IPCProfilesToken1" fixed="true">
          <tt:Name>SubStream</tt:Name>
        </trt:Profiles>
      </trt:GetProfilesResponse>
    `
    const profiles = parseOnvifProfiles(mockXml)
    expect(profiles).toEqual(['IPCProfilesToken0', 'IPCProfilesToken1'])
  })

  it('extrai endpoints de PTZ e Media da resposta do GetCapabilities', () => {
    const mockXml = `
      <tds:GetCapabilitiesResponse>
        <tds:Capabilities>
          <tt:Media><tt:XAddr>http://192.168.0.3:5000/onvif/ptz_service</tt:XAddr></tt:Media>
          <tt:PTZ><tt:XAddr>http://192.168.0.3:5000/onvif/deviceio_service</tt:XAddr></tt:PTZ>
        </tds:Capabilities>
      </tds:GetCapabilitiesResponse>
    `
    const endpoints = parseCapabilitiesEndpoints(mockXml)
    expect(endpoints.ptzUrl).toBe('http://192.168.0.3:5000/onvif/deviceio_service')
    expect(endpoints.mediaUrl).toBe('http://192.168.0.3:5000/onvif/ptz_service')
  })

  it('extrai presets do XML de resposta do GetPresets', () => {
    const mockXml = `
      <tptz:GetPresetsResponse>
        <tptz:Preset token="1">
          <tt:Name>Portão de Entrada</tt:Name>
        </tptz:Preset>
        <tptz:Preset token="2">
          <tt:Name>Garagem</tt:Name>
        </tptz:Preset>
      </tptz:GetPresetsResponse>
    `
    const presets = parseOnvifPresets(mockXml)
    expect(presets).toEqual([
      { token: '1', name: 'Portão de Entrada' },
      { token: '2', name: 'Garagem' }
    ])
  })

  it('resolve URLs candidatas com base no host', () => {
    const urls = resolvePtzCandidateUrls('192.168.0.50')
    expect(urls).toContain('http://192.168.0.50:5000/onvif/device_service')
    expect(urls).toContain('http://192.168.0.50:8000/onvif/device_service')
    expect(urls).toContain('http://192.168.0.50:80/onvif/device_service')
  })

  it('despacha comandos move e stop mockando http.request', async () => {
    clearPtzCache()
    const mockResponseXml = '<s:Envelope><s:Body><tptz:ContinuousMoveResponse/></s:Body></s:Envelope>'

    const spy = vi.spyOn(http, 'request').mockImplementation((options: any, callback: any) => {
      const res = new EventEmitter() as any
      res.statusCode = 200
      res.resume = vi.fn()
      process.nextTick(() => {
        if (callback) callback(res)
        res.emit('data', Buffer.from(mockResponseXml))
        res.emit('end')
      })
      const req = new EventEmitter() as any
      req.write = vi.fn()
      req.end = vi.fn(() => {
        process.nextTick(() => req.emit('finish'))
      })
      req.destroy = vi.fn()
      return req
    })

    try {
      const result = await dispatchPtzCommand({
        host: '192.168.0.50',
        action: 'move',
        direction: 'up',
        customServiceUrl: 'http://192.168.0.50:5000/onvif/deviceio_service'
      })
      expect(result.ok).toBe(true)
      expect(result.action).toBe('move')

      const stopResult = await dispatchPtzCommand({
        host: '192.168.0.50',
        action: 'stop',
        customServiceUrl: 'http://192.168.0.50:5000/onvif/deviceio_service'
      })
      expect(stopResult.ok).toBe(true)
      expect(stopResult.action).toBe('stop')
    } finally {
      spy.mockRestore()
    }
  })

  it('executa passo com parada automática e devolve a posição', async () => {
    clearPtzCache()
    const bodies: string[] = []
    const moveXml = '<s:Envelope><s:Body><tptz:ContinuousMoveResponse/></s:Body></s:Envelope>'
    const statusXml = `
      <s:Envelope><s:Body><tptz:GetStatusResponse><tptz:PTZStatus>
        <tt:Position><tt:PanTilt x="0.5" y="0.2"/><tt:Zoom x="0.1"/></tt:Position>
        <tt:MoveStatus><tt:PanTilt>IDLE</tt:PanTilt></tt:MoveStatus>
      </tptz:PTZStatus></tptz:GetStatusResponse></s:Body></s:Envelope>`

    const spy = vi.spyOn(http, 'request').mockImplementation((_options: any, callback: any) => {
      const req = new EventEmitter() as any
      req.write = vi.fn((xml: string) => bodies.push(xml))
      req.end = vi.fn(() => {
        process.nextTick(() => req.emit('finish'))
      })
      req.destroy = vi.fn()
      const res = new EventEmitter() as any
      res.statusCode = 200
      res.resume = vi.fn()
      process.nextTick(() => {
        if (callback) callback(res)
        const last = bodies[bodies.length - 1] || ''
        res.emit('data', Buffer.from(last.includes('GetStatus') ? statusXml : moveXml))
        res.emit('end')
      })
      return req
    })

    try {
      const result = await dispatchPtzCommand({
        host: '192.168.0.50',
        action: 'step',
        direction: 'right',
        durationMs: 50,
        customServiceUrl: 'http://192.168.0.50:5000/onvif/deviceio_service'
      })

      expect(result.ok).toBe(true)
      expect(result.action).toBe('step')
      expect(result.durationMs).toBe(100)
      expect(result.stopped).toBe(true)
      expect(result.position).toMatchObject({ pan: 0.5, tilt: 0.2, zoom: 0.1 })
      // The step must start the move but never leave the motor running.
      expect(bodies.filter((xml) => xml.includes('<tptz:ContinuousMove>'))).toHaveLength(2)
      expect(bodies.some((xml) => xml.includes('<tptz:GetStatus>'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('lê a posição absoluta via action status', async () => {
    clearPtzCache()
    const statusXml = `
      <s:Envelope><s:Body><tptz:GetStatusResponse><tptz:PTZStatus>
        <tt:Position><tt:PanTilt x="-0.3" y="0.15"/><tt:Zoom x="0"/></tt:Position>
      </tptz:PTZStatus></tptz:GetStatusResponse></s:Body></s:Envelope>`

    const spy = vi.spyOn(http, 'request').mockImplementation((_options: any, callback: any) => {
      const res = new EventEmitter() as any
      res.statusCode = 200
      process.nextTick(() => {
        if (callback) callback(res)
        res.emit('data', Buffer.from(statusXml))
        res.emit('end')
      })
      const req = new EventEmitter() as any
      req.write = vi.fn()
      req.end = vi.fn()
      req.destroy = vi.fn()
      return req
    })

    try {
      const result = await dispatchPtzCommand({
        host: '192.168.0.50',
        action: 'status',
        customServiceUrl: 'http://192.168.0.50:5000/onvif/deviceio_service'
      })
      expect(result.ok).toBe(true)
      expect(result.position).toMatchObject({ pan: -0.3, tilt: 0.15, zoom: 0 })
    } finally {
      spy.mockRestore()
    }
  })

  it('busca presets da câmera com sucesso mockando http.request', async () => {
    clearPtzCache()
    const mockXml = `
      <s:Envelope>
        <s:Body>
          <tptz:GetPresetsResponse>
            <tptz:Preset token="10"><tt:Name>Piscina</tt:Name></tptz:Preset>
          </tptz:GetPresetsResponse>
        </s:Body>
      </s:Envelope>`

    const spy = vi.spyOn(http, 'request').mockImplementation((options: any, callback: any) => {
      const res = new EventEmitter() as any
      res.statusCode = 200
      process.nextTick(() => {
        if (callback) callback(res)
        res.emit('data', Buffer.from(mockXml))
        res.emit('end')
      })
      const req = new EventEmitter() as any
      req.write = vi.fn()
      req.end = vi.fn()
      req.destroy = vi.fn()
      return req
    })

    try {
      const res = await fetchPtzPresets(
        '192.168.0.50'
      )
      expect(res.ok).toBe(true)
      expect(res.presets).toEqual([{ token: '10', name: 'Piscina' }])
    } finally {
      spy.mockRestore()
    }
  })
})
