// Test-only helper: writes a SYNTHETIC finapp-rules-backup-v1 of the live pre-release Rules - the CRLF form of
// the round-2 reference shipped in the package, which is exactly what the pinned live raw hash describes.
// The real backup is a read of the live ruleset (stagingResources backup-rules); this one involves no network.
//   node tests/make-synthetic-backup.mjs --out <new abs file>
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== '--out' || !path.isAbsolute(args[1]) || fs.existsSync(args[1])) { console.log('MAKE_SYNTHETIC_BACKUP_STOP usage'); process.exit(2) }
const expected = JSON.parse(fs.readFileSync(path.join(PKG, 'expected-state-r3.json'), 'utf8'))
const content = fs.readFileSync(path.join(PKG, expected.rollback.blobFile), 'utf8').replace(/\r?\n/g, '\r\n')
const sha = v => createHash('sha256').update(v).digest('hex')
fs.writeFileSync(args[1], `${JSON.stringify({
  format: 'finapp-rules-backup-v1', project: 'finapp-staging', database: 'projects/finapp-staging/databases/(default)', sourceHead: expected.sourceHead, capturedAt: new Date().toISOString(),
  release: { name: 'projects/finapp-staging/releases/cloud.firestore', rulesetName: expected.rulesPre.rulesetName }, rulesetName: expected.rulesPre.rulesetName,
  source: { files: [{ name: 'firestore.rules', content }] },
  canonicalSha256: sha(content.replace(/\r\n?/g, '\n')), rawSha256: sha(content), sourceBytes: Buffer.byteLength(content),
}, null, 2)}\n`, { flag: 'wx' })
console.log('MAKE_SYNTHETIC_BACKUP_WRITTEN')
