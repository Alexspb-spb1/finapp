import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeDurableEventJournal, readExistingDurableJournalEvents } from './gateGaDurableJournalCore.mjs'

function tmpDir() {
  return path.join(os.tmpdir(), `gate-ga-journal-selftest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

test('append writes one immutable file per event and events replay in seq order', () => {
  const dir = tmpDir()
  const j = makeDurableEventJournal(dir)
  j.append('A', { x: 1 })
  j.append('B', { x: 2 })
  j.append('C', { x: 3 })
  assert.deepEqual(j.events.map(e => e.status), ['A', 'B', 'C'])
  assert.deepEqual(j.events.map(e => e.seq), [0, 1, 2])
  const files = fs.readdirSync(dir).filter(f => f.startsWith('event-'))
  assert.equal(files.length, 3)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('reopening a journal continues seq numbering rather than restarting at 0', () => {
  const dir = tmpDir()
  const first = makeDurableEventJournal(dir)
  first.append('A', {})
  first.append('B', {})
  const second = makeDurableEventJournal(dir)
  assert.deepEqual(second.events.map(e => e.status), ['A', 'B'])
  const entry = second.append('C', {})
  assert.equal(entry.seq, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a stray .tmp file left by a simulated crash mid-write does not corrupt reads and is simply ignored', () => {
  const dir = tmpDir()
  const j = makeDurableEventJournal(dir)
  j.append('A', {})
  j.append('B', {})
  // Simulate a kill exactly after openSync('wx') but before the rename —
  // a real crash would leave exactly this: a stray temp file that never
  // reached its final event-NNNNNNNN.json name.
  fs.writeFileSync(path.join(dir, '.tmp-99999-abc-def'), '{"seq":2,"status":"PARTIAL"')
  const events = readExistingDurableJournalEvents(dir)
  assert.deepEqual(events.map(e => e.status), ['A', 'B'])
  const reopened = makeDurableEventJournal(dir)
  assert.deepEqual(reopened.events.map(e => e.status), ['A', 'B'])
  const entry = reopened.append('C', {})
  assert.equal(entry.seq, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a genuinely corrupt (unparseable) committed event file still blocks — real corruption is not the same as an interrupted write', () => {
  const dir = tmpDir()
  const j = makeDurableEventJournal(dir)
  j.append('A', {})
  fs.writeFileSync(path.join(dir, 'event-00000001.json'), 'not json')
  assert.throws(() => readExistingDurableJournalEvents(dir), /journal_event_corrupt/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('an event file whose seq does not match its filename/position is rejected (tamper-evident)', () => {
  const dir = tmpDir()
  const j = makeDurableEventJournal(dir)
  j.append('A', {})
  j.append('B', {})
  const p = path.join(dir, 'event-00000001.json')
  const entry = JSON.parse(fs.readFileSync(p, 'utf8'))
  entry.seq = 5
  fs.writeFileSync(p, JSON.stringify(entry))
  assert.throws(() => readExistingDurableJournalEvents(dir), /journal_event_sequence_mismatch/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('no stray temp file remains after a successful append (real crash-atomicity proof, mirroring the checkpoint/manifest pattern)', () => {
  const dir = tmpDir()
  const j = makeDurableEventJournal(dir)
  j.append('A', {})
  const stray = fs.readdirSync(dir).filter(f => f.startsWith('.tmp-'))
  assert.deepEqual(stray, [])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('ensureAcl/verifyFileAcl hooks are invoked (directory once, each successful append once) so a real ACL failure would block', () => {
  const dir = tmpDir()
  const ensureAclCalls = []
  const verifyFileAclCalls = []
  const j = makeDurableEventJournal(dir, {
    ensureAcl: args => ensureAclCalls.push(args),
    verifyFileAcl: args => verifyFileAclCalls.push(args),
  })
  j.append('A', {})
  j.append('B', {})
  assert.equal(ensureAclCalls.length, 1)
  assert.equal(ensureAclCalls[0].dir, dir)
  assert.equal(verifyFileAclCalls.length, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a throwing verifyFileAcl blocks append from being considered safe (propagates, does not swallow)', () => {
  const dir = tmpDir()
  const j = makeDurableEventJournal(dir, { verifyFileAcl: () => { throw new Error('acl_refused') } })
  assert.throws(() => j.append('A', {}), /acl_refused/)
  fs.rmSync(dir, { recursive: true, force: true })
})

if (process.argv[2] === '--self-test') {
  // no-op: node --test drives this file directly.
}
