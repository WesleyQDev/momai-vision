import { describe, expect, it } from 'vitest'
import { buildOrphanFfmpegKillScript, encodePowerShellCommand } from './orphan-ffmpeg'

describe('orphan FFmpeg cleanup command', () => {
  it('kills only true orphan ffmpeg processes of the camera host', () => {
    const script = buildOrphanFfmpegKillScript('192.168.0.2')
    expect(script).toContain("$_.Name -eq 'ffmpeg.exe'")
    expect(script).toContain("-like '*192.168.0.2*'")
    // A live parent keeps its FFmpeg (another worker's session).
    expect(script).toContain('Get-Process -Id $_.ParentProcessId')
    expect(script).toContain('Stop-Process -Id $_.ProcessId -Force')
    // Nested double quotes get mangled by cmd.exe before PowerShell runs —
    // that is exactly how the previous cleanup failed silently.
    expect(script).not.toContain('"')
  })

  it('escapes quotes in the host so it cannot break out of the pattern', () => {
    const script = buildOrphanFfmpegKillScript("x'; Remove-Item C: -Recurse; '")
    // Every quote is doubled, and the -like pattern still closes after it.
    expect(script).toContain("-like '*x''; Remove-Item C: -Recurse; ''*'")
  })

  it('encodes the script as UTF-16LE base64 for -EncodedCommand', () => {
    const script = buildOrphanFfmpegKillScript('10.0.0.1')
    const encoded = encodePowerShellCommand(script)
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/)
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(script)
  })
})
