#!/usr/bin/env bash
# M1-STAGING-READONLY-RECON-PREP-03 corrections V1: the local checks with their REAL exit codes (no pipe hides a status). Run from the repository (worktree) root:
#   bash run-recon-checks.sh <v2 candidate dir> <verification copy dir> <superseded v1 candidate dir> <S1b v2 candidate dir> > corrections-v1/test-results/checks.txt
# Nothing here opens a network connection or reads an owner credential file.
set -u
export LC_ALL=C.UTF-8
BASE=629c8318676b3879205ad2b1906cd9beff6d5f68
V1_SUMS_SHA=6fdb5009455c6c4377754d95495fb36c91775d8677dd1f977edb0eb5763c1622
EV=docs/remediation/evidence/M1-STAGING-READONLY-RECON-PREP-03
FINAL=$1; VERIFY=$2; V1=${3:-}; S1B=${4:-}
FAILED=0
run() { # name, command...
  local name=$1; shift
  local out; out=$("$@" 2>&1); local code=$?
  echo "### $name"; echo "cmd: $*"
  [ -n "$out" ] && printf '%s\n' "$out" | tail -n "${TAIL:-3}" | cut -c1-260
  echo "exit=$code"
  [ "$code" -eq 0 ] || FAILED=$((FAILED + 1))
}
echo "HEAD=$(git rev-parse HEAD)"; echo "BASE=$BASE (accepted HEAD of PR #36)"
run "git diff --check over the whole range BASE..HEAD" git diff --check "$BASE..HEAD"
run "git diff --check (working tree)" git diff --check
run "git diff --check (index)" git diff --cached --check
run "the v2 candidate directory equals the committed source tree" diff -rq "$FINAL" "$EV/package-recon-source"
run "the verification copy equals the v2 candidate (code sums)" diff "$FINAL/CODE-SHA256SUMS.txt" "$VERIFY/CODE-SHA256SUMS.txt"
run "code sums of the v2 candidate verify against the files" bash -c 'cd "$1" && sha256sum -c --quiet CODE-SHA256SUMS.txt' _ "$FINAL"
run "the generator rebuilds the source tree byte for byte (new temp directory)" node -e "import('./$EV/tooling/build-recon-package.mjs').then(m=>{const o=require('path').join(require('os').tmpdir(),'recon-regen-'+process.pid);const r=m.buildPackage(o);console.log('rebuilt',r.sumsSha256)})"
run "file table (v2) regenerates identically" bash -c "node $EV/tooling/make-file-table.mjs && git diff --exit-code --stat -- $EV/corrections-v1/recon-files-v2.txt"
TAIL=4 run "negative controls (package tests, verification copy)" node "$VERIFY/tests/recon-negative-controls.mjs"
TAIL=4 run "mutation checks with canaries (package tests, verification copy)" node "$VERIFY/tests/recon-mutation-checks.mjs"
run "repository-level tooling tests" node "$EV/tooling/recon-tooling-tests.mjs"
run "offline launcher: selftest of the v2 candidate" node "$FINAL/recon-offline.mjs" selftest
run "offline launcher: plan of the v2 candidate" bash -c 'node "$1/recon-offline.mjs" plan > /dev/null' _ "$FINAL"
run "offline launcher: permit-draft of the v2 candidate" bash -c 'node "$1/recon-offline.mjs" permit-draft > /dev/null' _ "$FINAL"
if [ -n "$V1" ]; then
  run "the superseded v1 candidate is unchanged (its own sums verify)" bash -c 'cd "$1" && sha256sum -c --quiet CODE-SHA256SUMS.txt' _ "$V1"
  run "the superseded v1 candidate sums file hash is the recorded one" bash -c '[ "$(sha256sum "$1/CODE-SHA256SUMS.txt" | cut -c1-64)" = "$2" ]' _ "$V1" "$V1_SUMS_SHA"
fi
[ -n "$S1B" ] && run "the previous candidates are unchanged (S1b v2)" bash -c 'cd "$1" && sha256sum -c --quiet CODE-SHA256SUMS.txt' _ "$S1B"
echo "### fresh hashes"
for f in $EV/package-recon-source/CODE-SHA256SUMS.txt $EV/package-recon-source/request-allowlist.json $EV/package-recon-source/frontend-allowlist.json $EV/package-recon-source/consumed-subject-pin.json $EV/package-recon-source/expected-state-r3.json $EV/package-recon-source/dist-staging-manifest.txt $EV/package-recon-source/recon.mjs $EV/package-recon-source/recon-core.mjs $EV/package-recon-source/recon-integrity.mjs $EV/package-recon-source/recon-pins.mjs $EV/package-recon-source/recon-permit.mjs $EV/package-recon-source/recon-bootstrap.mjs $EV/package-recon-source/tests/recon-negative-controls.mjs $EV/package-recon-source/tests/recon-mutation-checks.mjs $EV/package-recon-source/tests/relocate.mjs $EV/package-recon-source/offline-fence/loopback-only.cjs $EV/corrections-v1/recon-files-v2.txt; do sha256sum -b "$f"; done
echo "failed_checks=$FAILED"
[ "$FAILED" -eq 0 ]
