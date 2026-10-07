#!/usr/bin/env node
// Step-0 gate: validates the explicit staging web config and that the prepared
// build is bound to it. Local only, no network. Never prints values.
//
//   node check-web-config.mjs --web-config <abs file> --dist <abs staging build dir>
import fs from 'node:fs'
import path from 'node:path'
import { loadStagingWebConfig, Stop } from './m1-core.mjs'

const args = process.argv.slice(2), o = {}
for (let i = 0; i < args.length; i += 2) o[args[i]] = args[i + 1]
try {
  if (args.length !== 4 || !o['--web-config'] || !o['--dist']) throw new Stop('args', 'usage')
  const cfg = await loadStagingWebConfig(o['--web-config'])
  const assets = path.join(o['--dist'], 'assets')
  if (!path.isAbsolute(o['--dist']) || !fs.existsSync(assets)) throw new Stop('dist', 'staging build missing')
  const bundle = fs.readdirSync(assets).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(assets, f), 'utf8')).join('\n')
  const bound = bundle.includes(cfg.projectId) && bundle.includes(cfg.apiKey) && !bundle.includes('finapp-prod-10a83')
  if (!bound) throw new Stop('dist', 'build is not bound to the verified web config')
  console.log('WEB_CONFIG_VERIFIED projectId=finapp-staging preflight=PASS distBound=true (values not printed)')
} catch (e) {
  console.log(`WEB_CONFIG_BLOCKED ${e instanceof Stop ? e.message : 'unexpected error'}`)
  process.exitCode = 2
}
