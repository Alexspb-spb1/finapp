# FINAPP-1.0-SEC-006-GATE-G-A-APPROVAL-EVIDENCE-BINDING — closing the functionsSha256 gap

## Итоговый статус
READY_FOR_REVIEW

## Branch / commit
- branch: `remediation/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING`
- base SHA: `bd59524a2802f1c7ad937d1165fe842ce0df9048` (`remediation/SEC-006-GATE-GA-DEPLOYMENT-CHECK-13FN`, itself based on `execution/sec-006-gate-ga-r9-fix5` @ `e1310e5314f4e6355a0fbd43eab378224044e1f6`)
- result SHA: see commit created by this report's accompanying push

## Security finding (item 2) — confirmed real, not theoretical

`liveAcceptanceExecutorCliCore.mjs`'s `validateExecutionApproval()`
(published, reviewed, part of `execution/sec-006-gate-ga-r9-fix5` —
**not modified**) checks `mailboxSha256`, `functionsSha256`,
`authMetadataSha256` and `stagingFingerprint` for nothing beyond
`hex64` format:

```js
[value.mailboxSha256, value.functionsSha256, value.authMetadataSha256, value.stagingFingerprint].some(item => !hex64(item)) ||
```

It never cross-checks any of them against real evidence. Concretely
demonstrated in `gateGaApprovalEvidenceBindingSelfTest.mjs`: a value of
`'f'.repeat(64)` — a perfectly well-formed but entirely fabricated
`functionsSha256` — passes the reviewed validator's own check, exactly as
`/^[a-f0-9]{64}$/.test('f'.repeat(64))` proves. Nothing today forces
`functionsSha256` to be the hash of a real, passing
`gateGaDeploymentCheck13.mjs` receipt. `DEPLOYMENT_METADATA_VERIFIED_13FN`
from the checker (`bd59524a`) and `functionsStatus: PASS` in an approval
consumed by the executor (`e1310e53`) are **two different commits' worth
of code with no cryptographic link between them** — the checker result is
not itself a G-A approval, and nothing previously proved they could ever
be bound together.

## Что изменено (fix, additive only — fix5 and the 13fn checker branch untouched)

- `scripts/invitationRehearsal/gateGaApprovalEvidenceBindingCore.mjs`:
  - `validateFunctionsShaBinding({ functionsSha256, receiptBytes, expectedProject, now, maxReceiptAgeMs })`
    — proves a claimed `functionsSha256` is genuinely the SHA-256 of a
    real `gateGaDeploymentCheck13.mjs` receipt (not merely hex64-shaped),
    that the receipt reports the exact required status/task/project, is
    bound to the pinned baseline `sourceHead`, and is not stale
    (default max age = the same 1-hour TTL as the approval itself).
  - `buildApprovalDraft({ cliArgs, mailboxReceiptBytes, functionsReceiptBytes, authMetadataReceiptBytes, stagingFingerprint, approvedAt })`
    — assembles a full approval object matching
    `validateExecutionApproval()`'s exact schema, computing all four
    evidence hashes only from real receipt bytes (never accepting a
    pre-computed hash), refusing to emit anything whose `functionsSha256`
    doesn't pass `validateFunctionsShaBinding` first, and computing
    `commandSha256` via the **real, imported**
    `approvalCommandSha256()` — the exact function the reviewed validator
    itself uses — so a draft built here is proven, not merely argued, to
    be byte-for-byte compatible with it (see the positive self-test
    below).
  - `APPROVAL_TTL_MS` is pinned to `60 * 60 * 1000` and a self-test reads
    the reviewed executor's own source text to assert its (unexported)
    `EXECUTION_APPROVAL_TTL_MS` constant is still exactly that value —
    catching silent drift without needing to export anything from, or
    otherwise touch, the published file.
