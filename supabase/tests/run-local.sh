#!/usr/bin/env bash
# Applies every migration to a throwaway local Postgres and runs the SQL tests.
# Needs Postgres 15+ binaries (initdb, pg_ctl, psql). Usage: supabase/tests/run-local.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
bin="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
data="$(mktemp -d)"
port="${PG_PORT:-55432}"
cleanup() { "$bin/pg_ctl" -D "$data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$data"; }
trap cleanup EXIT

if [ "$(id -u)" = 0 ]; then echo "Run as a non-root user (initdb refuses root)." >&2; exit 1; fi
"$bin/initdb" -D "$data" -U postgres -A trust >/dev/null
"$bin/pg_ctl" -D "$data" -o "-p $port -k $data -c listen_addresses=''" -w start >/dev/null
psql=(psql -X -q -v ON_ERROR_STOP=1 -h "$data" -p "$port" -U postgres -d postgres)

"${psql[@]}" -f "$here/00_local_stub.sql"
for f in "$root"/migrations/*.sql; do
  if grep -qi 'create extension if not exists pg_cron' "$f" && ! "${psql[@]}" -tAc "select 1 from pg_available_extensions where name = 'pg_cron'" | grep -q 1; then
    echo "skip $(basename "$f") (pg_cron not installed locally)"; continue
  fi
  echo "apply $(basename "$f")"
  "${psql[@]}" -f "$f"
done
echo "apply seed.sql"
"${psql[@]}" -f "$root/seed.sql"
for t in "$here"/[1-9]*_test.sql; do
  echo "test $(basename "$t")"
  if ! out="$("${psql[@]}" -f "$t" 2>&1 >/dev/null)"; then echo "$out"; echo "FAILED: $(basename "$t")" >&2; exit 1; fi
  echo "$out" | sed -n 's/.*NOTICE:  //p; /passed/p'
done
for t in "$here"/[1-9]*_race.sh; do
  [ -e "$t" ] || continue
  echo "test $(basename "$t")"
  PSQL_ARGS="${psql[*]}" bash "$t"
done
echo "All SQL tests passed."
