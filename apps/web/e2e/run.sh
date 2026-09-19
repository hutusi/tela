#!/usr/bin/env bash
# End-to-end run: local Postgres → fixture feed server → seed → worker → next build+start → Playwright.
# Usage: apps/web/e2e/run.sh [playwright args]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WEB="$ROOT/apps/web"
LOGS="${E2E_LOG_DIR:-$ROOT/.e2e-logs}"
mkdir -p "$LOGS"

DB_PORT="${E2E_DB_PORT:-54339}"
FIXTURE_PORT="${E2E_FIXTURE_PORT:-4790}"
WEB_PORT="${E2E_WEB_PORT:-3999}"
# E2E_DATABASE_URL points at an existing Postgres (CI service container); otherwise a throwaway
# cluster is started with the local initdb.
export DATABASE_URL="${E2E_DATABASE_URL:-postgresql://postgres@127.0.0.1:${DB_PORT}/postgres}"
export E2E_FIXTURE_URL="http://127.0.0.1:${FIXTURE_PORT}"
export E2E_BASE_URL="http://127.0.0.1:${WEB_PORT}"
export TELA_DEV_AUTH=1
export TELA_ALLOW_PRIVATE_HOSTS=1
export IMAGE_PROXY_SECRET="e2e-image-secret"
export NEXT_PUBLIC_SITE_URL="$E2E_BASE_URL"

# Every background service is started with `exec` inside its subshell, so the recorded pid is the
# real process, not a bash wrapper that would die and orphan it. Clients stop before the database.
pids=()
cleanup() {
  for ((i = ${#pids[@]} - 1; i >= 0; i--)); do
    kill "${pids[$i]}" 2>/dev/null || true
  done
  lsof -t -i ":${WEB_PORT}" -i ":${FIXTURE_PORT}" 2>/dev/null | xargs kill 2>/dev/null || true
  if [ -z "${E2E_DATABASE_URL:-}" ]; then
    # local-db.ts stops the cluster on SIGTERM; fast-shutdown (SIGINT) whatever still listens.
    for _ in $(seq 1 20); do lsof -t -i ":${DB_PORT}" >/dev/null 2>&1 || break; sleep 0.5; done
    lsof -t -i ":${DB_PORT}" 2>/dev/null | xargs kill -INT 2>/dev/null || true
  fi
  wait 2>/dev/null || true
}
trap cleanup EXIT

wait_for() { # url, seconds
  for _ in $(seq 1 "$2"); do curl -sf "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "timeout waiting for $1" >&2; return 1
}

echo "▸ database"
if [ -n "${E2E_DATABASE_URL:-}" ]; then
  (cd "$ROOT/packages/db" && bun run scripts/prepare-db.ts) > "$LOGS/db.log" 2>&1 || { cat "$LOGS/db.log"; exit 1; }
else
  (cd "$ROOT/packages/db" && exec bun run scripts/local-db.ts --port "$DB_PORT" > "$LOGS/db.log" 2>&1) &
  pids+=($!)
  for _ in $(seq 1 60); do grep -q "ready" "$LOGS/db.log" 2>/dev/null && break; sleep 1; done
  grep -q "ready" "$LOGS/db.log" || { cat "$LOGS/db.log"; exit 1; }
fi

echo "▸ fixture server"
(cd "$WEB" && exec bun run e2e/fixture-server.ts "$FIXTURE_PORT" > "$LOGS/fixtures.log" 2>&1) &
pids+=($!)
wait_for "$E2E_FIXTURE_URL/pixel.png" 20

echo "▸ seed"
(cd "$WEB" && bun run e2e/seed.ts) > "$LOGS/seed.log" 2>&1 || { cat "$LOGS/seed.log"; exit 1; }

echo "▸ worker"
(cd "$ROOT/apps/worker" && bun run build > "$LOGS/worker-build.log" 2>&1)
(cd "$ROOT/apps/worker" && WORKER_ROLES=scheduler,fetch,extract,translate,claim,assets WORKER_ALLOW_PRIVATE_HOSTS=1 WEBSUB_ENABLED=1 LLM_PROVIDER=mock LLM_MOCK_DROP_MARKER='[[drop]]' ASSETS_DIR="$LOGS/assets" PUBLIC_URL="$E2E_BASE_URL" LOG_LEVEL=info exec node dist/index.js > "$LOGS/worker.log" 2>&1) &
pids+=($!)

echo "▸ web build"
(cd "$WEB" && bun run build > "$LOGS/web-build.log" 2>&1) || { tail -40 "$LOGS/web-build.log"; exit 1; }
echo "▸ web start"
(cd "$WEB" && exec bunx next start -p "$WEB_PORT" > "$LOGS/web.log" 2>&1) &
pids+=($!)
wait_for "$E2E_BASE_URL/login" 60

dump() {
  psql "$DATABASE_URL" -Atc "select name, state, data::text, created_on, started_on, completed_on from pgboss.job order by created_on" > "$LOGS/jobs.txt" 2>&1 || true
  psql "$DATABASE_URL" -Atc "select id, feed_url, status, last_fetched_at, next_fetch_at, error_count, last_error from feeds" > "$LOGS/feeds.txt" 2>&1 || true
}
trap 'dump; cleanup' EXIT

echo "▸ playwright"
cd "$WEB" && bunx playwright test "$@"
