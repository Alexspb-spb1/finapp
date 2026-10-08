// Worker of the claim race test: runs the rehearsal reading for ONE shared evidence namespace with a recorder fetch (no socket is opened) and a bootstrap that records its call.
// Prints "<status> bootstrap=<n> fetch=<n>".
//   node tests/recon-race-worker.mjs <evidence dir> <shared calls log>
import fs from 'node:fs'
import { makeWorld, rehearsalCfg, PKG } from './synthetic.mjs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const { runRecon } = await import(pathToFileURL(path.join(PKG, 'recon-core.mjs')).href)
const [evDir, callsLog] = process.argv.slice(2)
const { cfg, calls, bootstrapCalls } = rehearsalCfg(makeWorld(), { extra: {} })
cfg.evDir = evDir
const inner = cfg.fetchImpl
cfg.fetchImpl = async (...a) => { fs.appendFileSync(callsLog, `fetch\n`); return inner(...a) }
const innerBoot = cfg.bootstrap
cfg.bootstrap = (...a) => { fs.appendFileSync(callsLog, `bootstrap\n`); return innerBoot(...a) }
const r = await runRecon(cfg)
console.log(`${r.status} bootstrap=${bootstrapCalls.length} fetch=${calls.length}`)
