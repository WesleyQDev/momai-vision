/**
 * Orphan FFmpeg cleanup for IP cameras — pure, testable command builders.
 *
 * When the host hard-restarts the worker (crash/hot reload) the FFmpeg child
 * can survive as an orphan, and these cameras commonly accept a single RTSP
 * session — so the orphan must go before the next attempt, or every retry
 * stays silent ("no RTP") while the stale session holds the camera.
 *
 * The command goes to PowerShell via `-EncodedCommand`: nested quotes in a
 * `-Command "..."` argument are mangled by cmd.exe (the previous
 * `-Filter "name = '...'"` form silently failed and orphans accumulated),
 * while the base64 payload carries no quoting at all.
 */

export function buildOrphanFfmpegKillScript(host: string): string {
  // Single-quote escape: the host comes from the camera URL and must never be
  // able to break out of the -like pattern.
  const safeHost = host.replace(/'/g, "''")
  return [
    'Get-CimInstance Win32_Process',
    `Where-Object { $_.Name -eq 'ffmpeg.exe' -and $_.CommandLine -like '*${safeHost}*' }`,
    // True orphans only: an FFmpeg whose parent process is still alive belongs
    // to another live worker and must be left alone — otherwise two workers
    // would kill each other's sessions in a loop.
    'Where-Object { -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue) }',
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'
  ].join(' | ')
}

export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}
