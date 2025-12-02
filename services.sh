#!/usr/bin/env bash
# Wrapper to invoke the service manager in scripts/services.sh
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/scripts/services.sh" "$@"
