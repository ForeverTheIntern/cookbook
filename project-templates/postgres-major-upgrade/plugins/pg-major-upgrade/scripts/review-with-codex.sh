#!/usr/bin/env bash
# Run one independent review with the Codex CLI.
#
#   scripts/review-with-codex.sh <rubric> <out.json> <file-or-dir>...
#
#   rubric   sop | skills | readme | gate
#   out.json where the findings JSON is written
#
# The files are copied into a scratch directory, so the reviewer sees only them,
# the reviewer prompt, the findings schema and reference/sources.json.
#
# Env:
#   CODEX_REVIEW_MODEL   model id (default gpt-6-astra)
#   CODEX_REVIEW_EFFORT  reasoning effort (default high)
#   CODEX_REVIEW_WEB     1 to let the reviewer search the web for sources (default 1)
set -euo pipefail

if [ "$#" -lt 3 ]; then
  sed -n '2,17p' "$0"
  exit 2
fi

rubric="$1"; out="$2"; shift 2
case "$rubric" in sop|skills|readme|gate) ;; *) echo "unknown rubric: $rubric" >&2; exit 2 ;; esac

here="$(cd "$(dirname "$0")/.." && pwd)"
plugin="$here"
model="${CODEX_REVIEW_MODEL:-gpt-6-astra}"
effort="${CODEX_REVIEW_EFFORT:-high}"
web="${CODEX_REVIEW_WEB:-1}"

command -v codex >/dev/null || { echo "codex CLI not found; install @openai/codex and sign in" >&2; exit 1; }

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
Set "reviewer" to "$model via codex" and "rubric" to "$rubric".
Return only the JSON object that matches findings.schema.json.
EOF
)"

args=(exec -m "$model" -c "model_reasoning_effort=\"$effort\"" -s read-only --ephemeral --skip-git-repo-check
      -C "$scratch" --output-schema "$scratch/findings.schema.json" -o "$scratch/findings.json" --color never)
[ "$web" = "1" ] && args+=(-c 'tools.web_search=true')

mkdir -p "$(dirname "$out")"
codex "${args[@]}" "$prompt" > "$scratch/codex.log" 2>&1 || { tail -40 "$scratch/codex.log" >&2; exit 1; }
cp "$scratch/findings.json" "$out"
echo "wrote $out"
