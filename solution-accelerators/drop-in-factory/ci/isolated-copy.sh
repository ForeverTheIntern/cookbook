#!/usr/bin/env bash
# Copy this accelerator to a temp directory and run its offline checks there,
# with no credentials: the typecheck (which covers Foreman) and the tests.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -R "$root" "$tmp/accelerator"
rm -rf "$tmp/accelerator/node_modules" "$tmp/accelerator/foreman/node_modules" "$tmp/accelerator/dashboard/node_modules" "$tmp/accelerator/data" "$tmp/accelerator/.env"
cd "$tmp/accelerator"
for f in README.md ARCHITECTURE.md docs/security.md AGENTS.md factory.yaml setup/compose.yaml dashboard/Dockerfile examples/github-workflows/static-checks.yml; do
  test -f "$f"
done
npm ci --ignore-scripts --silent
(cd foreman && npm ci --ignore-scripts --silent)
npm run --silent typecheck
npm test --silent
echo "isolated-copy: ok"
