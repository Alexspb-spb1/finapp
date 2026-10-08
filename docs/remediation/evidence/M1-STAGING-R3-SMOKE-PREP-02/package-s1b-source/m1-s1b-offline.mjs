#!/usr/bin/env node
// Launcher of the OFFLINE modes of the S1b package (plan, selftest, permit-draft): builds an isolated environment (default-deny variables, empty profile/config
// directories, no credentials) with the loopback-only network fence preloaded, runs m1-s1b.mjs in it and reports how many network attempts the fence saw.
//   node m1-s1b-offline.mjs <plan|selftest|permit-draft>
// It never reads owner credentials and cannot reach a live system; the fence log of the run is kept in a temporary directory that is named in the output.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildIsolatedEnv } from './offline-fence/isolated-env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const cmd = process.argv[2]
if (!['plan', 'selftest', 'permit-draft'].includes(cmd)) { console.error('usage: m1-s1b-offline.mjs <plan|selftest|permit-draft>'); process.exit(3) }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-s1b-offline-'))
const fenceLog = path.join(root, 'fence.jsonl')
fs.writeFileSync(fenceLog, '')
const env = buildIsolatedEnv({ root: path.join(root, 'isolated'), fenceLog, fencePath: path.join(HERE, 'offline-fence', 'loopback-only.cjs') })
const r = spawnSync(process.execPath, [path.join(HERE, 'm1-s1b.mjs'), cmd], { env, stdio: 'inherit', windowsHide: true })
const events = fs.readFileSync(fenceLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
console.error(`M1_S1B_OFFLINE mode=${cmd} exit=${r.status} fenceEvents=${events.length} blocked=${events.filter(e => e.decision === 'blocked').length} log=${fenceLog}`)
process.exit(r.status ?? 1)
