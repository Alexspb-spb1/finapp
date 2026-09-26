// Real kill/fault proof for gateGaStagingRuntime.mjs's --out write path
// (FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9, independent audit follow-up,
// requirement 2). A genuinely separate child process calls the REAL,
// exported durableWriteJsonFile() with a custom `io` whose fsyncSync
// signals readiness then blocks forever — freezing the process exactly
// after the temp file has been fully written but before it is ever
// fsync'd, reread-verified, or renamed to the final `--out` path. The
// parent SIGKILLs the child there and asserts the final path never
// exists — never partial, never "close enough" — and, symmetrically,
// that a normal (unkilled) call leaves --out fully present and valid.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const THIS_FILE = fileURLToPath(import.meta.url)

if (process.argv[2] === '--child-freeze-before-rename') {
  const [, , , outPath, signalPath] = process.argv
  const { durableWriteJsonFile } = await import('./gateGaStagingRuntime.mjs')
  const freezingIo = {
    openSync: (...a) => fs.openSync(...a),
    writeSync: (...a) => fs.writeSync(...a),
    closeSync: (...a) => fs.closeSync(...a),
    readFileSync: (...a) => fs.readFileSync(...a),
    unlinkSync: (...a) => fs.unlinkSync(...a),
    renameSync: (...a) => fs.renameSync(...a),
    fsyncSync: () => {
      // The temp file is now FULLY written (writeSync already completed)
      // but not yet fsync'd, reread-verified, or renamed — exactly the
      // window a real crash could hit. Signal, then freeze forever.
      try { fs.writeFileSync(signalPath, 'reached', { flag: 'wx' }) } catch { /* ignore */ }
      // A synchronous infinite spin — this function must never return,
      // and unlike an async freeze, durableWriteJsonFile's fsyncSync call
      // is itself synchronous, so only a synchronous block actually stops
      // it. Real, not simulated: this really pauses the OS thread until
      // SIGKILL lands.
      while (true) { /* spin until killed */ }
    },
  }
  durableWriteJsonFile(outPath, { status: 'PASS', proof: 'should-never-reach-final-path' }, freezingIo)
} else {
  await main()
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ga-out-atomicity-'))
  try { return await fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('a real kill after the temp file is fully written but before fsync/rename leaves --out absent, never partial', async () => {
  await withTempDir(async dir => {
    const outPath = path.join(dir, 'out.json')
    const signalPath = path.join(dir, 'signal')
    const child = spawn(process.execPath, [THIS_FILE, '--child-freeze-before-rename', outPath, signalPath], { stdio: 'ignore', windowsHide: true })
    const exitPromise = new Promise(resolve => child.on('exit', resolve))
    const deadline = Date.now() + 10_000
    let signaled = false
    while (Date.now() < deadline) {
      if (fs.existsSync(signalPath)) { signaled = true; break }
      if (child.exitCode !== null) break
      await new Promise(r => setTimeout(r, 15))
    }
    assert.ok(signaled, 'child never reached the pre-rename freeze point')
    child.kill('SIGKILL')
    await Promise.race([exitPromise, new Promise(r => setTimeout(r, 3000))])

    // The real assertion: --out itself must never exist after a kill
    // before the rename — durableWriteJsonFile's only write to the final
    // path IS the rename, a single filesystem operation that a kill
    // beforehand can never partially apply.
    assert.equal(fs.existsSync(outPath), false)

    // A stray, fully-written-but-never-renamed temp file is expected and
    // harmless (a future durableWriteJsonFile call always creates its own
    // freshly-named temp file, never reusing this one) — but if present,
    // it must be the FULL valid content (fsyncSync was reached only after
    // the entire write completed), proving this was genuinely the
    // post-write/pre-rename window, not an earlier, incomplete one.
    const strayTemp = fs.readdirSync(dir).find(f => f.startsWith('out.json.tmp-'))
    if (strayTemp) {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, strayTemp), 'utf8'))
      assert.equal(parsed.proof, 'should-never-reach-final-path')
    }
  })
})

test('an unkilled call leaves --out fully present with the complete, valid JSON and no stray temp file', async () => {
  await withTempDir(async dir => {
    const { durableWriteJsonFile } = await import('./gateGaStagingRuntime.mjs')
    const outPath = path.join(dir, 'out.json')
    durableWriteJsonFile(outPath, { status: 'PASS', proof: 'complete' }, fs)
    assert.equal(fs.existsSync(outPath), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')), { status: 'PASS', proof: 'complete' })
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.includes('.tmp-')), [])
  })
})

async function main() {
  // node --test drives the test() calls above directly when this file is
  // the entry point; nothing else to do here.
}
