// OBSERVATION (not enforcement) of the TCP connections owned by a process tree: used for the JVM emulators, which the Node fence cannot cover.
// Read-only (Get-NetTCPConnection / Win32_Process queries); it blocks nothing and cannot prove the absence of traffic between samples or over UDP.
import { spawnSync } from 'node:child_process'

const PS = (pids) => `
$ErrorActionPreference='Stop'
$roots=@(${pids.map(Number).filter(Number.isInteger).join(',') || '0'})
$p=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId
$own=New-Object System.Collections.Generic.HashSet[int]
foreach($r in $roots){[void]$own.Add([int]$r)}
do{$n=0;foreach($x in $p){if($own.Contains([int]$x.ParentProcessId) -and -not $own.Contains([int]$x.ProcessId)){[void]$own.Add([int]$x.ProcessId);$n++}}}while($n -gt 0)
$c=@(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object {$own.Contains([int]$_.OwningProcess)} | ForEach-Object {[pscustomobject]@{s=[string]$_.State;a=[string]$_.RemoteAddress}})
[pscustomobject]@{owned=$own.Count;conns=$c} | ConvertTo-Json -Compress -Depth 4`

export function isLoopbackAddress(a) { return !a || a === '0.0.0.0' || a === '::' || a === '::1' || /^127(\.\d{1,3}){3}$/.test(a) || a.startsWith('::ffff:127.') }

// One sample for the process trees rooted at `pids`; returns {owned, connections:[{state, remote}]} or {error}.
export function sampleOnce(pids) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS(pids)], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
  if (r.status !== 0) return { error: 'sample-failed' }
  try {
    const j = JSON.parse(r.stdout.trim())
    const conns = Array.isArray(j.conns) ? j.conns : j.conns ? [j.conns] : []
    return { owned: j.owned, connections: conns.map(c => ({ state: c.s, remote: c.a })) }
  } catch { return { error: 'sample-unparseable' } }
}

// Aggregates samples without keeping per-connection data: counts, and the distinct NON-loopback remote addresses (public IPs are not secrets).
export function createAggregate() {
  const agg = { samples: 0, sampleErrors: 0, maxOwnedProcesses: 0, establishedLoopback: 0, establishedNonLoopback: 0, nonLoopbackAnyState: 0, nonLoopbackRemotes: new Set() }
  return {
    add(s) {
      agg.samples++
      if (s.error) { agg.sampleErrors++; return }
      agg.maxOwnedProcesses = Math.max(agg.maxOwnedProcesses, s.owned || 0)
      for (const c of s.connections) {
        const loop = isLoopbackAddress(c.remote)
        if (c.state === 'Listen' || c.state === 'Bound') continue
        if (c.state === 'Established') loop ? agg.establishedLoopback++ : agg.establishedNonLoopback++
        if (!loop) { agg.nonLoopbackAnyState++; agg.nonLoopbackRemotes.add(c.remote) }
      }
    },
    summary() { return { ...agg, nonLoopbackRemotes: [...agg.nonLoopbackRemotes].slice(0, 10), coverage: 'observed-not-enforced; TCP only; interval sampling' } }
  }
}
