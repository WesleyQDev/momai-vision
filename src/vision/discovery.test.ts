import { describe, expect, it } from 'vitest'
import {
  extractUrlHost,
  lookupArpMac,
  parseWsDiscoveryResponse,
  replaceUrlHost
} from './discovery'

describe('ONVIF Discovery & IP Helpers', () => {
  it('extracts host from standard and authenticated URLs', () => {
    expect(extractUrlHost('rtsp://192.168.0.4:554/onvif1')).toBe('192.168.0.4')
    expect(extractUrlHost('rtsp://admin:secret123@192.168.1.100:554/live/ch0')).toBe('192.168.1.100')
    expect(extractUrlHost('http://user:pass@camera.local/mjpeg')).toBe('camera.local')
    expect(extractUrlHost('invalid-url')).toBeNull()
  })

  it('replaces IP while preserving credentials, port and path', () => {
    expect(replaceUrlHost('rtsp://admin:secret123@192.168.0.4:554/onvif1', '192.168.0.15')).toBe(
      'rtsp://admin:secret123@192.168.0.15:554/onvif1'
    )
    expect(replaceUrlHost('rtsp://192.168.0.4:554/onvif2', '192.168.0.22')).toBe(
      'rtsp://192.168.0.22:554/onvif2'
    )
    expect(replaceUrlHost('http://admin:pass@192.168.0.10/video', '192.168.0.30')).toBe(
      'http://admin:pass@192.168.0.30/video'
    )
  })

  it('parses WS-Discovery probe match XML correctly', () => {
    const sampleXml = `<?xml version="1.0" encoding="utf-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <SOAP-ENV:Header>
    <wsa:MessageID>uuid:12345678-1234-1234-1234-1234567890ab</wsa:MessageID>
    <wsa:RelatesTo>uuid:87654321-4321-4321-4321-ba0987654321</wsa:RelatesTo>
    <wsa:To>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:To>
    <wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</wsa:Action>
  </SOAP-ENV:Header>
  <SOAP-ENV:Body>
    <d:ProbeMatches>
      <d:ProbeMatch>
        <wsa:EndpointReference>
          <wsa:Address>urn:uuid:a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d</wsa:Address>
        </wsa:EndpointReference>
        <d:Types>dn:NetworkVideoTransmitter</d:Types>
        <d:Scopes>onvif://www.onvif.org/name/Portao%20Principal onvif://www.onvif.org/hardware/CamModelX</d:Scopes>
        <d:XAddrs>http://192.168.0.48:8000/onvif/device_service</d:XAddrs>
        <d:MetadataVersion>1</d:MetadataVersion>
      </d:ProbeMatch>
    </d:ProbeMatches>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`

    const parsed = parseWsDiscoveryResponse(sampleXml, '192.168.0.48')
    expect(parsed).not.toBeNull()
    expect(parsed?.ip).toBe('192.168.0.48')
    expect(parsed?.urn).toBe('urn:uuid:a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d')
    expect(parsed?.name).toBe('Portao Principal')
    expect(parsed?.suggestedUrl).toBe('rtsp://192.168.0.48:554/onvif1')
  })

  it('rejects invalid or malicious IP strings in lookupArpMac', async () => {
    expect(await lookupArpMac('')).toBeNull()
    expect(await lookupArpMac('192.168.1.1; calc.exe')).toBeNull()
    expect(await lookupArpMac('192.168.1.1 & whoami')).toBeNull()
    expect(await lookupArpMac('invalid')).toBeNull()
  })
})
