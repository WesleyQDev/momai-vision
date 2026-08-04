/**
 * MomAI Vision — build script (esbuild).
 * Bundles: worker runtime, CV engine (CJS sidecar), page and panel (ESM,
 * react external — provided by the host). Copies CV assets from assets/.
 */

import { build } from 'esbuild'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const outdir = path.join(root, 'dist')

const external = ['react', 'react-dom', 'react/jsx-runtime', 'momai:sdk']

await build({
  entryPoints: [path.join(root, 'src/runtime.ts')],
  outfile: path.join(outdir, 'runtime.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  logLevel: 'warning'
})

// Dev-mode convenience: the extension host worker always loads
// `<skillPath>/runtime.js`, and the .dev junction points at the repo root —
// mirror the bundle there so `pnpm dev` picks it up (gitignored).
cpSync(path.join(outdir, 'runtime.js'), path.join(root, 'runtime.js'))

await build({
  entryPoints: [path.join(root, 'src/engine.ts')],
  outfile: path.join(outdir, 'cv/engine.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  logLevel: 'warning'
})

// esbuild leaves `var import_meta = {}` in CJS output; the bundled
// onnxruntime-common needs import.meta.url (file: URL) for its dynamic
// requires — inject the real value from __filename.
{
  const enginePath = path.join(outdir, 'cv/engine.cjs')
  let engineSrc = readFileSync(enginePath, 'utf-8')
  engineSrc = engineSrc.replace(
    'var import_meta = {};',
    'var import_meta = { url: require("node:url").pathToFileURL(__filename).href };'
  )
  writeFileSync(enginePath, engineSrc)
}

for (const entry of ['src/page.tsx', 'src/panel.tsx']) {
  const name = path.basename(entry, '.tsx')
  await build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(outdir, `${name}.js`),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    external,
    sourcemap: false,
    logLevel: 'warning'
  })
}

mkdirSync(path.join(outdir, 'cv'), { recursive: true })
mkdirSync(path.join(outdir, 'models'), { recursive: true })
cpSync(path.join(root, 'assets/cv/ort-wasm-simd-threaded.wasm'), path.join(outdir, 'cv/ort-wasm-simd-threaded.wasm'))
cpSync(path.join(root, 'assets/cv/ort-wasm-simd-threaded.mjs'), path.join(outdir, 'cv/ort-wasm-simd-threaded.mjs'))
cpSync(path.join(root, 'assets/models/yolo11n.onnx'), path.join(outdir, 'models/yolo11n.onnx'))

console.log('[momai-vision] build done')
