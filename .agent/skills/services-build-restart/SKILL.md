---
name: services-build-restart
description: "Run build+restart via services.sh in a detached way so it survives self-restart."
---

# Services Build Restart
## Overview
This skill performs a "build restart" on the ADS repo by running `./services.sh` detached (so the caller can be killed by the restart without interrupting the operation).

## When to Use
- User asks to restart services.
- User asks for build+restart (deploy new dist artifacts) without file watchers.

## Safety / Rationale
- Running restart from inside the web server can kill the current process and drop the session.
- Therefore, always start the operation detached (`nohup` or `setsid`) and write logs to `.ads/logs/`.

## Commands
### Build + restart (default: all)
- Prefer this for "build restart":
  - `cd /home/andy/ads && mkdir -p .ads/logs && nohup ./services.sh > .ads/logs/build-restart.log 2>&1 < /dev/null &`

### Restart only (no build)
- If user explicitly wants restart without build:
  - `cd /home/andy/ads && mkdir -p .ads/logs && nohup ./services.sh restart all > .ads/logs/restart.log 2>&1 < /dev/null &`

### Check status
- `cd /home/andy/ads && ./services.sh status all`

## Notes
- On success, the command returns immediately; inspect logs if needed:
  - `.ads/logs/build-restart.log`
  - `.ads/logs/web.log`
  - `.ads/logs/telegram.log`
