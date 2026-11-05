#!/usr/bin/env bash
# Run one review round: every reviewer in REVIEWERS, in parallel, on the same files.
#
#   scripts/run-review-round.sh <rubric> <out-dir> <file-or-dir>...
#
# REVIEWERS is a required space-separated list of backend:model pairs, for example
#   REVIEWERS="cursor:gemini-4-argon-high cursor:grok-4.7-high codex:gpt-6-astra"
# There's no default, so files never go to a backend nobody chose. Each reviewer writes
# <out-dir>/<model>.json. A reviewer that fails leaves <model>.err.
set -uo pipefail

if [ "$#" -lt 3 ]; then
  sed -n '2,9p' "$0"
  exit 2
fi

rubric="$1"; outdir="$2"; shift 2
here="$(cd "$(dirname "$0")" && pwd)"
reviewers="${REVIEWERS:-}"
[ -n "$reviewers" ] || { echo "set REVIEWERS to the approved backend:model pairs" >&2; exit 2; }
mkdir -p "$outdir"

pids=()
for r in $reviewers; do
  backend="${r%%:*}"; model="${r#*:}"
  (
    if [ "$backend" = "codex" ]; then
      CODEX_REVIEW_MODEL="$model" "$here/review-with-codex.sh" "$rubric" "$outdir/$model.json" "$@"
    else
      "$here/review-with-cursor.sh" "$model" "$rubric" "$outdir/$model.json" "$@"
    fi
  ) > "$outdir/$model.log" 2> "$outdir/$model.err" && rm -f "$outdir/$model.err" &
  pids+=($!)
done

for pid in "${pids[@]}"; do wait "$pid"; done

ok=0; failed=0
for r in $reviewers; do
  model="${r#*:}"
  if [ -f "$outdir/$model.json" ]; then ok=$((ok + 1)); else failed=$((failed + 1)); echo "failed: $model (see $outdir/$model.err)"; fi
done
echo "$ok reviewers finished, $failed failed. Findings in $outdir/"
[ "$failed" -eq 0 ]
