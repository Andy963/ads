#!/bin/sh
set -eu

exec sudo -n /usr/bin/bwrap "$@"