- `scripts/invitationRehearsal/gateGaApprovalEvidenceBindingSelfTest.mjs`
  (16 tests): the TTL-pin assertion; positive binding; the exact
  hex64-but-wrong value rejected by my check *and* proven accepted by the
  reviewed executor's own format-only check (the gap, demonstrated, not
  just described); wrong task/status/project/baseline-binding on the
  receipt; stale and future-timestamped receipts; a full positive
  `buildApprovalDraft` → **fed into the real, unmodified
  `validateExecutionApproval`** → accepted; a draft refused when its
  functions evidence fails binding; malformed `stagingFingerprint`/
  `approvedAt`; malformed `cliArgs` (never bypasses the real
  `parseExecutorCliArgs`); `expiresAt` always exactly `approvedAt + 1h`
  regardless of when called.
- `scripts/invitationRehearsal/gateGaApprovalEvidenceBindingMutationChecks.mjs`
  (8 mutations, all `DETECTED`): hash-equality check, status check, task
  check, project check, staleness check, baseline-binding check, the
  "never skip the binding check before emitting a draft" invariant, and
  TTL-pin drift.
- `scripts/invitationRehearsal/gateGaBuildApprovalDraft.mjs`: the real CLI
  tool the owner runs immediately before `--execute` (item 4). Takes real
  evidence file paths plus the executor's own `--execute ...` argument
  list (after a `--` separator), captures `approvedAt` at the moment it
  runs, writes the approval JSON with `wx`/`0o600`, and prints the exact
  `--approval-sha256` value to use. **Not invoked against live evidence
  this round** — only `--help` (no file/network access) plus one **local**
  smoke test using already-obtained real functions-receipt bytes (no new
  staging contact) and synthetic mailbox/auth bytes, to prove the
  read/write/assembly path itself works end to end.
- Two new npm scripts:
  `test:invitation-gate-ga-approval-evidence-binding`,
  `test:invitation-gate-ga-approval-evidence-binding-mutations`.

### Why this is the right scope, and what is deliberately NOT done

Wiring `validateFunctionsShaBinding` as a *hard, always-enforced* part of
`validateExecutionApproval()` itself would require editing
`liveAcceptanceExecutorCliCore.mjs` — a published, independently reviewed
file on `execution/sec-006-gate-ga-r9-fix5`. Per this round's explicit
scope ("не меняй опубликованные проверенные ветки задним числом"), that
file is untouched (`git diff --stat` against it is empty). Instead, this
round makes the binding check impossible to skip **for anyone using the
provided tooling to build the approval** (`gateGaBuildApprovalDraft.mjs`
always calls it before writing anything), and proves, by construction,
that its output is accepted by the real unmodified validator. Making the
binding a hard requirement *inside* the reviewed validator itself — so an
approval hand-written without this tooling could never pass either —
would be a further, separately scoped change to a published branch, and
is called out below as a known limitation, not silently left unstated.

## Item 1 — the live receipt, attached, hash re-verified

- `evidence/deployment-check-13fn-out.json` — SHA-256
  `9eec9c54f2be782552c441dcfcfd1a8e7eab2d49f643e6c8fded8aa344519880`,
  re-verified identical to the value reported after the live run. The
  file was written with pure LF line endings by the CLI tool itself and
  committed as such (the git blob is LF); on a Windows checkout with
  `core.autocrlf=true` the WORKING-TREE copy will read back with CRLF
  (same harmless, already-diagnosed artifact noted in the 13fn-checker
  round) — re-verify with `git show <commit>:docs/remediation/evidence/.../deployment-check-13fn-out.json | sha256sum`
  (reads the committed blob directly) rather than hashing a CRLF-converted
  working-tree file, to get the quoted value exactly.
- `evidence/invocation-log.md` — the exact first (blocked) command, the
  four read-only diagnostic steps taken (three purely local, one with a
  single additional real-network reproduction — no other new live calls
  were made), and the exact successful retry command and output. Not
  presented as a clean first-try pass.

## Item 3 — everything prepared for the one owner-run; nothing more done independently

**Blocked step, handed to the owner exactly, not bypassed:** the mailbox
lookup for the already-authorized recipient is blocked in this
environment (sandbox-classified as a real-world transaction on the
earlier attempt). One exact read-only command for the owner to run
themselves:

