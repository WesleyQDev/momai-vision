/**
 * MomAI Vision — release ZIP builder.
 *
 * Produces a self-contained extension archive (manifest, SKILL.md, worker
 * runtime, UI bundles, CV assets) plus a .sha256 checksum file.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { createRequire } from 'node:module'

const root = join(process.cwd())
const dist = join(root, 'dist')

// Minimal ZIP writer (no external deps): stored (uncompressed) entries.
// The archive contains mostly already-compressed media (wasm/onnx/jpeg),
// so STORE is both fast and fine size-wise.
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let crc = -1
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

function dosDateTime(date = new Date()) {
  return [
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  ]
}

function buildZip(files) {
  const chunks = []
  const central = []
  let offset = 0
  const [dosDate, dosTime] = dosDateTime()

  for (const { path: name, data } of files) {
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // flags: UTF-8 names
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(Buffer.byteLength(name), 26)
    local.writeUInt16LE(0, 28)
    const nameBuf = Buffer.from(name, 'utf-8')
    chunks.push(local, nameBuf, data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(0, 10) // method
    centralHeader.writeUInt16LE(dosTime, 12)
    centralHeader.writeUInt16LE(dosDate, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(data.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(Buffer.byteLength(name), 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, nameBuf)
    offset += 30 + Buffer.byteLength(name) + data.length
  }

  const centralSize = central.reduce((acc, b) => acc + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, ...central, end])
}

function collectFiles(dir, prefix = '') {
  const { readdirSync, statSync } = require('node:fs')
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...collectFiles(full, `${prefix}${entry}/`))
    } else {
      out.push({ path: `${prefix}${entry}`, data: readFileSync(full) })
    }
  }
  return out
}

const require = createRequire(import.meta.url)

async function main() {
  if (!existsSync(join(dist, 'runtime.js')) || !existsSync(join(dist, 'page.js')) || !existsSync(join(dist, 'panel.js'))) {
    console.error('[release-zip] run `pnpm build` first')
    process.exit(1)
  }

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8'))
  const version = process.env.MOMAI_VISION_VERSION || pkg.version || '1.0.0'
  const outDir = join(root, 'release')
  mkdirSync(outDir, { recursive: true })
  const outFile = join(outDir, `momai-vision-v${version}.zip`)

  const files = [
    { path: 'manifest.json', data: readFileSync(join(root, 'manifest.json')) },
    { path: 'SKILL.md', data: readFileSync(join(root, 'SKILL.md')) },
    { path: 'package.json', data: readFileSync(join(root, 'package.json')) },
    { path: 'runtime.js', data: readFileSync(join(dist, 'runtime.js')) },
    ...collectFiles(join(dist, 'cv'), 'cv/'),
    ...collectFiles(join(dist, 'models'), 'models/')
  ]
  // UI bundles land in dist/ inside the archive.
  for (const name of ['page.js', 'panel.js']) {
    const full = join(dist, name)
    if (existsSync(full)) files.push({ path: `dist/${name}`, data: readFileSync(full) })
  }

  const zip = buildZip(files)
  writeFileSync(outFile, zip)

  const sha = createHash('sha256').update(zip).digest('hex')
  writeFileSync(`${outFile}.sha256`, `${sha}  ${outFile.split(/[\\/]/).pop()}\n`)

  const mb = (zip.length / 1024 / 1024).toFixed(1)
  console.log(`[release-zip] ${outFile} (${mb} MB)`)
  console.log(`[release-zip] sha256: ${sha}`)
  if (manifest.id !== 'momai-vision') {
    console.error('[release-zip] unexpected manifest id')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
