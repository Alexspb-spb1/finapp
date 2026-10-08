// Own Auth + Firestore + Functions emulator session (demo project) for the S1b rehearsal, inside the isolated, fenced environment of the package.
// Builds on the accepted M1-SAFE-STOP-RECOVERY-01 helpers (port check, process tree). Refuses to start when a port is taken; stops ONLY the process tree it
// started. The Functions emulator runs the reviewed Functions build of the release clone (functions/lib) against the emulators only.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { busyPorts, processTree, PORTS } from '../../M1-SAFE-STOP-RECOVERY-01/offline-fence/emulator-session.mjs'

export const FUNCTIONS_PORT = 5001
export async function busyS1bPorts() {
  const net = await import('node:net')
  const taken = await busyPorts()
  const f = await new Promise(resolve => { const s = net.connect({ host: '127.0.0.1', port: FUNCTIONS_PORT }); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)) })
  return f ? [...taken, `functions:${FUNCTIONS_PORT}`] : taken
}

export async function startS1bSession({ pkg, releaseClone, jdkBin, emulatorsPath, playwrightPath, root, rulesSha256, readyTimeoutMs = 240000, fenceLog }) {
  const busy = await busyS1bPorts()
  if (busy.length) throw new Error(`EMULATOR_PORTS_BUSY ${busy.join(',')}`)
  fs.mkdirSync(root, { recursive: true })
  const rulesBytes = fs.readFileSync(path.join(releaseClone, 'firestore.rules'))
  if (rulesSha256 && createHash('sha256').update(rulesBytes).digest('hex') !== rulesSha256) throw new Error('RULES_SHA256_MISMATCH')
  fs.writeFileSync(path.join(root, 'firestore.rules'), rulesBytes)
  const config = {
    firestore: { rules: 'firestore.rules' },
    functions: { source: path.relative(root, path.join(releaseClone, 'functions')).replaceAll('\\', '/') },
    emulators: {
      auth: { host: '127.0.0.1', port: PORTS.auth }, firestore: { host: '127.0.0.1', port: PORTS.firestore }, functions: { host: '127.0.0.1', port: FUNCTIONS_PORT },
      hub: { host: '127.0.0.1', port: PORTS.hub }, logging: { host: '127.0.0.1', port: PORTS.logging }, ui: { enabled: false }, singleProjectMode: true
    }
  }
  fs.writeFileSync(path.join(root, 'firebase.session.json'), JSON.stringify(config, null, 2))
  const { buildIsolatedEnv } = await import(pathToFileURL(path.join(pkg, 'offline-fence', 'isolated-env.mjs')).href)
  const env = buildIsolatedEnv({ root: path.join(root, 'isolated'), jdkBin, emulatorsPath, fenceLog, fencePath: path.join(pkg, 'offline-fence', 'loopback-only.cjs'), extra: { FUNCTIONS_DISCOVERY_TIMEOUT: '120', ...(playwrightPath ? { PLAYWRIGHT_BROWSERS_PATH: playwrightPath } : {}) } })
  const out = path.join(root, 'emulators.stdout.txt'), err = path.join(root, 'emulators.stderr.txt')
  const child = spawn(process.execPath, [path.join(releaseClone, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js'), 'emulators:start', '--project', 'demo-finapp', '--only', 'auth,firestore,functions', '--config', path.join(root, 'firebase.session.json')],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', fs.openSync(out, 'w'), fs.openSync(err, 'w')] })
  let exited = false
  child.once('exit', () => { exited = true })
  const deadline = Date.now() + readyTimeoutMs
  let ready = false
  while (Date.now() < deadline && !exited) {
    if (fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('All emulators ready')) { ready = true; break }
    await new Promise(r => setTimeout(r, 500))
  }
  const session = {
    env, rootPid: child.pid, ready,
    pids: () => processTree(child.pid),
    // Loopback-only REST resets of the emulators' data between scenarios (documented emulator endpoints).
    async resetData() {
      const del = url => fetch(url, { method: 'DELETE' }).then(r => r.status)
      return { firestore: await del('http://127.0.0.1:8080/emulator/v1/projects/demo-finapp/databases/(default)/documents'), auth: await del('http://127.0.0.1:9099/emulator/v1/projects/demo-finapp/accounts') }
    },
    async stop() {
      // processTree() walks ParentProcessId links, so the children (e.g. the Firestore JVM) of a CLI that already CRASHED are found too: the session removes its own orphans.
      const tree = processTree(child.pid)
      const own = tree.filter(pid => pid !== child.pid)
      if (!exited) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      for (const pid of own) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
      await new Promise(r => setTimeout(r, 1500))
      const still = await busyS1bPorts()
      return { stoppedProcesses: tree.length, portsFreeAfter: still.length === 0, portsStillBusy: still }
    }
  }
  if (!ready) { const r = await session.stop(); throw new Error(`EMULATORS_NOT_READY exited=${exited} portsFreeAfter=${r.portsFreeAfter}`) }
  return session
}
