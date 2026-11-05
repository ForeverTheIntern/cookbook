#!/usr/bin/env bash
# Run precheck.sql against disposable Postgres containers and check its output.
#
#   tests/sql/run-precheck.sh [versions...]     default: 14 18
#
# Needs Docker. Each version gets a fresh container with wal_level=logical, the
# fixture from fixture.sql, and two runs of the kit: as the superuser and as a
# read-only role with default_transaction_read_only=on.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
kit="$here/../../plugins/pg-major-upgrade/assets/precheck.sql"
out="$here/out"
mkdir -p "$out"
versions=("${@:-14 18}")
[ "$#" -eq 0 ] && versions=(14 18)
fail=0

check() {
  local file="$1" label="$2"; shift 2
  for pattern in "$@"; do
    if ! grep -qF -- "$pattern" "$file"; then
      echo "  FAIL $label: expected '$pattern'"
      fail=1
    fi
  done
}

for v in "${versions[@]}"; do
  name="pg-precheck-test-$v"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" -e POSTGRES_PASSWORD=test postgres:"$v" -c wal_level=logical >/dev/null
  for _ in $(seq 1 60); do docker exec "$name" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
  sleep 2
  docker exec -i "$name" psql -U postgres -v ON_ERROR_STOP=1 -q < "$here/fixture.sql" > "$out/fixture-$v.log" 2>&1
  docker cp "$kit" "$name":/tmp/precheck.sql

  docker exec -e PGOPTIONS='-c default_transaction_read_only=on' "$name" \
    psql -U postgres -X -f /tmp/precheck.sql > "$out/precheck-$v-superuser.txt" 2>&1
  docker exec -e PGOPTIONS='-c default_transaction_read_only=on' -e PGPASSWORD=reader "$name" \
    psql -h 127.0.0.1 -U precheck_reader -d postgres -X -f /tmp/precheck.sql > "$out/precheck-$v-reader.txt" 2>&1

  # The per-database loop from the kit's header, exactly as documented
  loop="$(sed -n 's/^--   //p' "$kit" | sed -n '/^for db in/,/^done/p' | sed 's/^  //')"
  docker exec -e PGPASSWORD=reader "$name" bash -c "cd /tmp && $(printf '%s' "$loop" | sed 's#<conninfo>#host=127.0.0.1 user=precheck_reader#g')" \
    > "$out/loop-$v.log" 2>&1
  for db in postgres; do
    if ! docker exec "$name" test -s "/tmp/precheck-$db.txt"; then
      echo "  FAIL loop: the header's per-database loop produced no precheck-$db.txt"; fail=1
    fi
  done

  echo "Postgres $v"
  for run in superuser reader; do
    f="$out/precheck-$v-$run.txt"
    if grep -n "ERROR" "$f" >/dev/null; then
      echo "  FAIL $run: ERROR in output"; grep -n "ERROR" "$f" | head -5; fail=1
    fi
    check "$f" "$run" "== 0." "== 8g." "is_replica" "normalize_tags(text[])" "price_band(numeric)" \
      "tmp_backfill" "vendor_settings" "orders_feed" "test_slot" "price_windows" "fn"
  done
  if [ "$v" -lt 18 ]; then
    check "$out/precheck-$v-superuser.txt" "superuser" "legacy_child"
  fi
  check "$out/precheck-$v-reader.txt" "reader" "cannot read pg_authid"
  check "$out/precheck-$v-superuser.txt" "superuser" "scram-sha-256"
  docker rm -f "$name" >/dev/null
done

[ "$fail" -eq 0 ] && echo "precheck SQL passed on: ${versions[*]}"
exit "$fail"
