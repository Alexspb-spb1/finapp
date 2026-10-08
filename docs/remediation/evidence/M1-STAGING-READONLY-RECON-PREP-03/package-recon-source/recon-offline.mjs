#!/usr/bin/env node
// Launcher of the OFFLINE modes of the read-only reconciliation package (plan, selftest, permit-draft): builds an isolated environment (default-deny variables, empty
// profile/config directories, no credentials) with the loopback-only network fence preloaded, runs recon.mjs in it and reports how many network attempts the fence saw.
//   node recon-offline.mjs <plan|selftest|permit-draft>
// It never reads the owner credential file and cannot reach a live system.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildIsolatedEnv } from './offline-fence/isolated-env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const cmd = process.argv[2]
if (!['plan', 'selftest', 'permit-draft'].includes(cmd)) { console.error('usage: recon-offline.mjs <plan|selftest|permit-draft>'); process.exit(3) }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-recon-offline-'))
const fenceLog = path.join(root, 'fence.jsonl')
fs.writeFileSync(fenceLog, '')
const env = buildIsolatedEnv({ root: path.join(root, 'isolated'), fenceLog, fencePath: path.join(HERE, 'offline-fence', 'loopback-only.cjs') })
const r = spawnSync(process.execPath, [path.join(HERE, 'recon.mjs'), cmd], { env, stdio: 'inherit', windowsHide: true })
const events = fs.readFileSync(fenceLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
console.error(`M1_RECON_OFFLINE mode=${cmd} exit=${r.status} fenceEvents=${events.length} blocked=${events.filter(e => e.decision === 'blocked').length} log=${fenceLog}`)
process.exit(r.status ?? 1)
