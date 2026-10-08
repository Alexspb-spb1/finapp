#!/usr/bin/env bash
# M1-STAGING-R3-SMOKE-PREP-02: the cheap local checks with their REAL exit codes (no pipe hides a status). Run from the repository (worktree) root:
#   bash run-s1b-checks.sh <final package dir> <verification copy dir> > rehearsal-results/checks.txt
# The emulator rehearsal (tooling/run-s1b-rehearsal.mjs) is run separately; its sanitized output is committed under rehearsal-results/.
set -u
export LC_ALL=C.UTF-8
BASE=8dd6e86038a1aec435d64d9afb2e2448c4711c04
EV=docs/remediation/evidence/M1-STAGING-R3-SMOKE-PREP-02
FINAL=$1; VERIFY=$2
FAILED=0
run() { # name, command...
  local name=$1; shift
  local out; out=$("$@" 2>&1); local code=$?
  echo "### $name"; echo "cmd: $*"
  [ -n "$out" ] && printf '%s\n' "$out" | tail -n "${TAIL:-3}" | cut -c1-220
  echo "exit=$code"
  [ "$code" -eq 0 ] || FAILED=$((FAILED + 1))
}
echo "HEAD=$(git rev-parse HEAD)"; echo "BASE=$BASE (HEAD of the accepted PR #35)"
run "git diff --check over the whole range BASE..HEAD" git diff --check "$BASE..HEAD"
run "git diff --check (working tree)" git diff --check
run "git diff --check (index)" git diff --cached --check
run "attribute: only the two patches are exempt from the whitespace check" bash -c "git check-attr whitespace -- $EV/r4-to-s1b.patch docs/remediation/evidence/M1-SAFE-STOP-RECOVERY-01/r3-to-r4.patch $EV/tooling/build-s1b-package.mjs"
run "the final candidate directory equals the committed source tree" diff -rq "$FINAL" "$EV/package-s1b-source"
run "the verification copy equals the final candidate (code sums)" diff "$FINAL/CODE-SHA256SUMS.txt" "$VERIFY/CODE-SHA256SUMS.txt"
run "code sums of the final candidate verify against the files" bash -c "cd $FINAL && sha256sum -c --quiet CODE-SHA256SUMS.txt"
run "the generator rebuilds the source tree byte for byte (new temp directory)" node -e "import('./$EV/tooling/build-s1b-package.mjs').then(m=>{const o=require('path').join(require('os').tmpdir(),'s1b-regen-'+process.pid);const r=m.buildPackage(o);console.log('rebuilt',r.sumsSha256)})"
run "diff against the accepted R4 snapshot regenerates identically (apply + byte compare)" bash "$EV/tooling/make-s1b-diff.sh" "$EV" docs/remediation/evidence/M1-SAFE-STOP-RECOVERY-01/runner-r4-source
run "regeneration changed nothing tracked" git diff --exit-code --stat -- "$EV"
TAIL=6 run "negative controls (package tests, verification copy)" node "$VERIFY/tests/s1b-negative-controls.mjs"
TAIL=3 run "mutation checks (package tests, verification copy)" node "$VERIFY/tests/s1b-mutation-checks.mjs"
run "S1b fence tests against the package copy of the fence" env M1_RELEASE_CLONE='D:\projects\finapp\m1-release-714d0f91' node "$EV/tooling/s1b-fence-tests.mjs"
run "repository-level S1b tooling tests" node "$EV/tooling/s1b-tooling-tests.mjs"
run "offline launcher: selftest" node "$FINAL/m1-s1b-offline.mjs" selftest
echo "### fresh hashes"
for f in $EV/r4-to-s1b.patch $EV/s1b-vs-r4-files.txt $EV/package-s1b-source/CODE-SHA256SUMS.txt $EV/package-s1b-source/operation-budget.json $EV/package-s1b-source/expected-state-r3.json $EV/package-s1b-source/dist-staging-manifest.txt $EV/package-s1b-source/m1-s1b.mjs $EV/package-s1b-source/m1-s1b-flow.mjs $EV/package-s1b-source/m1-s1b-pins.mjs $EV/package-s1b-source/m1-s1b-permit.mjs $EV/package-s1b-source/m1-transport.mjs $EV/package-s1b-source/m1-core.mjs $EV/package-s1b-source/offline-fence/loopback-only.cjs $EV/package-s1b-source/offline-fence/FENCE-PINS.json; do sha256sum -b "$f"; done
echo "failed_checks=$FAILED"
[ "$FAILED" -eq 0 ]
