#!/usr/bin/env bash
# End-to-end run of the local-first stack: build tela-web → fixture feed server → tela-web,
# tela-api and tela-jobs in one `wrangler dev` on fresh local D1/R2/queues → Playwright.
# Usage: apps/reader/e2e/run.sh [playwright args]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
READER="$ROOT/apps/reader"
LOGS="${E2E_LOG_DIR:-$ROOT/.e2e-logs}/reader"
STATE="$LOGS/state"
FIXTURE_PORT="${E2E_FIXTURE_PORT:-4790}"
PORT="${E2E_READER_PORT:-8811}"
INSPECTOR_PORT="${E2E_INSPECTOR_PORT:-9311}"
WRANGLER="$READER/node_modules/.bin/wrangler"
export E2E_FIXTURE_URL="http://127.0.0.1:${FIXTURE_PORT}"
export E2E_BASE_URL="http://127.0.0.1:${PORT}"
export E2E_STATE_FILE="$LOGS/member.json"
rm -rf "$STATE"
mkdir -p "$LOGS"
# A stack left running would answer the health check and every spec would test it instead.
for port in "$PORT" "$FIXTURE_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already in use; stop whatever holds it first" >&2; exit 1
  fi
done

# Each background service is started with `exec` inside its subshell, so the recorded pid is the
# real process and not a bash wrapper that would die and orphan it.
pids=()
cleanup() {
  for ((i = ${#pids[@]} - 1; i >= 0; i--)); do
    kill "${pids[$i]}" 2>/dev/null || true
  done
  lsof -t -i ":${PORT}" -i ":${FIXTURE_PORT}" 2>/dev/null | xargs kill 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

wait_for() { # url, seconds
  for _ in $(seq 1 "$2"); do curl -sf -m 5 "$1" >/dev/null 2>&1 && return 0; sleep 1; done
  echo "timeout waiting for $1" >&2; return 1
}

echo "▸ build tela-web"
(cd "$READER" && bunx vite build > "$LOGS/build.log" 2>&1) || { tail -40 "$LOGS/build.log"; exit 1; }

echo "▸ configs and database"
bun "$READER/e2e/stack.ts" "$LOGS" "$E2E_BASE_URL"
"$WRANGLER" d1 migrations apply tela --local --persist-to "$STATE" -c "$LOGS/api.wrangler.json" \
  > "$LOGS/migrate.log" 2>&1 || { cat "$LOGS/migrate.log"; exit 1; }

echo "▸ fixture server"
(exec bun "$READER/e2e/fixture-server.ts" "$FIXTURE_PORT" > "$LOGS/fixtures.log" 2>&1) &
pids+=($!)
wait_for "$E2E_FIXTURE_URL/pixel.png" 20

echo "▸ workers"
(exec "$WRANGLER" dev -c "$LOGS/web.wrangler.json" -c "$LOGS/api.wrangler.json" \
  -c "$LOGS/jobs.wrangler.json" --persist-to "$STATE" --ip 127.0.0.1 --port "$PORT" \
  --inspector-port "$INSPECTOR_PORT" --show-interactive-dev-session=false > "$LOGS/workers.log" 2>&1) &
pids+=($!)
wait_for "$E2E_BASE_URL/api/health" 90

echo "▸ playwright"
cd "$READER" && bunx playwright test "$@"
