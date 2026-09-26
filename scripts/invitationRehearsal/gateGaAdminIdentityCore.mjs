// gate-G-A deterministic admin identity (FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R9).
//
// A single, shared derivation used by BOTH the emulator adapter (which can
// force an exact Auth uid at creation time via the Admin SDK) and the real
// staging adapter (whose Identity Toolkit REST signUp call can NEVER be
// given a caller-chosen uid — the server always assigns it). Keeping one
// pure function means both adapters can never silently diverge on what
// "this run's admin identity" means.
//
// Derived from the run's own durable `runId` — claimed once, before any
// external write, and read back unchanged by every subsequent process for
// the same run (the run-id claim file / run manifest) — never from
// `runTag`, a per-process, ephemeral resource-naming value regenerated on
// every CLI invocation including a resume. This is what makes the identity
// independently recomputable, byte-for-byte, by a genuinely separate
// process: no extra "remember the email somewhere" bookkeeping is needed
// beyond the run-id claim that already exists before the first external
// call — recomputing IS the durable record, with no separate copy that
// could ever drift from it.
import { createHash } from 'node:crypto'

const blocked = reason => { throw new Error(`gate_ga_admin_identity_blocked:${reason ?? ''}`) }

export function deriveAdminIdentity(runId) {
  if (typeof runId !== 'string' || !runId) blocked('missing_run_id')
  const slug = createHash('sha256').update(runId).digest('hex').slice(0, 20)
  return Object.freeze({
    slug,
    adminUid: `gaadm-${slug}`,
    adminEmail: `gaadm-${slug}@example.invalid`,
    idempotencyKey: `gaidem-${slug}`,
  })
}
