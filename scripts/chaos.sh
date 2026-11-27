#!/usr/bin/env bash
# Chaos checks against a running compose stack (`docker compose up -d` first). Run from anywhere.
#
#   scripts/chaos.sh            # both legs
#   scripts/chaos.sh worker     # leg (a): kill the worker mid-extraction
#   scripts/chaos.sh redis      # leg (b): wipe Redis and restart everything
#
# Leg (a) needs a SLOW LLM so a run stays `extracting` long enough to kill the worker, e.g. a fake
# OpenAI-compatible server that delays its answers, wired in via LLM_BASE_URL / LLM_MODEL in .env.
# Leg (b) works with any LLM setup (including none: documents then end `failed`, never stuck).
#
# Tunables (env): WEB_URL (default http://localhost:3000), EXTRACTING_WAIT_S (60), SETTLE_WAIT_S (120),
# REDIS_WAIT_S (90), DOC_EXTERNAL_ID (doc-invoice-001), V2_FILE (assignment/fixtures/documents/invoice-001.v2.pdf).
set -uo pipefail

cd "$(dirname "$0")/.."
WEB_URL=${WEB_URL:-http://localhost:3000}
EXTRACTING_WAIT_S=${EXTRACTING_WAIT_S:-60}
SETTLE_WAIT_S=${SETTLE_WAIT_S:-120}
REDIS_WAIT_S=${REDIS_WAIT_S:-90}
DOC_EXTERNAL_ID=${DOC_EXTERNAL_ID:-doc-invoice-001}
V2_FILE=${V2_FILE:-assignment/fixtures/documents/invoice-001.v2.pdf}

sql() { docker compose exec -T postgres psql -U postgres -At -c "$1" | tr -d '\r'; }
counts() {
  sql "select (select count(*) from documents)||','||(select count(*) from document_versions)||','||(select count(*) from extracted_values)||','||(select count(*) from reviews)"
}
extracting_count() { sql "select count(*) from extraction_runs where status = 'extracting'"; }
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

leg_worker() {
  echo "== leg (a): kill worker mid-extraction"
  local doc_id; doc_id=$(sql "select id from documents where external_id = '$DOC_EXTERNAL_ID'")
  [ -n "$doc_id" ] || fail "document $DOC_EXTERNAL_ID not found (is the stack up and seeded?)"
  local version_no; version_no=$(sql "select max(version) from document_versions where document_id = '$doc_id'")
  local resp; resp=$(curl -fsS -X POST -F "file=@$V2_FILE;type=application/pdf" "$WEB_URL/api/documents/$doc_id/versions") \
    || fail "upload of $V2_FILE failed"
  echo "uploaded: $resp"
  local new_no=$((version_no + 1))
  local latest="select r.status from extraction_runs r join document_versions v on v.id = r.version_id
    where v.document_id = '$doc_id' and v.version = $new_no order by r.attempt desc limit 1"

  local waited=0 status=""
  while [ "$waited" -lt "$EXTRACTING_WAIT_S" ]; do
    status=$(sql "$latest")
    [ "$status" = "extracting" ] && break
    sleep 1; waited=$((waited + 1))
  done
  [ "$status" = "extracting" ] || fail "run never reached 'extracting' (last status: '$status'); leg (a) needs a slow LLM"

  docker compose kill worker >/dev/null
  echo "worker killed while extracting"
  docker compose up -d worker >/dev/null

  waited=0
  while [ "$waited" -lt "$SETTLE_WAIT_S" ]; do
    status=$(sql "$latest")
    if [ "$status" = "extracted" ] || [ "$status" = "failed" ]; then
      pass "v$new_no reached '$status' after worker restart (${waited}s)"
      return 0
    fi
    sleep 2; waited=$((waited + 2))
  done
  fail "v$new_no still '$status' ${SETTLE_WAIT_S}s after worker restart"
}

leg_redis() {
  echo "== leg (b): FLUSHALL redis + restart stack"
  local before; before=$(counts)
  echo "counts before (documents,versions,values,reviews): $before"
  docker compose exec -T redis redis-cli FLUSHALL >/dev/null
  docker compose restart >/dev/null
  # Wait (up to REDIS_WAIT_S) for every run to leave queued/extracting, then assert.
  local waited=0 pending=""
  while [ "$waited" -lt "$REDIS_WAIT_S" ]; do
    pending=$(sql "select count(*) from extraction_runs where status in ('queued','extracting')" 2>/dev/null || echo "?")
    [ "$pending" = "0" ] && break
    sleep 3; waited=$((waited + 3))
  done
  local n
  n=$(extracting_count)
  [ "$n" = "0" ] || fail "$n run(s) still 'extracting' after ${REDIS_WAIT_S}s"
  local after; after=$(counts)
  echo "counts after:  $after"
  [ "$before" = "$after" ] || fail "row counts changed ($before -> $after)"
  pass "no run stuck in 'extracting'; row counts unchanged"
}

case "${1:-all}" in
  worker) leg_worker ;;
  redis) leg_redis ;;
  all) leg_worker; leg_redis ;;
  *) echo "usage: $0 [worker|redis|all]"; exit 2 ;;
esac
