#!/usr/bin/env bash
# M1-STAGING-READONLY-RECON-PREP-03: the local checks with their REAL exit codes (no pipe hides a status). Run from the repository (worktree) root:
#   bash run-recon-checks.sh <final candidate dir> <verification copy dir> > test-results/checks.txt
# Nothing here opens a network connection or reads an owner credential file.
set -u
export LC_ALL=C.UTF-8
BASE=629c8318676b3879205ad2b1906cd9beff6d5f68
EV=docs/remediation/evidence/M1-STAGING-READONLY-RECON-PREP-03
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
echo "HEAD=$(git rev-parse HEAD)"; echo "BASE=$BASE (accepted HEAD of PR #36)"
run "git diff --check over the whole range BASE..HEAD" git diff --check "$BASE..HEAD"
run "git diff --check (working tree)" git diff --check
run "git diff --check (index)" git diff --cached --check
run "the final candidate directory equals the committed source tree" diff -rq "$FINAL" "$EV/package-recon-source"
run "the verification copy equals the final candidate (code sums)" diff "$FINAL/CODE-SHA256SUMS.txt" "$VERIFY/CODE-SHA256SUMS.txt"
run "code sums of the final candidate verify against the files" bash -c 'cd "$1" && sha256sum -c --quiet CODE-SHA256SUMS.txt' _ "$FINAL"
run "the generator rebuilds the source tree byte for byte (new temp directory)" node -e "import('./$EV/tooling/build-recon-package.mjs').then(m=>{const o=require('path').join(require('os').tmpdir(),'recon-regen-'+process.pid);const r=m.buildPackage(o);console.log('rebuilt',r.sumsSha256)})"
run "file table regenerates identically" bash -c "node $EV/tooling/make-file-table.mjs && git diff --exit-code --stat -- $EV/recon-files.txt"
TAIL=4 run "negative controls (package tests, verification copy)" node "$VERIFY/tests/recon-negative-controls.mjs"
TAIL=3 run "mutation checks (package tests, verification copy)" node "$VERIFY/tests/recon-mutation-checks.mjs"
run "repository-level tooling tests" node "$EV/tooling/recon-tooling-tests.mjs"
run "offline launcher: selftest" node "$FINAL/recon-offline.mjs" selftest
[ -n "${3:-}" ] && run "the previous candidates are unchanged (S1b v2)" bash -c 'cd "$1" && sha256sum -c --quiet CODE-SHA256SUMS.txt' _ "$3"
echo "### fresh hashes"
for f in $EV/package-recon-source/CODE-SHA256SUMS.txt $EV/package-recon-source/request-allowlist.json $EV/package-recon-source/frontend-allowlist.json $EV/package-recon-source/consumed-subject-pin.json $EV/package-recon-source/expected-state-r3.json $EV/package-recon-source/dist-staging-manifest.txt $EV/package-recon-source/recon.mjs $EV/package-recon-source/recon-core.mjs $EV/package-recon-source/recon-pins.mjs $EV/package-recon-source/recon-permit.mjs $EV/package-recon-source/recon-bootstrap.mjs $EV/package-recon-source/tests/recon-negative-controls.mjs $EV/package-recon-source/tests/recon-mutation-checks.mjs $EV/package-recon-source/offline-fence/loopback-only.cjs $EV/recon-files.txt; do sha256sum -b "$f"; done
echo "failed_checks=$FAILED"
[ "$FAILED" -eq 0 ]
