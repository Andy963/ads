#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.ads/run"
LOG_DIR="$ROOT/.ads/logs"
mkdir -p "$RUN_DIR" "$LOG_DIR"

declare -A CMDS=(
  [web]="node dist/src/web/server.js"
  [telegram]="node dist/src/telegram/bot.js"
  [mcp]="node dist/src/mcp/server.js"
)

declare -A ARTIFACTS=(
  [web]="dist/src/web/server.js"
  [telegram]="dist/src/telegram/bot.js"
  [mcp]="dist/src/mcp/server.js"
)

usage() {
  cat <<'EOF'
Usage: npm run services -- <start|stop|restart|status|list> [web|telegram|mcp|all]

Environment:
  ADS_WEB_HOST / ADS_WEB_PORT   Configure web server binding.
  TELEGRAM_*                    Telegram bot env vars as usual.

Examples:
  npm run services -- start web
  npm run services -- restart all
  npm run services -- status
EOF
}

is_running() {
  local svc="$1"
  local pid_file="$RUN_DIR/$svc.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null | tr -d '\n\r\t ' || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  return 1
}

start_service() {
  local svc="$1"
  local cmd="${CMDS[$svc]}"
  [[ -n "$cmd" ]] || { echo "Unknown service: $svc"; return 1; }

  if pid=$(is_running "$svc"); then
    echo "[$svc] already running (pid $pid)"
    return 0
  fi

  local artifact="${ARTIFACTS[$svc]:-}"
  if [[ "${ADS_SERVICES_AUTO_BUILD:-1}" != "0" ]]; then
    if [[ ! -d "$ROOT/dist" || ( -n "$artifact" && ! -f "$ROOT/$artifact" ) ]]; then
      echo "[$svc] build artifacts missing; building..."
      (cd "$ROOT" && npm run build)
    fi
  fi
  if [[ ! -d "$ROOT/dist" || ( -n "$artifact" && ! -f "$ROOT/$artifact" ) ]]; then
    echo "Build artifacts not found. Run: npm run build"
    return 1
  fi

  echo "[$svc] starting..."
  local log="$LOG_DIR/$svc.log"
  local pid_file="$RUN_DIR/$svc.pid"
  (
    cd "$ROOT"
    unlink "$pid_file" 2>/dev/null || true
    if command -v setsid >/dev/null 2>&1; then
      # Detach from the caller process group so the service survives non-interactive runners.
      setsid bash -c "exec $cmd" >"$log" 2>&1 < /dev/null &
    else
      nohup bash -c "exec $cmd" >"$log" 2>&1 < /dev/null &
    fi
    echo "$!" > "$pid_file"
  )

  local attempts=0
  while [[ $attempts -lt 30 ]]; do
    if pid=$(is_running "$svc"); then
      echo "[$svc] started (pid $pid), log: $log"
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.1
  done

  unlink "$pid_file" 2>/dev/null || true
  echo "[$svc] failed to start; see $log"
  return 1
}

stop_service() {
  local svc="$1"
  local pid_file="$RUN_DIR/$svc.pid"
  if ! pid=$(is_running "$svc"); then
    echo "[$svc] not running"
    unlink "$pid_file" 2>/dev/null || true
    return 0
  fi
  echo "[$svc] stopping pid $pid..."
  kill "$pid" 2>/dev/null || true
  sleep 0.5
  if kill -0 "$pid" 2>/dev/null; then
    echo "[$svc] did not exit, sending SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
  fi
  unlink "$pid_file" 2>/dev/null || true
  echo "[$svc] stopped"
}

status_service() {
  local svc="$1"
  if pid=$(is_running "$svc"); then
    echo "[$svc] running (pid $pid)"
  else
    echo "[$svc] stopped"
  fi
}

ACTION="${1:-}"
TARGET="${2:-all}"

if [[ -z "$ACTION" ]]; then
  usage
  exit 1
fi

SERVICES=()
if [[ "$TARGET" == "all" || -z "$TARGET" ]]; then
  SERVICES=(web telegram mcp)
else
  SERVICES=("$TARGET")
fi

case "$ACTION" in
  start)
    for svc in "${SERVICES[@]}"; do start_service "$svc"; done
    ;;
  stop)
    for svc in "${SERVICES[@]}"; do stop_service "$svc"; done
    ;;
  restart)
    for svc in "${SERVICES[@]}"; do stop_service "$svc"; start_service "$svc"; done
    ;;
  status|list)
    for svc in "${SERVICES[@]}"; do status_service "$svc"; done
    ;;
  *)
    usage
    exit 1
    ;;
esac