```bash
node scripts/invitationRehearsal/mailboxDiscovery.mjs \
  --project finapp-staging \
  --expected-head e1310e5314f4e6355a0fbd43eab378224044e1f6 \
  --mailbox-file <absolute-private-file-containing-only-lesenenok8787@gmail.com> \
  --out <new-absolute-private-JSON>
```
Run from a clean checkout of `execution/sec-006-gate-ga-r9-fix5` @
`e1310e5314f4e6355a0fbd43eab378224044e1f6` (this file is unchanged since
that commit). Expected result to note back: `MAILBOX_DISCOVERY_COMPLETE`
printed to stdout, and the `--out` file's path — that file's raw bytes are
the `--mailbox-receipt` input to `gateGaBuildApprovalDraft.mjs` below. No
mailbox contents, UID, or provider error is ever printed by that script.

**Full ordered playbook for the one authorized run** (owner-executed;
nothing in this list was run live by me beyond what item 1's log
records):

1. Fresh clean checkout of `remediation/SEC-006-GATE-GA-DEPLOYMENT-CHECK-13FN`
   @ `bd59524a2802f1c7ad937d1165fe842ce0df9048`, worktree confirmed clean.
   Run the checker fresh (the receipt attached above will likely be too
   old by the time you reach step 5 — `validateFunctionsShaBinding`'s
   default freshness window is 1 hour):
   ```bash
   node scripts/invitationRehearsal/gateGaDeploymentCheck13.mjs \
     --project finapp-staging \
     --expected-head bd59524a2802f1c7ad937d1165fe842ce0df9048 \
     --baseline-receipt "<path-to>/stage8-deployment-postflight-ab1bd67.json" \
     --out <new-absolute-private-functions-receipt.json>
   ```
   Stop condition: if this does not print `DEPLOYMENT_METADATA_VERIFIED_13FN`
   with exit code 0, stop — do not proceed to build an approval.
2. Fresh clean checkout of `execution/sec-006-gate-ga-r9-fix5` @
   `e1310e5314f4e6355a0fbd43eab378224044e1f6` (the actual G-A executor).
   Run the mailbox-lookup command above from this checkout.
   Stop condition: if it does not print `MAILBOX_DISCOVERY_COMPLETE`, stop.
3. From the same checkout, run auth-template shape discovery fresh:
   ```bash
   node scripts/invitationRehearsal/authVerificationShapeDiscovery.mjs \
     --project finapp-staging --expected-head e1310e5314f4e6355a0fbd43eab378224044e1f6 \
     --out <new-absolute-private-auth-metadata-receipt.json>
   ```
   Stop condition: if it does not print
   `AUTH_VERIFICATION_TEMPLATE_SHAPE_DISCOVERED`, stop.
4. `stagingFingerprint` (not time-sensitive — a hash of static Firebase
   Web SDK config, already independently verified this round):
   `2a26dafc4fedd7f6f584f6f0e60369a7cb3097f0188ce45f90a14e9d84b9c854`.
