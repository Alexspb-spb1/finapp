#!/usr/bin/env node
// Local-only verification of the privately prepared deployment artifact.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const args = process.argv.slice(2)
const originalFetch = globalThis.fetch
try {
  if (args.length !== 6 || args[0] !== '--manifest' || args[2] !== '--expected-manifest-sha' || args[4] !== '--expected-head' ||
      !path.isAbsolute(args[1]) || !/^[a-f0-9]{64}$/.test(args[3]) || !/^[a-f0-9]{40}$/.test(args[5])) throw new Error('arguments')
  const git = command => execFileSync('git', command, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const checkGit = () => {
    if (git(['rev-parse', 'HEAD']) !== args[5] || git(['status', '--porcelain', '--untracked-files=all']) !== '') throw new Error('git')
  }
  checkGit()
  const raw = fs.readFileSync(args[1])
  if (sha256(raw) !== args[3]) throw new Error('manifest')
  const manifest = JSON.parse(raw)
  if (sha256(fs.readFileSync(path.join(path.dirname(args[1]), 'functions-source.zip'))) !== manifest.functionsZipSha256 ||
      sha256(fs.readFileSync(path.join(root, 'firebase.json'))) !== manifest.firebaseConfigSha256 ||
      sha256(fs.readFileSync(path.join(root, 'firestore.rules'))) !== manifest.firestoreRulesSha256) throw new Error('artifact')
  const require = createRequire(import.meta.url)
  // Loading local packaging modules must never make a network request.
  globalThis.fetch = () => { throw new Error('network forbidden') }
  const { readdirRecursive } = require(path.join(root, 'node_modules/firebase-tools/lib/fsAsync.js'))
  const { getSourceHash } = require(path.join(root, 'node_modules/firebase-tools/lib/deploy/functions/cache/hash.js'))
  const config = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8')).functions
  if (config.source !== 'functions' || !Array.isArray(config.ignore)) throw new Error('config')
  const entries = await readdirRecursive({ path: path.join(root, 'functions'),
    ignoreStrings: [...config.ignore, 'firebase-debug.log', 'firebase-debug.*.log', '.runtimeconfig.json'] })
  const names = entries.map(entry => path.relative(root, entry.name).split(path.sep).join('/')).sort()
  if (JSON.stringify(names) !== JSON.stringify(manifest.files.map(entry => entry.path).sort()) ||
      names.some(name => /(?:\.log$|\/\.env|\/\.secret|\/node_modules\/)/.test(name))) throw new Error('file set')
  const contentHashes = await Promise.all(entries.map(entry => getSourceHash(entry.name)))
  if (createHash('sha1').update(contentHashes.sort().join('')).digest('hex') !== manifest.functionsSourceSha1) throw new Error('source')
  const staticNames = []
  const walk = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name)
      if (entry.isDirectory()) walk(filename)
      else staticNames.push(path.relative(root, filename).split(path.sep).join('/'))
    }
  }
  walk(path.join(root, 'dist'))
  if (JSON.stringify(staticNames.sort()) !== JSON.stringify(manifest.staticFiles.map(entry => entry.path).sort())) throw new Error('static set')
  for (const entry of [...manifest.files, ...manifest.staticFiles]) {
    if (typeof entry.path !== 'string' || !/^(functions|dist)\//.test(entry.path) || entry.path.split('/').includes('..')) throw new Error('path')
    const filename = path.join(root, entry.path)
    const relative = path.relative(fs.realpathSync(root), fs.realpathSync(filename))
    if (relative.startsWith('..') || path.isAbsolute(relative) || sha256(fs.readFileSync(filename)) !== entry.sha256) throw new Error('file')
  }
  checkGit()
  console.log('RELEASE_ARTIFACT_VERIFIED_LOCAL: exact source/static file sets, hashes, archive and clean HEAD match; cloud actions 0.')
} catch {
  console.error('RELEASE_ARTIFACT_STOPPED: argument, HEAD, file set or artifact hash mismatch; no cloud actions.')
  process.exitCode = 2
} finally {
  globalThis.fetch = originalFetch
}
