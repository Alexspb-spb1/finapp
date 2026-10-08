// Generates the DATA pins of the read-only reconciliation package from LOCAL files only (no network):
//   frontend-allowlist.json   from the local staging build (m1-dist-staging-714d0f91), cross-checked against dist-staging-manifest.txt
//   consumed-subject-pin.json from the existing private journal of the consumed run r3-ab9fb2fe (hashes only; the e-mail is derived in memory and never printed or stored)
//   node make-pins.mjs --dist <dir> --journal <file> --out <package source dir>
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const argv = process.argv.slice(2)
const arg = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
const dist = arg('--dist'), journal = arg('--journal'), out = arg('--out')
if (!dist || !journal || !out) { console.error('USAGE --dist --journal --out'); process.exit(2) }
const sha = b => createHash('sha256').update(b).digest('hex')
const walk = (d, rel = '') => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name), rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name])

// ---- frontend
const manifest = new Map(fs.readFileSync(path.join(out, 'dist-staging-manifest.txt'), 'utf8').split('\n').filter(Boolean).map(l => [l.slice(66), l.slice(0, 64)]))
const files = walk(dist).filter(f => !f.startsWith('.vite/')).sort()
const rows = files.map(f => { const b = fs.readFileSync(path.join(dist, ...f.split('/'))); return { path: f, sha256: sha(b), bytes: b.length } })
for (const r of rows) if (manifest.get(r.path) !== r.sha256) { console.error(`MANIFEST_MISMATCH ${r.path}`); process.exit(1) }
if (manifest.size - (manifest.has('.vite/manifest.json') ? 1 : 0) !== rows.length) { console.error('MANIFEST_COUNT'); process.exit(1) }
const frontend = {
  format: 'finapp-m1-recon-frontend-allowlist-v1', host: 'stage.aktivmetr.ru', base: '/finapp/',
  note: 'Fixed artifact paths of the accepted staging build (public HTTPS GET, no credentials, no browser, no SDK). Responses must match bytes and sha256 exactly; .vite/manifest.json is not served and is not requested.',
  marker: { chunkPrefix: 'assets/firebase-', projectId: 'finapp-staging', forbidden: ['finapp-prod-10a83'] },
  index: { sha256: rows.find(r => r.path === 'index.html').sha256, bytes: rows.find(r => r.path === 'index.html').bytes },
  files: rows
}
fs.writeFileSync(path.join(out, 'frontend-allowlist.json'), `${JSON.stringify(frontend, null, 2)}\n`)

// ---- consumed subject (hashes only)
const bytes = fs.readFileSync(journal)
const events = bytes.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const pre = events.filter(e => e.event === 'PREFLIGHT_OK'), creates = events.filter(e => e.event === 'AUTH_CREATE_MAY_BE_SENT')
if (pre.length !== 1 || creates.length !== 1 || creates[0].key !== 'admin' || !/^[0-9a-f]{8}$/.test(pre[0].runId)) { console.error('JOURNAL_SHAPE'); process.exit(1) }
const email = `m1-${pre[0].runId}-admin@example.invalid`
const pin = {
  format: 'finapp-m1-recon-consumed-subject-pin-v1', run: 'r3-ab9fb2fe', runId: pre[0].runId, subjectKey: 'admin',
  source: { file: 'm1-staging-run-714d0f91-v5/journal.jsonl', note: 'private run directory under the runtime root; read-only; the journal holds no secrets', sha256: sha(bytes), bytes: bytes.length, events: events.length },
  subjectSha256: sha(Buffer.from(email, 'utf8')),
  derivation: 'm1-<runId>-admin@example.invalid from the single PREFLIGHT_OK runId and the single AUTH_CREATE_MAY_BE_SENT key=admin (the old UNKNOWN create); never printed, never stored',
  meaning: 'a future lookup says only ABSENT_NOW or PRESENT_NOW at the time of reading; it is not proof that the old request was or was not processed'
}
fs.writeFileSync(path.join(out, 'consumed-subject-pin.json'), `${JSON.stringify(pin, null, 2)}\n`)
console.log(`PINS_WRITTEN frontendFiles=${rows.length} journalSha256=${pin.source.sha256} subjectSha256=${pin.subjectSha256}`)
