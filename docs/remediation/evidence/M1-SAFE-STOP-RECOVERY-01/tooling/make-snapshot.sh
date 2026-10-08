#!/usr/bin/env bash
# Regenerates the byte-exact evidence of the candidate runner package from the two local package directories (read-only for both):
#   runner-r4-source/  (every file listed in the candidate's CODE-SHA256SUMS.txt, the sums file, .gitattributes "* -text")
#   r3-to-r4.patch     (unified diff consumed R3 -> candidate R4, applyable with `patch -p1 --binary`)
#   base-r3-sha256.txt / candidate-r4-sha256.txt (hashes of the changed files + the sums files)
# and verifies the result: the patch applied to a copy of R3 reproduces R4 byte for byte.
# Usage: bash make-snapshot.sh <R3 package dir> <R4 package dir> <evidence dir>
set -euo pipefail
export LC_ALL=C
R3=$(cd "$1" && pwd); R4=$(cd "$2" && pwd); EV=$(cd "$3" && pwd)
SNAP="$EV/runner-r4-source"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

(cd "$R4" && node tests/make-code-sums.mjs)
rm -rf "$SNAP"; mkdir -p "$SNAP"
while IFS= read -r line; do
  f=${line#*  }
  mkdir -p "$SNAP/$(dirname "$f")"; cp "$R4/$f" "$SNAP/$f"
done < "$R4/CODE-SHA256SUMS.txt"
cp "$R4/CODE-SHA256SUMS.txt" "$SNAP/CODE-SHA256SUMS.txt"
printf '* -text\n' > "$SNAP/.gitattributes"

# changed files: listed in the R4 sums with a different (or no) hash in the R3 sums
MOD=(); NEW=()
while IFS= read -r line; do
  h=${line%%  *}; f=${line#*  }
  old=$(awk -v f="$f" 'substr($0, 67) == f { print $1 }' "$R3/CODE-SHA256SUMS.txt")
  if [ -z "$old" ]; then NEW+=("$f"); elif [ "$old" != "$h" ]; then MOD+=("$f"); fi
done < "$R4/CODE-SHA256SUMS.txt"

: > "$EV/r3-to-r4.patch"
for f in "${MOD[@]}"; do diff -u --label "a/$f" --label "b/$f" "$R3/$f" "$R4/$f" >> "$EV/r3-to-r4.patch" || [ $? -eq 1 ]; done
for f in "${NEW[@]}"; do diff -u --label /dev/null --label "b/$f" /dev/null "$R4/$f" >> "$EV/r3-to-r4.patch" || [ $? -eq 1 ]; done

: > "$EV/base-r3-sha256.txt"; : > "$EV/candidate-r4-sha256.txt"
for f in "${MOD[@]}"; do echo "$(sha256sum -b "$R3/$f" | cut -d' ' -f1) *$f" >> "$EV/base-r3-sha256.txt"; done
echo "$(sha256sum -b "$R3/CODE-SHA256SUMS.txt" | cut -d' ' -f1) *CODE-SHA256SUMS.txt" >> "$EV/base-r3-sha256.txt"
for f in "${MOD[@]}" "${NEW[@]}"; do echo "$(sha256sum -b "$R4/$f" | cut -d' ' -f1) *$f" >> "$EV/candidate-r4-sha256.txt"; done
echo "$(sha256sum -b "$R4/CODE-SHA256SUMS.txt" | cut -d' ' -f1) *CODE-SHA256SUMS.txt" >> "$EV/candidate-r4-sha256.txt"

# verification: R3 copy + patch (+ regenerated code sums) == R4, and the snapshot == R4 for every listed file
mkdir -p "$WORK/r3"
(cd "$R3" && tar --exclude=./results -cf - .) | (cd "$WORK/r3" && tar -xf -)
(cd "$WORK/r3" && patch -p1 --binary -s < "$EV/r3-to-r4.patch" && node tests/make-code-sums.mjs >/dev/null)
diff -rq -x results "$WORK/r3" "$R4" && echo "PATCH_APPLY_BYTE_COMPARE_OK modified=${#MOD[@]} new=${#NEW[@]}"
(cd "$SNAP" && while IFS= read -r line; do f=${line#*  }; cmp -s "$f" "$R4/$f" || { echo "SNAPSHOT_DIFFERS $f"; exit 1; }; done < CODE-SHA256SUMS.txt) && echo "SNAPSHOT_BYTE_COMPARE_OK files=$(wc -l < "$R4/CODE-SHA256SUMS.txt")"
