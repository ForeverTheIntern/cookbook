#!/usr/bin/env bash
# Run one independent review with the Cursor CLI in read-only ask mode.
#
#   scripts/review-with-cursor.sh <model> <rubric> <out.json> <file-or-dir>...
#
#   model    a model id from `cursor-agent --list-models`, e.g. gemini-4-argon-high
#   rubric   sop | skills | readme | gate
#   out.json where the findings JSON is written
#
# The files are copied into a scratch directory, so the reviewer sees only them,
# the reviewer prompt, the findings schema and reference/sources.json.
set -euo pipefail

if [ "$#" -lt 4 ]; then
  sed -n '2,12p' "$0"
  exit 2
fi

model="$1"; rubric="$2"; out="$3"; shift 3
case "$rubric" in sop|skills|readme|gate) ;; *) echo "unknown rubric: $rubric" >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")/.." && pwd)"
plugin="$here"
cli="$(command -v cursor-agent || command -v agent || true)"
[ -n "$cli" ] || { echo "cursor-agent CLI not found; install it and run cursor-agent login" >&2; exit 1; }

scratch="$(mktemp -d "${TMPDIR:-/tmp}/pg-review.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/review/reference"

for item in "$@"; do
  rel="${item#"$here"/}"
  mkdir -p "$scratch/review/$(dirname "$rel")"
  cp -R "$item" "$scratch/review/$rel"
done
cp "$plugin/reference/sources.json" "$scratch/review/reference/sources.json"
cp "$plugin/agents/independent-reviewer.md" "$scratch/reviewer.md"
cp "$plugin/agents/findings.schema.json" "$scratch/findings.schema.json"

prompt="$(cat <<EOF
Follow the instructions in reviewer.md exactly. Use the "$rubric" rubric.
The artifacts to review are under review/. Cite files by their path under review/.
Set "reviewer" to "$model via cursor-agent" and "rubric" to "$rubric".
Your final message must be only the JSON object that matches findings.schema.json, with no prose and no code fence.
EOF
)"

mkdir -p "$(dirname "$out")"
# stdin must be closed, or the CLI waits for piped input. A watchdog stops runs that hang.
"$cli" -p --mode ask --trust --model "$model" --output-format text --workspace "$scratch" "$prompt" \
  < /dev/null > "$scratch/raw.txt" 2> "$scratch/err.txt" &
pid=$!
( sleep "${REVIEW_TIMEOUT_SECONDS:-1800}"; kill "$pid" 2>/dev/null ) &
watchdog=$!
if ! wait "$pid"; then
  kill "$watchdog" 2>/dev/null
  echo "cursor-agent failed or timed out after ${REVIEW_TIMEOUT_SECONDS:-1800}s" >&2
  tail -40 "$scratch/err.txt" >&2
  exit 1
fi
kill "$watchdog" 2>/dev/null || true

node "$here/scripts/extract-findings.mjs" "$scratch/raw.txt" "$out" || {
  cp "$scratch/raw.txt" "$out.raw.txt"
  echo "kept raw reviewer output at $out.raw.txt" >&2
  exit 1
}
echo "wrote $out"
