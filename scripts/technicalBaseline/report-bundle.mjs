#!/usr/bin/env node
// BASE-005 — reproducible production bundle report.
//
// Node-only, zero new dependencies. Reads dist/index.html,
// dist/.vite/manifest.json, and dist/assets/** produced by:
//   npm run build -- --manifest
// and writes docs/remediation/evidence/BASE-005-bundle-report.json.
//
// "initial JS" is defined explicitly as: the entry chunk's JS file plus the
// full transitive closure of its STATIC imports (manifest `imports`, which
// Vite populates recursively for statically-imported chunks). Chunks only
// reachable via `dynamicImports` (import()) are reported separately and are
// NOT counted in the initial JS totals.
//
// Never reads/reports .env contents or Firebase config — only file
// names/sizes/hashes and the manifest's own structural graph.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const DIST_DIR = path.join(REPO_ROOT, 'dist')
const MANIFEST_PATH = path.join(DIST_DIR, '.vite', 'manifest.json')

function fail(msg) {
  console.error(`BASE-005 bundle report FAILED: ${msg}`)
  process.exit(1)
}

if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  fail('dist/index.html not found — run `npm run build -- --manifest` first.')
}
if (!fs.existsSync(MANIFEST_PATH)) {
  fail('dist/.vite/manifest.json not found — run `npm run build -- --manifest` (not a plain `npm run build`).')
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))

function sha256Of(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}
function gzipSizeOf(buf) {
  return zlib.gzipSync(buf, { level: zlib.constants.Z_BEST_COMPRESSION }).length
}
function brotliSizeOf(buf) {
  return zlib.brotliCompressSync(buf, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY },
  }).length
}

function assetInfo(relFile) {
  const abs = path.join(DIST_DIR, relFile)
  const buf = fs.readFileSync(abs)
  return {
    file: relFile,
    rawBytes: buf.length,
    gzipBytes: gzipSizeOf(buf),
    brotliBytes: brotliSizeOf(buf),
    sha256: sha256Of(buf),
  }
}

// ── Locate entry ────────────────────────────────────────────────────────
const entryKey = Object.keys(manifest).find(k => manifest[k].isEntry)
if (!entryKey) fail('No isEntry chunk found in manifest — cannot determine initial JS.')
const entryChunk = manifest[entryKey]

// ── Static transitive closure (BFS over `imports`) — this IS "initial JS" ──
const staticClosureKeys = new Set()
const queue = [entryKey]
while (queue.length) {
  const key = queue.shift()
  if (staticClosureKeys.has(key)) continue
  staticClosureKeys.add(key)
  const chunk = manifest[key]
  for (const imp of chunk.imports ?? []) queue.push(imp)
}

// ── Dynamic-only chunks: reachable via dynamicImports from ANY manifest
//    entry, but not part of the static closure above. ──────────────────────
const dynamicOnlyKeys = new Set()
for (const key of Object.keys(manifest)) {
  for (const dyn of manifest[key].dynamicImports ?? []) {
    if (!staticClosureKeys.has(dyn)) dynamicOnlyKeys.add(dyn)
  }
}

function jsFileOf(key) { return manifest[key].file }
function cssFilesOf(key) { return manifest[key].css ?? [] }

const staticJsFiles = [...new Set([...staticClosureKeys].map(jsFileOf))]
const staticCssFiles = [...new Set([...staticClosureKeys].flatMap(cssFilesOf))]
const dynamicJsFiles = [...new Set([...dynamicOnlyKeys].map(jsFileOf))]
const dynamicCssFiles = [...new Set([...dynamicOnlyKeys].flatMap(cssFilesOf))]

// ── Enumerate every asset actually present under dist/assets ───────────────
const assetsDir = path.join(DIST_DIR, 'assets')
const allAssetFiles = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir).map(f => `assets/${f}`)
  : []
const allJsFiles = allAssetFiles.filter(f => f.endsWith('.js'))
const allCssFiles = allAssetFiles.filter(f => f.endsWith('.css'))

const assetReports = {}
for (const f of allAssetFiles) assetReports[f] = assetInfo(f)

