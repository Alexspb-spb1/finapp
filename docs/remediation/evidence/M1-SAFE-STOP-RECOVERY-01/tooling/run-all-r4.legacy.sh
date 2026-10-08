#!/usr/bin/env bash
# HISTORIC - kept only to document how the first verification run was produced (Corrections V1, CR1). DO NOT REUSE: step() ignores failing exit codes, the
# `| tee` pipelines hide the exit codes of the helpers (no pipefail), and the final marker is printed unconditionally. Replaced by tooling/verify-driver.mjs.
# M1-SAFE-STOP-RECOVERY-01: full verification of the candidate package m1-r4-staging (sequential; emulators only, no cloud, no credentials).
set -u
RT=/d/projects/finapp/.runtime
S=$RT/m1-r4-staging
R=$S/results
PW="powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass"
SUMMARY=$RT/m1-714d0f91/run-all-r4.summary
: > "$SUMMARY"
say() { echo "$*" | tee -a "$SUMMARY"; }
step() { # name, outfile, command...
  local name=$1 out=$2; shift 2
  "$@" > "$out" 2>&1
  local code=$?
  say "$name exit=$code :: $(grep -E 'PASS [0-9]+/[0-9]+|FAIL [0-9]+/[0-9]+|detected=|exit=|STATUS|PS51_PARSE_CHECK|M1_SUMS|results files' "$out" | tail -1 | cut -c1-150)"
}
stop_emulators() { $PW -Command "Get-CimInstance Win32_Process | Where-Object { (\$_.Name -match '^(node|java)(\.exe)?\$') -and (\$_.CommandLine -match 'emulators:start|cloud-firestore-emulator|demo-finapp') } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue }"; }

stop_emulators   # the Auth/Firestore-only emulators of the earlier run
cd "$S" || exit 1
mkdir -p "$R"
node tests/normalize-ps1-bom.mjs >/dev/null
node tests/make-code-sums.mjs | tee -a "$SUMMARY"
step parse $R/ps51-parse-check.txt $PW -File tests/ps51-parse-check.ps1
step node-helper $R/node-helper-tests.txt node tests/node-helper-tests.mjs
step export-poll $R/export-poll-tests.txt node tests/export-poll-tests.mjs
step transport-classification $R/transport-classification-tests.txt node tests/transport-classification-tests.mjs
step ui-route $R/ui-route-policy-tests.txt node ui-route-policy-tests.mjs
M1_WEB_CONFIG='D:\projects\finapp\finapp\.env.staging.local' step local-acl $R/local-acl-webconfig-tests.txt node local-acl-webconfig-tests.mjs
step orch-helpers $R/ps51-orchestrator-tests-helpers.txt $PW -File tests/ps51-orchestrator-tests.ps1 -Set helpers
step orch-stub $R/ps51-orchestrator-tests-stub.txt $PW -File tests/ps51-orchestrator-tests.ps1 -Set stub

cd /d/projects/finapp/m1-release-714d0f91 || exit 1
export PATH="$RT/jdk-21.0.12.1+1-jre/bin:$PATH"
FUNCTIONS_DISCOVERY_TIMEOUT=120 node node_modules/firebase-tools/lib/bin/firebase.js emulators:start --project demo-finapp --only auth,firestore,functions > "$RT/emulators-r4-full.log" 2>&1 &
for i in $(seq 1 120); do grep -q "All emulators ready" "$RT/emulators-r4-full.log" 2>/dev/null && break; sleep 3; done
grep -q "All emulators ready" "$RT/emulators-r4-full.log" && say "emulators ready" || say "emulators NOT ready"
cd "$S" || exit 1
LOAD="node tests/load-emulator-rules.mjs --file D:\\projects\\finapp\\m1-release-714d0f91\\firestore.rules"
$LOAD | tee -a "$SUMMARY"
step gate-tests $R/emulator-cleanup-gate-tests.txt node emulator-cleanup-gate-tests.mjs
$LOAD | tee -a "$SUMMARY"
step direct-smoke $R/direct-emulator-smoke.txt node tests/direct-emulator-smoke.mjs
step seed-stop-recovery $R/seed-stop-recovery-emulator.txt node tests/seed-stop-recovery-emulator.mjs
$LOAD | tee -a "$SUMMARY"
step orch-emulator $R/ps51-orchestrator-tests-emulator.txt $PW -File tests/ps51-orchestrator-tests.ps1 -Set emulator
step mutation $R/mutation-checks.txt node tests/mutation-checks.mjs
step mutation-extra $R/mutation-checks-extra.txt node tests/mutation-checks-extra.mjs
step mutation-export $R/mutation-checks-export.txt node tests/mutation-checks-export.mjs
step mutation-recovery $R/mutation-checks-recovery.txt node tests/mutation-checks-recovery.mjs
stop_emulators
say "emulators stopped; release clone changes: $(git -C /d/projects/finapp/m1-release-714d0f91 status --short | wc -l)"
node tests/collect-results.mjs | tee -a "$SUMMARY"
node "$RT/m1-714d0f91/redact-results.mjs" "$S" | tee -a "$SUMMARY"
node "$RT/m1-714d0f91/results-sums.mjs" "$S" | tee -a "$SUMMARY"
node tests/make-code-sums.mjs | tee -a "$SUMMARY"
node m1-verify-sums.mjs --sums 'D:\projects\finapp\.runtime\m1-r4-staging\CODE-SHA256SUMS.txt' --root 'D:\projects\finapp\.runtime\m1-r4-staging' | tee -a "$SUMMARY"
say RUN_ALL_R4_DONE
