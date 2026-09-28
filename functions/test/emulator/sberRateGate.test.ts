import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { initializeApp, deleteApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { FirestoreSberRateGate } from '../../src/banks/sber/rateGate'
import { hash } from '../../src/banks/storage/schema'

if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080' || process.env.GCLOUD_PROJECT !== 'demo-finapp') {
  throw new Error('Sber rate tests require the demo-finapp Firestore emulator')
}
const app = initializeApp({ projectId: 'demo-finapp' }, 'sber-rate-test')
const db = getFirestore(app)
const config = { environment: 'sandbox', clientId: `synthetic${randomUUID().replaceAll('-', '')}`,
  redirectUri: 'https://example.test/callback', issuer: 'synthetic' } as const
const clients = new Set<string>([config.clientId])
const client = (prefix: string) => { const value = `${prefix}${randomUUID().replaceAll('-', '')}`; clients.add(value); return value }
const rateDocs = db.collection('bankSberRequestGates')
const signal = () => new AbortController().signal
const gate = () => new FirestoreSberRateGate(db, config)
afterAll(async () => {
  for (const id of clients) await rateDocs.doc(`sandbox-${hash(id)}`).delete()
  await deleteApp(app)
})

describe('BANK-003 shared Sber API interval (real Firestore)', () => {
  it('serializes three callers in distinct instances and spaces actual starts by over two seconds', async () => {
    const start: number[] = []
    let active = 0, maximum = 0
    const calls = Array.from({ length: 3 }, () => gate().run(async () => {
      active++; maximum = Math.max(maximum, active); start.push(Date.now())
      await new Promise(resolve => setTimeout(resolve, 15)); active--
      return 'sent'
    }, signal()))
    expect(await Promise.all(calls)).toEqual(['sent', 'sent', 'sent'])
    expect(maximum).toBe(1)
    for (let i = 1; i < start.length; i++) expect(start[i] - start[i - 1]).toBeGreaterThan(2000)
  }, 20000)

  it('fails closed and does not start a second request when queueing caller aborts', async () => {
    const config2 = { ...config, clientId: client('separate') }
    const first = new FirestoreSberRateGate(db, config2)
    const second = new FirestoreSberRateGate(db, config2)
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(r => { enter = r })
    const hold = new Promise<void>(r => { release = r })
    const ongoing = first.run(async () => { enter(); await hold }, signal())
    await entered
    const controller = new AbortController(); let network = 0
    const pending = second.run(async () => { network++ }, controller.signal)
    const denied = expect(pending).rejects.toThrow('bank_run_cancelled')
    controller.abort(); await denied
    release(); await ongoing
    expect(network).toBe(0)
  })

  it('recovers an expired crash lease; stale owner cannot reset the new fence', async () => {
    const config3 = { ...config, clientId: client('crash') }
    let now = Date.now()
    const first = new FirestoreSberRateGate(db, config3, () => now)
    const second = new FirestoreSberRateGate(db, config3, () => now)
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(r => { enter = r })
    const hold = new Promise<void>(r => { release = r })
    const stale = first.run(async () => { enter(); await hold }, signal())
    const rejected = expect(stale).rejects.toMatchObject({ category: 'transient' })
    await entered
    now += 46_000
    expect(await second.run(async () => 'new-owner', signal())).toBe('new-owner')
    release(); await rejected
    let invoked = 0
    const controller = new AbortController()
    const pending = second.run(async () => { invoked++ }, controller.signal)
    const denied = expect(pending).rejects.toThrow('bank_run_cancelled')
    controller.abort(); await denied
    expect(invoked).toBe(0)
  })

  it('treats a malformed shared gate as an unavailable bank, without making a request', async () => {
    const malformedConfig = { ...config, clientId: client('malformed') }
    const inspect = new FirestoreSberRateGate(db, malformedConfig)
    await inspect.run(async () => undefined, signal())
    await rateDocs.doc(`sandbox-${hash(malformedConfig.clientId)}`).update({ owner: 'bad-owner' })
    let sent = 0
    await expect(inspect.run(async () => { sent++ }, signal())).rejects.toMatchObject({ category: 'transient' })
    expect(sent).toBe(0)
  })
})
