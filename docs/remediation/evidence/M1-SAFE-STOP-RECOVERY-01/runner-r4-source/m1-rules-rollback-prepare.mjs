#!/usr/bin/env node
// FINAPP-1.0-M1 R3 - prepares an isolated Rules rollback directory from the FRESH Rules backup taken at the
// start of this run (format finapp-rules-backup-v1 written by stagingResources.mjs backup-rules). The backup
// holds the live pre-release (round-2) Rules; the rollback re-publishes exactly those bytes.
// Local only. The backup is only READ; a new directory receives firestore.rules + firebase.json.
//
// Verification before anything is written (any mismatch = exit 2, nothing prepared):
//   * the backup source hashes to the expected canonical (CRLF-normalised) SHA-256 and to the
//     expected RAW SHA-256 (the line endings the live ruleset really has), and has exactly the expected size;
//   * the backup source equals, after CRLF normalisation, the round-2 file from git 8526a79 shipped in the
//     package (--compare-rules): the live Rules are the reviewed text, only line endings may differ;
//   * the file written here is re-read and hashes to the same raw SHA-256.
//
//   node m1-rules-rollback-prepare.mjs --backup <abs json> --expected-rules-hash <canonical sha> --expected-raw-sha256 <sha>
//        --expected-bytes <n> --compare-rules <abs package round-2 firestore.rules> --out-dir <new abs dir>
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2), o = {}
for (let i = 0; i < args.length; i += 2) o[args[i]] = args[i + 1]
const sha = v => createHash('sha256').update(v).digest('hex')
const KEYS = ['--backup', '--expected-rules-hash', '--expected-raw-sha256', '--expected-bytes', '--compare-rules', '--out-dir']
try {
  if (args.length !== KEYS.length * 2 || !KEYS.every(k => Object.hasOwn(o, k)) || new Set(args.filter((_, i) => i % 2 === 0)).size !== KEYS.length) throw new Error('usage')
  if (!/^[0-9a-f]{64}$/.test(o['--expected-rules-hash']) || !/^[0-9a-f]{64}$/.test(o['--expected-raw-sha256']) || !/^[1-9]\d{0,8}$/.test(o['--expected-bytes'])) throw new Error('usage')
  const backup = JSON.parse(fs.readFileSync(o['--backup'], 'utf8'))
  const files = backup?.source?.files
  if (backup?.format !== 'finapp-rules-backup-v1' || backup.project !== 'finapp-staging' || !Array.isArray(files) || files.length !== 1 || typeof files[0].content !== 'string') throw new Error('backup format')
  const content = files[0].content
  const bytes = Buffer.from(content, 'utf8')
  const canonical = sha(content.replace(/\r\n?/g, '\n'))
  if (canonical !== o['--expected-rules-hash'] || canonical !== backup.canonicalSha256) throw new Error('canonical hash')
  if (sha(bytes) !== o['--expected-raw-sha256'] || sha(bytes) !== backup.rawSha256) throw new Error('raw hash')
  if (bytes.length !== Number(o['--expected-bytes']) || bytes.length !== backup.sourceBytes) throw new Error('size')
  if (!path.isAbsolute(o['--compare-rules']) || !fs.existsSync(o['--compare-rules']) || sha(fs.readFileSync(o['--compare-rules'], 'utf8').replace(/\r\n?/g, '\n')) !== canonical) throw new Error('round-2 reference rules differ from the backup')
  const out = o['--out-dir']
  if (!path.isAbsolute(out) || fs.existsSync(out) || !fs.existsSync(path.dirname(out))) throw new Error('out dir')
  fs.mkdirSync(out, { mode: 0o700 })
  fs.writeFileSync(path.join(out, 'firestore.rules'), bytes, { flag: 'wx', mode: 0o600 })
  fs.writeFileSync(path.join(out, 'firebase.json'), `${JSON.stringify({ firestore: { rules: 'firestore.rules' } }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  const written = fs.readFileSync(path.join(out, 'firestore.rules'))
  if (!written.equals(bytes) || sha(written) !== o['--expected-raw-sha256']) throw new Error('written rules differ from the backup')
  console.log(`RULES_ROLLBACK_PREPARED canonicalSha256=${canonical} rawSha256=${sha(written)} bytes=${written.length} rulesetOfOrigin=${backup.rulesetName}`)
} catch (e) {
  console.log(`RULES_ROLLBACK_PREPARE_BLOCKED ${e.message}`)
  process.exitCode = 2
}
