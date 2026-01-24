#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT/.ads/run/web.pid"

was_running=0
if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    was_running=1
  fi
fi

cd "$ROOT"
npm run build >/dev/null
npm run web:bg >/dev/null

cleanup() {
  if [[ "$was_running" -eq 0 ]]; then
    npm run web:stop >/dev/null || true
  fi
}
trap cleanup EXIT

echo "[dev:console] backend: http://localhost:8787  (logs: .ads/logs/web.log)"
echo "[dev:console] frontend: http://localhost:5173  (proxy -> :8787)"
npm run dev:web