// ── Total dist/ size (every file, recursively) ─────────────────────────────
function walk(dir) {
  let files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files = files.concat(walk(full))
    else files.push(full)
  }
  return files
}
const totalDistBytes = walk(DIST_DIR).reduce((sum, f) => sum + fs.statSync(f).size, 0)

// ── Initial JS totals (static closure only) ─────────────────────────────────
function sumField(files, field) {
  return files.reduce((s, f) => s + (assetReports[f]?.[field] ?? 0), 0)
}
const initialJs = {
  files: staticJsFiles,
  rawBytes: sumField(staticJsFiles, 'rawBytes'),
  gzipBytes: sumField(staticJsFiles, 'gzipBytes'),
  brotliBytes: sumField(staticJsFiles, 'brotliBytes'),
}
const initialCss = {
  files: staticCssFiles,
  rawBytes: sumField(staticCssFiles, 'rawBytes'),
  gzipBytes: sumField(staticCssFiles, 'gzipBytes'),
  brotliBytes: sumField(staticCssFiles, 'brotliBytes'),
}
const dynamicJs = {
  files: dynamicJsFiles,
  rawBytes: sumField(dynamicJsFiles, 'rawBytes'),
  gzipBytes: sumField(dynamicJsFiles, 'gzipBytes'),
  brotliBytes: sumField(dynamicJsFiles, 'brotliBytes'),
}

// ── Versions / commit ───────────────────────────────────────────────────────
let gitSha = 'UNKNOWN'
try { gitSha = execSync('git rev-parse HEAD', { cwd: REPO_ROOT }).toString().trim() } catch { /* not fatal */ }

let viteVersion = 'UNKNOWN'
try {
  viteVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'node_modules/vite/package.json'), 'utf8')).version
} catch { /* not fatal */ }

let npmVersion = 'UNKNOWN'
try { npmVersion = execSync('npm --version', { cwd: REPO_ROOT }).toString().trim() } catch { /* not fatal */ }

const output = {
  sourceGitSha: gitSha,
  generatedAt: new Date().toISOString(),
  toolVersions: {
    node: process.version,
    npm: npmVersion,
    vite: viteVersion,
  },
  buildCommand: 'npm run build -- --manifest',
  entry: {
    manifestKey: entryKey,
    jsFile: entryChunk.file,
  },
  staticImportChain: {
    description: 'BFS closure of manifest `imports` starting from the entry chunk — this defines "initial JS".',
    manifestKeys: [...staticClosureKeys],
  },
  initialJs,
  initialCss,
  dynamicChunks: {
    description: 'Chunks reachable only via manifest `dynamicImports` (import()), NOT included in initial JS/CSS.',
    manifestKeys: [...dynamicOnlyKeys],
    js: dynamicJs,
  },
  assets: allAssetFiles.map(f => assetReports[f]).sort((a, b) => a.file.localeCompare(b.file)),
  counts: {
    totalJsChunks: allJsFiles.length,
    totalCssFiles: allCssFiles.length,
    totalAssetFiles: allAssetFiles.length,
  },
  totalDistBytes,
}

const outDir = path.join(REPO_ROOT, 'docs/remediation/evidence')
fs.mkdirSync(outDir, { recursive: true })
const outPath = path.join(outDir, 'BASE-005-bundle-report.json')
fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n')

console.log(`Entry JS: ${entryChunk.file}`)
console.log(`Initial JS: ${initialJs.files.length} file(s), raw=${initialJs.rawBytes}B gzip=${initialJs.gzipBytes}B brotli=${initialJs.brotliBytes}B`)
console.log(`Initial CSS: ${initialCss.files.length} file(s), raw=${initialCss.rawBytes}B gzip=${initialCss.gzipBytes}B brotli=${initialCss.brotliBytes}B`)
console.log(`Dynamic-only JS chunks: ${dynamicJs.files.length}`)
console.log(`Total JS chunks: ${allJsFiles.length}, total CSS files: ${allCssFiles.length}, total dist size: ${totalDistBytes}B`)
console.log(`Written to: ${outPath}`)
