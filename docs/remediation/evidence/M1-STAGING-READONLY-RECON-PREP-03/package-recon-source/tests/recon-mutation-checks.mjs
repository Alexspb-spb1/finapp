// Mutation checks of the read-only reconciliation gates: each mutant removes or weakens ONE gate in a COPY of the package; the negative controls of that copy must FAIL.
// The copy gets its runtime and rehearsal roots rewritten to a temporary directory, so no mutant can create or burn the real namespace; the controls themselves never open a
// socket (recorder fetch) and point the owner profile at an empty directory, so a mutant cannot reach a provider or an owner credential either.
//   node tests/recon-mutation-checks.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-mutants-'))
const js = s => s.replaceAll('\\', '\\\\')

const C = 'recon-core.mjs', P = 'recon-pins.mjs', M = 'recon-permit.mjs', B = 'recon-bootstrap.mjs'
const MUTANTS = [
  // allowlist
  ['allowlist ignores the HTTP method', C, 'if (e.method !== method || e.host !== u.hostname) continue', 'if (e.host !== u.hostname) continue'],
  ['allowlist ignores the host', C, 'if (e.method !== method || e.host !== u.hostname) continue', 'if (e.method !== method) continue'],
  ['allowlist ignores the path', C, 'const pathOk = e.path !== undefined ? u.pathname === e.path : new RegExp(e.pathPattern).test(u.pathname)', 'const pathOk = true'],
  ['allowlist ignores extra / missing query parameters', C, 'if (pairs.length !== want.length || want.some', 'if (want.some'],
  ['allowlist accepts a non-synthetic Auth subject', C, ' || !SYNTHETIC_SUBJECT.test(b.email[0])', ''],
  ['allowlist accepts plain http / userinfo / ports', C, "if (u.protocol !== 'https:' || u.username || u.password || u.hash || u.port) throw new Blocked('allowlist-denied')", ''],
  // budgets, timeouts, redirects, sizes
  ['no per-entry request budget', C, ' || (counts.get(entry.id) ?? 0) + 1 > entry.maxRequests', ''],
  ['no global request budget', C, 'if (total + 1 > limits.maxRequests || ', 'if ('],
  ['no global deadline', C, "if (now() - t0 > limits.globalDeadlineMs) throw deny('deadline')", ''],
  ['redirects are followed', C, "redirect: 'error'", "redirect: 'follow'"],
  ['non-200 answers are accepted below 500', C, 'if (status !== 200) {', 'if (status >= 500) {'],
  ['no response size cap', C, 'if (size > entry.maxResponseBytes || totalBytes + size > limits.maxTotalResponseBytes)', 'if (false)'],
  ['one retry after a transport failure', C, "        finish(code)\n        throw new Blocked(code)\n      }\n      const status = res.status", "        finish(code)\n        res = await fetchImpl(urlString, { method, headers, body, redirect: 'error' })\n      }\n      const status = res.status"],
  ['no durable INTENT before dispatch', C, "ledger.event({ phase: 'INTENT', id: entry.id,", "void ({ phase: 'INTENT', id: entry.id,"],
  ['the bearer token is attached to every host (including the public frontend)', C, "if (entry.auth === 'bearer') { headers.authorization", 'if (true) { headers.authorization'],
  // branches
  ['functions pagination accepted', C, " || (body.nextPageToken !== undefined && body.nextPageToken !== '')", ''],
  ['Rules comparison always matches', C, 'matchesPin: canonical === t.canonicalSha256 && raw === t.rawSha256 && bytes === t.sourceBytes', 'matchesPin: true'],
  ['frontend comparison always matches', C, 'const matches = r.sha256 === e.pinSha256 && r.bytes.length === e.maxResponseBytes', 'const matches = true'],
  ['the subject journal hash is not checked', C, "if (sha256Hex(journalBytes) !== pin.source.sha256) throw new Blocked('subject-source-mismatch')", ''],
  ['the subject hash is not checked (any derived address is looked up)', C, "if (sha256Hex(Buffer.from(email, 'utf8')) !== pin.subjectSha256) throw new Blocked('subject-source-mismatch')", ''],
  ['the evidence scan is skipped', C, 'const hits = scanEvidence(evDir, [token])', 'const hits = []'],
  // claim and INIT
  ['the namespace claim is a recursive mkdir', C, 'try { claimMkdir(evDir) }', 'try { claimMkdir(evDir, { recursive: true }) }'],
  ['the claim marker may overwrite', C, "claimedAt: new Date(now()).toISOString(), codeSumsSha256: pins.hashes.codeSumsSha256 })}\\n`, { flag: 'wx' })", "claimedAt: new Date(now()).toISOString(), codeSumsSha256: pins.hashes.codeSumsSha256 })}\\n`, { flag: 'w' })"],
  ['forbidden environment accepted', C, 'Object.entries(env).some(([k, v]) => v && FORBIDDEN_ENV.test(k))', 'false'],
  ['consumed / reserved namespaces accepted', P, "if (RECON.consumedNames.includes(nameOf(evidenceDir))) problems.push('consumed or reserved namespace')", ''],
  ['production markers ignored', P, 'for (const v of values) for (const m of RECON.productionMarkers) if (String(v).toLowerCase().includes(m)) problems.push', 'for (const v of []) for (const m of RECON.productionMarkers) if (String(v).toLowerCase().includes(m)) problems.push'],
  // permit
  ['permit not bound to the package bytes', M, 'for (const [k, f] of bound) if (typeof facts[f]', 'for (const [k, f] of []) if (typeof facts[f]'],
  ['permit acknowledgements not required', M, ' || ACK_KEYS.some(k => ack[k] !== true)', ''],
  ['permit validity longer than 2 h accepted', M, "if (expires - approved > RECON.limits.maxPermitMs) problems.push('permit validity longer than 2 h')", ''],
  ['permit validity window ignored', M, "if (!(approved <= nowMs && nowMs < expires)) problems.push('permit is not valid now')", ''],
  ['credential read decoupled from the Google branches', M, "if (needsLogin !== ops.credentialConfigRead) problems.push('permit: credentialConfigRead must be on exactly when a Google API branch is on')", ''],
  // credential bootstrap
  ['a nearly expired cached token is accepted', B, "if (remainingMs < minRemainingMs) throw new Blocked('credential-too-old')", ''],
  ['a token of any shape is accepted', B, "if (typeof accessToken !== 'string' || accessToken.length < 20 || accessToken.length > 4096 || /\\s/.test(accessToken) || !Number.isFinite(expiresAt)) throw new Blocked('credential-token-missing')", '']
]

