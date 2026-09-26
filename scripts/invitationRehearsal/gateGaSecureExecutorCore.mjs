// FINAPP-1.0-SEC-006-GATE-G-A-APPROVAL-EVIDENCE-BINDING, item 4.
//
// liveAcceptanceExecutorCliCore.mjs's validateExecutionApproval()
// (published, reviewed, execution/sec-006-gate-ga-r9-fix5 — NOT modified)
// still accepts a hand-crafted, arbitrary hex64 functionsSha256; nothing
// inside the reviewed --execute path itself cross-checks it against real
// evidence. This module is the hard gate: it wraps an already-built
// orchestrated runtime (createGateGaOrchestratedRuntime — unmodified) so
// that its .run() re-verifies the approval's functionsSha256 against a
// real functions-evidence receipt BEFORE ever delegating to the real
// runtime — i.e. before the real runtime performs any adapter
// construction or network/credential access, which only happens inside
// that delegated call. When the evidence binds, behavior is byte-for-byte
// identical to the unwrapped runtime; this module changes only WHETHER
// and WHEN network access is reachable, never what happens once it is.
import { validateFunctionsShaBinding } from './gateGaApprovalEvidenceBindingCore.mjs'

const blocked = () => { throw new Error('secure_executor_functions_gate_blocked') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function wrapRuntimeWithFunctionsEvidenceGate({ runtime, functionsReceiptBytes, expectedCheckerSourceHead }) {
  if (!record(runtime) || typeof runtime.run !== 'function' ||
      !(typeof functionsReceiptBytes === 'string' || Buffer.isBuffer(functionsReceiptBytes) || functionsReceiptBytes instanceof Uint8Array)) blocked()
  return Object.freeze({
    run: async value => {
      if (!record(value) || !record(value.approval) || !record(value.parsed)) blocked()
      validateFunctionsShaBinding({
        functionsSha256: value.approval.functionsSha256, receiptBytes: functionsReceiptBytes,
        expectedProject: value.parsed['--project'], expectedCheckerSourceHead,
      })
      return runtime.run(value)
    },
  })
}
