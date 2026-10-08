// Local diagnostic: prints the verified ACL principals of a run directory (SIDs of users masked).
import fs from 'node:fs'
import path from 'node:path'
import { aclProblems, readAcl } from './m1-core.mjs'

const dir = process.argv[2]
if (!dir || !fs.existsSync(dir)) { console.log('missing dir'); process.exit(2) }
const mask = sid => (sid.startsWith('S-1-5-21-') ? 'CURRENT_USER' : sid === 'S-1-5-18' ? 'SYSTEM' : sid === 'S-1-5-32-544' ? 'Administrators' : sid)
const acl = readAcl(dir)
console.log(JSON.stringify({
  dir: path.basename(dir), protected: acl.protected,
  principals: acl.rules.map(r => `${mask(r.sid)}:${r.type}${r.inherited ? ':inherited' : ''}`),
  dirProblems: aclProblems(dir, { isDirectory: true }),
  fileProblems: fs.readdirSync(dir).flatMap(f => aclProblems(path.join(dir, f), { isDirectory: false }).map(p => `${f}: ${p}`)),
}))
