// Starts the Auth + Firestore emulators (demo project) for ONE local run inside the isolated, fenced environment and stops exactly the process
// tree it started. It refuses to start when the emulator ports are already taken (no shared emulator data is touched, no foreign process is stopped).
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { buildIsolatedEnv, DEMO_PROJECT } from './isolated-env.mjs'

export const PORTS = { auth: 9099, firestore: 8080, hub: 4406, logging: 4506 }

const portBusy = port => new Promise(resolve => {
  const s = net.connect({ host: '127.0.0.1', port })
  s.once('connect', () => { s.destroy(); resolve(true) })
  s.once('error', () => resolve(false))
})
export async function busyPorts() { const r = []; for (const [n, p] of Object.entries(PORTS)) if (await portBusy(p)) r.push(`${n}:${p}`); return r }

export function emulatorConfig() {
  return {
    firestore: { rules: 'firestore.rules' },
    emulators: {
      auth: { host: '127.0.0.1', port: PORTS.auth }, firestore: { host: '127.0.0.1', port: PORTS.firestore },
      hub: { host: '127.0.0.1', port: PORTS.hub }, logging: { host: '127.0.0.1', port: PORTS.logging }, ui: { enabled: false }, singleProjectMode: true
    }
  }
}

// Process ids of the tree rooted at `rootPid` (read-only query), root first.
export function processTree(rootPid) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `$p=Get-CimInstance Win32_Process|Select-Object ProcessId,ParentProcessId;$o=New-Object System.Collections.Generic.List[int];$o.Add(${Number(rootPid)});$i=0;while($i -lt $o.Count){foreach($x in $p){if([int]$x.ParentProcessId -eq $o[$i] -and -not $o.Contains([int]$x.ProcessId)){$o.Add([int]$x.ProcessId)}};$i++};$o -join ','`],
  { encoding: 'utf8', windowsHide: true })
  return r.stdout.trim().split(',').map(Number).filter(Number.isInteger)
}

export async function startEmulatorSession({ releaseClone, jdkBin, emulatorsPath, root, rulesSha256, readyTimeoutMs = 120000, fenceLog }) {
  const busy = await busyPorts()
  if (busy.length) throw new Error(`EMULATOR_PORTS_BUSY ${busy.join(',')}`)
  fs.mkdirSync(root, { recursive: true })
  const rulesSrc = path.join(releaseClone, 'firestore.rules')
  const rulesBytes = fs.readFileSync(rulesSrc)
  if (rulesSha256 && createHash('sha256').update(rulesBytes).digest('hex') !== rulesSha256) throw new Error('RULES_SHA256_MISMATCH')
  fs.writeFileSync(path.join(root, 'firestore.rules'), rulesBytes)
  fs.writeFileSync(path.join(root, 'firebase.session.json'), JSON.stringify(emulatorConfig(), null, 2))
  const env = buildIsolatedEnv({ root: path.join(root, 'isolated'), jdkBin, emulatorsPath, fenceLog })
  const out = path.join(root, 'emulators.stdout.txt'), err = path.join(root, 'emulators.stderr.txt')
  const child = spawn(process.execPath, [path.join(releaseClone, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js'), 'emulators:start', '--project', DEMO_PROJECT, '--only', 'auth,firestore', '--config', path.join(root, 'firebase.session.json')],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', fs.openSync(out, 'w'), fs.openSync(err, 'w')] })
  let exited = false
  child.once('exit', () => { exited = true })
  const deadline = Date.now() + readyTimeoutMs
  let ready = false
  while (Date.now() < deadline) {
    if (exited) break
    if (fs.existsSync(out) && fs.readFileSync(out, 'utf8').includes('All emulators ready')) { ready = true; break }
    await new Promise(r => setTimeout(r, 500))
  }
  const session = {
    env, rootPid: child.pid, ready,
    pids: () => processTree(child.pid),
    async stop() {
      const own = exited ? [] : processTree(child.pid)
      // Stop only the tree this session started (taskkill /T on our own root pid).
      if (!exited) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      const stillBusy = await busyPorts()
      return { stoppedProcesses: own.length, portsFreeAfter: stillBusy.length === 0, portsStillBusy: stillBusy }
    }
  }
  if (!ready) { const r = await session.stop(); throw new Error(`EMULATORS_NOT_READY exited=${exited} portsFreeAfter=${r.portsFreeAfter}`) }
  return session
}