5. **Immediately** (same session — this starts the 1-hour approval clock,
   item 4's requirement), from the fix5 checkout:
   ```bash
   node scripts/invitationRehearsal/gateGaBuildApprovalDraft.mjs \
     --mailbox-receipt <path-from-step-2> \
     --functions-receipt <path-from-step-1> \
     --auth-metadata-receipt <path-from-step-3> \
     --staging-fingerprint 2a26dafc4fedd7f6f584f6f0e60369a7cb3097f0188ce45f90a14e9d84b9c854 \
     --out <new-absolute-private-approval.json> \
     -- \
     --execute --profile staging --project finapp-staging \
     --expected-head e1310e5314f4e6355a0fbd43eab378224044e1f6 \
     --approval <same-path-as---out-above> \
     --approval-sha256 <printed-by-this-command-use-exactly-that-value> \
     --journal <new-absolute-private-journal.jsonl> \
     --out <new-absolute-private-executor-out.json> \
     --recipient lesenenok8787@gmail.com \
     --recipient-confirmed-sha256 20cf29054a5a4cf524a93e821a90d245f9b4f601669f57ca663c7a7ffc7a9e54 \
     --resume false --legacy-cleanup-approved false
   ```
   Stop condition: if this prints `APPROVAL_DRAFT_BLOCKED`, stop and do
   not retry with different evidence chosen to force a pass.
6. **Immediately after**, run the actual executor with the exact same
   `--approval`/`--approval-sha256`/`--journal`/`--out`/`--recipient`/
   `--recipient-confirmed-sha256`/`--resume false`/
   `--legacy-cleanup-approved false` values step 5 printed/used:
   ```bash
   node scripts/invitationRehearsal/liveAcceptanceExecutor.mjs --execute \
     --profile staging --project finapp-staging \
     --expected-head e1310e5314f4e6355a0fbd43eab378224044e1f6 \
     --approval <same-path> --approval-sha256 <same-value> \
     --journal <same-path> --out <same-path> \
     --recipient lesenenok8787@gmail.com \
     --recipient-confirmed-sha256 20cf29054a5a4cf524a93e821a90d245f9b4f601669f57ca663c7a7ffc7a9e54 \
     --resume false --legacy-cleanup-approved false
   ```
   Stop condition: if the approval has expired (more than 1 hour since
   step 5), do not reuse it — rebuild from fresh evidence (steps 1–5
   again). `legacy-cleanup-approved false` and the executor's own design
   mean **no old/legacy matching record is ever deleted** by this run —
   only resources this specific run itself creates are eligible for its
   cleanup.
7. Result-saving order: the executor's own `--out` and `--journal` are
   the authoritative, already-sanitized results (no tokens, no raw
   provider payloads, no verification links) — save those two files as
   the run's evidence. Do not additionally copy or print their contents
   into any less-private location.

**No independent work remains blocked on this step besides the mailbox
lookup itself** — everything else above is fully prepared, tested
tooling.

## Item 4 — approval built immediately before use, never pre-built

No approval JSON exists anywhere in this package. `gateGaBuildApprovalDraft.mjs`
always computes `approvedAt = new Date().toISOString()` at call time and
`expiresAt = approvedAt + APPROVAL_TTL_MS` (exactly 1 hour, pinned and
verified against the reviewed executor's real constant) — see step 5
above for the exact command the owner runs right before `--execute`.

## Item 5 — tests run this round

Only the new module's own tests (16 self-test + 8 mutation, both 9/9→8/8
"DETECTED", see below) plus `typecheck`/`lint`, since no previously
reviewed file changed (`git diff --stat` empty against
`liveAcceptanceExecutorCliCore.mjs`, `gateGaDeploymentCheck13Core.mjs`,
`liveAcceptanceCore.mjs`, `deploymentCheckCore.mjs`). The full regression
suite was not re-run — it was already green on the base commit and
nothing it covers changed.

## Проверки

| Команда | Результат | Примечание |
|---|---|---|
| `npm run typecheck` | PASS | |
| `npm run lint` | PASS | 1 pre-existing unrelated warning |
| `node --test scripts/invitationRehearsal/gateGaApprovalEvidenceBindingSelfTest.mjs` | PASS 16/16 | includes the real `validateExecutionApproval` interop proof |
| `node scripts/invitationRehearsal/gateGaApprovalEvidenceBindingMutationChecks.mjs` | PASS 8/8 DETECTED | |
| `node scripts/invitationRehearsal/gateGaBuildApprovalDraft.mjs --help` | OK | no file/network access |
| Local smoke test of the builder (real functions-receipt bytes already on hand, synthetic mailbox/auth bytes, no new staging contact) | wrote a valid draft, `expiresAt - approvedAt` = 3,600,000 ms | not part of the committed package; local verification only |
| `git status --short` / `git diff --stat` on all pre-existing reviewed files | empty | fix5 and the 13fn checker branch provably untouched |

## Фактический вывод существенных тестов

```text
DETECTED M1 the core hash-equality check (the whole point of this module) removed {"exitCode":1,"fail":1}
DETECTED M2 receipt status check removed (would accept a BLOCKED receipt) {"exitCode":1,"fail":1}
DETECTED M3 receipt task-string check removed (would accept any unrelated JSON blob) {"exitCode":1,"fail":1}
DETECTED M4 receipt project check removed (would accept evidence from a different project) {"exitCode":1,"fail":1}
DETECTED M5 receipt staleness/future-timestamp check removed {"exitCode":1,"fail":2}
DETECTED M6 pinned baseline sourceHead binding check removed {"exitCode":1,"fail":1}
DETECTED M7 buildApprovalDraft no longer calls validateFunctionsShaBinding before emitting a draft {"exitCode":1,"fail":1}
DETECTED M8 APPROVAL_TTL_MS silently drifted from the reviewed executor's real constant {"exitCode":1,"fail":3}

SUMMARY total=8 detected=8 undetected=0
```

## Security review

- No `--execute`, account creation, email, deploy, PR #28 merge, or
  production action was performed or prepared to auto-run.
- The one real live network call this round was the item-1 receipt
  invocation already reported (plus its diagnostic reproduction), both
  read-only; no new live staging call was made while building this
  package.
- The mailbox lookup, still blocked in this environment, was not
  bypassed — handed to the owner as one exact read-only command.
- No secrets, tokens, service-account data, or real recipient PII beyond
  the already-authorized, already-known recipient email/hash appear in
  this report or the new code/tests.

## Данные и миграция
Нет.

## Ручная проверка
Not applicable — metadata/tooling modules; DI-based self-test and
mutation suite constitute verification, exactly as for every other module
in this codebase.

## Rollback
Delete the 4 new files and the 2 new npm script lines, or do not merge
the branch. Nothing external was touched.

## Известные ограничения

- `validateFunctionsShaBinding` is not (and, without editing the
  published fix5 executor, cannot be) a *hard* requirement inside
  `validateExecutionApproval()` itself — an approval hand-assembled
  without using `gateGaBuildApprovalDraft.mjs` could still, in principle,
  carry an unbound `functionsSha256` and pass the reviewed validator.
  Closing that completely would mean editing
  `liveAcceptanceExecutorCliCore.mjs` on a new branch built from fix5 and
  re-reviewing that specific change — a separate, explicitly scoped next
  step, not done here per this round's "don't retroactively change
  published branches" boundary.
- The M1/SEC-007 functions still have no drift baseline (unchanged
  limitation from the 13fn-checker round).

## Дополнительные находки вне scope
None beyond what is already documented above.

## Diff summary

```text
 docs/remediation/reports/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING.md | new file
 package.json                                                          |   2 ++
 scripts/invitationRehearsal/gateGaApprovalEvidenceBindingCore.mjs     | new file
 scripts/invitationRehearsal/gateGaApprovalEvidenceBindingMutationChecks.mjs | new file
 scripts/invitationRehearsal/gateGaApprovalEvidenceBindingSelfTest.mjs | new file
 scripts/invitationRehearsal/gateGaBuildApprovalDraft.mjs              | new file
```

## Следующий разрешенный пункт

Independent review of this branch. After that: the owner's one
authorized run (playbook above), or — separately, if desired — a further
scoped round to make the evidence binding a hard requirement inside the
reviewed executor's own validator. Neither is started here.

---

## Единый объединённый запрос владельцу (после завершения всей остальной работы)

1. **Только вы можете выполнить один read-only mailbox-lookup** (среда
   блокирует его для меня): команда в разделе "Item 3" выше. Результат:
   подтверждение `MAILBOX_DISCOVERY_COMPLETE` и путь к `--out` файлу.
2. **Независимое ревью** этой ветки
   (`remediation/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING` @ будет
   показан после push) — правомерность найденного пробела в
   `functionsSha256`, и достаточность узкого исправления (инструмент,
   не изменение уже опубликованного `fix5`-валидатора).
3. Если оба пункта выше пройдены — единственный оставшийся шаг
   выполняете вы сами по плейбуку в разделе "Item 3" (шаги 1–7), включая
   сам `--execute`. Я не буду ни готовить заранее собранный approval, ни
   выполнять `--execute`, ни повторять live-обращения к staging сверх
   уже описанных в `evidence/invocation-log.md`.
