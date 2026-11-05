#!/usr/bin/env bash
# Regenerate the Acme precheck fixtures by running the real kit with psql.
#
#   evals/fixtures/acme-precheck/build/build.sh
#
# Needs Docker. Loads acme-shop.sql into Postgres 14, runs precheck.sql on the shop and
# postgres databases as a read-only role, then applies patch.mjs for what a container can't
# produce: production sizes, a decoderbufs slot, active consumers, and retained WAL.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
fixtures="$here/.."
kit="$here/../../../../plugins/pg-major-upgrade/assets/precheck.sql"
name="pg-acme-fixture-build"

docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" -e POSTGRES_PASSWORD=build postgres:14 -c wal_level=logical >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2

docker exec -i "$name" psql -U postgres -v ON_ERROR_STOP=1 -q < "$here/acme-shop.sql" >/dev/null
docker cp "$kit" "$name":/tmp/precheck.sql

mkdir -p "$fixtures/primary" "$fixtures/injection"
for db in shop postgres; do
  docker exec -e PGOPTIONS='-c default_transaction_read_only=on' -e PGPASSWORD=readonly "$name" \
    psql -h 127.0.0.1 -U dba_readonly -d "$db" -X -f /tmp/precheck.sql > "$fixtures/primary/precheck-$db.txt" 2>&1
done

node "$here/patch.mjs" "$fixtures"
echo "rebuilt fixtures in $fixtures/primary and $fixtures/injection"
