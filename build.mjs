/**
 * MomAI Vision — build script (esbuild).
 * Bundles: worker runtime, CV engine (CJS sidecar), page and panel (ESM,
 * react external — provided by the host). Copies CV assets from assets/.
 *
 * Usage:
 *   node build.mjs           — one-shot build
 *   node build.mjs --watch   — rebuild on source change (dev workflow)
 */

import { context } from 'esbuild'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))
const outdir = path.join(root, 'dist')
const isWatch = process.argv.includes('--watch')

const external = ['react', 'react-dom', 'react/jsx-runtime', 'momai:sdk']

// ---------------------------------------------------------------------------
// esbuild contexts (one per entry point — each gets its own watch/rebuild)
// ---------------------------------------------------------------------------

const mirrorPlugin = {
  name: 'mirror-runtime-root',
  setup(build) {
    build.onEnd(() => {
      try { mirrorRuntimeRoot() } catch {}
    })
  }
}

const enginePatchPlugin = {
  name: 'patch-engine-import-meta',
  setup(build) {
    build.onEnd(() => {
      try { patchEngineImportMeta() } catch {}
    })
  }
}

const workerCtx = await context({
  entryPoints: [path.join(root, 'src/worker.ts')],
  outfile: path.join(outdir, 'runtime.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  logLevel: 'warning',
  plugins: [mirrorPlugin]
})

const engineCtx = await context({
  entryPoints: [path.join(root, 'src/engine.ts')],
  outfile: path.join(outdir, 'cv/engine.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  logLevel: 'warning',
  plugins: [enginePatchPlugin]
})

const uiContexts = []
for (const entry of ['src/page.tsx', 'src/panel.tsx']) {
  const name = path.basename(entry, '.tsx')
  uiContexts.push(
    await context({
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
  )
}

// MJPEG preview worker (OffscreenCanvas): o page.js referencia
// `./mjpeg-worker.js` via new URL(..., import.meta.url), que o host serve em
// /extensions/momai-vision/dist/mjpeg-worker.js — o mesmo diretório do bundle.
const mjpegCtx = await context({
  entryPoints: [path.join(root, 'src/mjpeg-worker.ts')],
  outfile: path.join(outdir, 'mjpeg-worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  sourcemap: false,
  logLevel: 'warning'
})

// ---------------------------------------------------------------------------
// Post-build helpers
// ---------------------------------------------------------------------------

/** Mirror runtime.js to repo root for the .dev junction workflow. */
function mirrorRuntimeRoot() {
  cpSync(path.join(outdir, 'runtime.js'), path.join(root, 'runtime.js'))
}

/**
 * Patch esbuild's `var import_meta = {};` in the CJS engine output so
 * onnxruntime-common gets the real `import.meta.url` it needs for WASM.
 */
function patchEngineImportMeta() {
  const enginePath = path.join(outdir, 'cv/engine.cjs')
  let engineSrc = readFileSync(enginePath, 'utf-8')
  engineSrc = engineSrc.replace(
    'var import_meta = {};',
    'var import_meta = { url: require("node:url").pathToFileURL(__filename).href };'
  )
  writeFileSync(enginePath, engineSrc)
}

function copyAssets() {
  mkdirSync(path.join(outdir, 'cv'), { recursive: true })
  mkdirSync(path.join(outdir, 'models'), { recursive: true })
  cpSync(path.join(root, 'assets/cv/ort-wasm-simd-threaded.wasm'), path.join(outdir, 'cv/ort-wasm-simd-threaded.wasm'))
  cpSync(path.join(root, 'assets/cv/ort-wasm-simd-threaded.mjs'), path.join(outdir, 'cv/ort-wasm-simd-threaded.mjs'))
  cpSync(path.join(root, 'assets/models/yolo11s.onnx'), path.join(outdir, 'models/yolo11s.onnx'))
}

// ---------------------------------------------------------------------------
// Build all contexts and apply post-build steps
// ---------------------------------------------------------------------------

async function buildAll() {
  await Promise.all([
    workerCtx.rebuild(),
    engineCtx.rebuild(),
    ...uiContexts.map((ctx) => ctx.rebuild()),
    mjpegCtx.rebuild()
  ])
  mirrorRuntimeRoot()
  patchEngineImportMeta()
  copyAssets()
  console.log('[momai-vision] build done')
}

await buildAll()

// ---------------------------------------------------------------------------
// Watch mode: rebuild on source change, re-apply post-build steps
// ---------------------------------------------------------------------------

if (isWatch) {
  await Promise.all([
    workerCtx.watch(),
    engineCtx.watch(),
    ...uiContexts.map((ctx) => ctx.watch()),
    mjpegCtx.watch()
  ])
  console.log('[momai-vision] watching for changes…')
} else {
  // One-shot: dispose contexts
  await Promise.all([
    workerCtx.dispose(),
    engineCtx.dispose(),
    ...uiContexts.map((ctx) => ctx.dispose()),
    mjpegCtx.dispose()
  ])
}