const copyTree = (from, to) => {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'results' || e.name === 'node_modules') continue
    const a = path.join(from, e.name), b = path.join(to, e.name)
    if (e.isDirectory()) copyTree(a, b); else fs.copyFileSync(a, b)
  }
}
let detected = 0
const survived = []
let idx = 0
for (const [name, file, from, to] of MUTANTS) {
  const dir = path.join(TMP, `m${++idx}`)
  copyTree(PKG, dir)
  const rewrite = (f, pairs) => { let s = fs.readFileSync(path.join(dir, f), 'utf8'); for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error(`stale anchor in ${f}: ${a.slice(0, 50)}`); s = s.replace(a, () => b) } fs.writeFileSync(path.join(dir, f), s) }
  rewrite(P, [["runtimeRoot: 'D:\\\\projects\\\\finapp\\\\.runtime'", `runtimeRoot: '${js(path.join(dir, 'rt'))}'`], ["rehearsalBase: 'D:\\\\projects\\\\finapp\\\\.runtime\\\\m1-recon-rehearsal\\\\'", `rehearsalBase: '${js(path.join(dir, 'rh'))}\\\\'`]])
  rewrite(file, [[from, to]])
  const r = spawnSync(process.execPath, [path.join(dir, 'tests', 'recon-negative-controls.mjs')], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 240000, maxBuffer: 32 * 1024 * 1024 })
  const killed = r.status !== 0
  if (killed) detected++; else survived.push(name)
  console.log(`${killed ? 'DETECTED' : 'SURVIVED'} ${name}`)
}
fs.rmSync(TMP, { recursive: true, force: true })
console.log(`RECON_MUTATION_CHECKS ${survived.length ? 'FAIL' : 'PASS'} detected=${detected}/${MUTANTS.length}${survived.length ? ` survived=${survived.join(' | ')}` : ''}`)
process.exitCode = survived.length ? 1 : 0
