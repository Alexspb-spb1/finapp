#!/usr/bin/env bash
# Corrections V1: re-runs the cheap local checks and prints every command with its REAL exit code (no pipes between a command and its status).
# Usage: bash run-correction-checks.sh <R3 package dir> <R4 package dir> <release clone dir> > corrections-v1/checks.txt
# Run from the repository (worktree) root.
set -u
export LC_ALL=C.UTF-8
BASE=714d0f91c60a582ee87dc7da82d6249b3106329f
FIRST_PASS=48b9b54269a7731da08e89fdb03f8fa4f6bdcd9b
EV=docs/remediation/evidence/M1-SAFE-STOP-RECOVERY-01
R3=$1; R4=$2; CLONE=$3
FAILED=0
run() { # name, command...   (prints the last lines of the output and the exit code)
  local name=$1; shift
  local out; out=$("$@" 2>&1); local code=$?
  echo "### $name"
  echo "cmd: $*"
  [ -n "$out" ] && printf '%s\n' "$out" | tail -n "${TAIL:-3}" | cut -c1-200
  echo "exit=$code"
  [ "$code" -eq 0 ] || FAILED=$((FAILED + 1))
}
echo "HEAD=$(git rev-parse HEAD)"
echo "BASE=$BASE"
run "git diff --check over the whole range BASE..HEAD" git diff --check "$BASE..HEAD"
run "git diff --check (working tree)" git diff --check
run "git diff --check (index)" git diff --cached --check
run "attribute: only the patch is exempt from the whitespace check" bash -c "git check-attr whitespace -- $EV/r3-to-r4.patch $EV/tooling/results-tools.mjs docs/remediation/runbooks/M1-COMPATIBILITY-ROLLOUT-20261007.md"
run "snapshot + patch + hash lists regenerate identically (apply + byte compare)" bash "$EV/tooling/make-snapshot.sh" "$R3" "$R4" "$EV"
run "regeneration changed nothing tracked" git diff --exit-code --stat -- "$EV"
run "snapshot hash list verifies (sha256sum -c --quiet prints failures only)" bash -c "cd $EV/runner-r4-source && sha256sum -c --quiet CODE-SHA256SUMS.txt"
TAIL=12 run "runner source changed since the first pass (stat)" git diff --stat "$FIRST_PASS..HEAD" -- "$EV/runner-r4-source" "$EV/r3-to-r4.patch"
run "tooling tests" node "$EV/tooling/tooling-tests.mjs"
M1_RELEASE_CLONE=$CLONE run "offline fence tests" node "$EV/offline-fence/offline-fence-tests.mjs"
run "rollout table-top check" node "$EV/rollout/tabletop-check.mjs"
run "rollout table-top tests" node "$EV/rollout/tabletop-tests.mjs"
echo "### fresh hashes"
for f in $EV/r3-to-r4.patch $EV/runner-r4-source/CODE-SHA256SUMS.txt $EV/runner-r4-source/tests/collect-results.mjs $EV/candidate-r4-sha256.txt $EV/base-r3-sha256.txt $EV/tooling/results-tools.mjs $EV/tooling/finalize-results.mjs $EV/tooling/verify-driver.mjs $EV/offline-fence/loopback-only.cjs $EV/offline-fence/isolated-env.mjs $EV/rollout/rollout-steps.json; do sha256sum -b "$f"; done
echo "failed_checks=$FAILED"
[ "$FAILED" -eq 0 ]
