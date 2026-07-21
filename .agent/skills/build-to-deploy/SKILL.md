---
name: build-to-deploy
description: "Build, validate, deploy, and health-check ADS safely. Use when asked to compile, build, redeploy, restart, publish a local release, or troubleshoot an interrupted ADS deployment."
version: 1
provides: [ads.deploy.local]
priority: 300
platforms: [linux]
required_env: []
triggers:
  keywords: [build, compile, deploy, redeploy, deployment, 构建, 编译, 部署, 重新部署]
  intents: [build ADS, deploy ADS, build and deploy ADS, redeploy ADS locally, troubleshoot ADS deployment]
entrypoints: []
---

# ADS Build to Deploy

## Purpose

Build and deploy ADS through its repository-native scripts, preserve the current working tree and state database, survive service restarts, and verify that the new release is actually serving the web UI.

## Safety Rules

- Run from the ADS repository root containing `package.json` and `scripts/deploy-local.js`.
- Treat all tracked and untracked working-tree files as user-owned. Never clean, reset, overwrite, or delete them.
- Never delete `$ADS_STATE_DIR`, SQLite databases, runtime releases, or staging directories as part of routine deployment.
- Do not commit or push unless the user explicitly requests it.
- Do not manually switch `~/.local/share/ads-runtime/current`; let `scripts/deploy-local.js` perform the atomic switch and rollback.
- Allow enough time for build, dependency installation, service restart, and health checks. Do not cancel deployment merely because the web connection temporarily drops.

## Workflow

### 1. Preflight

Confirm the repository and capture the current state:

```bash
pwd
git status --short
systemctl --user is-active ads-web ads-tg
readlink -f "$HOME/.local/share/ads-runtime/current"
```

Check for an existing deployment before starting another:

```bash
systemctl --user list-units --all --no-pager 'ads-deploy-*'
ps -ef | rg '[d]eploy-local|[n]pm run deploy:local'
```

If an `ads-deploy-*` unit is active, do not start a competing deployment. Follow it with:

```bash
journalctl --user -fu <ads-deploy-unit>
```

### 2. Validate

Use the repository validators. For a normal full release, run:

```bash
npm test
npm run test:web
npm run lint
```

All validators must pass before deployment. If a failure is caused by current source changes, fix it and rerun the failing validator. Do not deploy with failures unless the user explicitly approves skipping them.

### 3. Build

Run the canonical full build:

```bash
npm run build
```

The build must complete successfully. It compiles server TypeScript, copies runtime templates and project skills, and builds the web client.

Confirm this skill was packaged:

```bash
test -f dist/.agent/skills/build-to-deploy/SKILL.md
```

### 4. Deploy

Run the canonical local deploy command with a generous timeout:

```bash
npm run deploy:local
```

The deploy script intentionally builds again, assembles an immutable release, installs production dependencies, validates the CLI, stops services, atomically switches `current`, restarts services, and rolls back on handled failures.

When deployment is invoked from inside `ads-web` or `ads-tg`, the script delegates itself to an independent transient systemd unit before stopping ADS. The initiating web session may disconnect, but deployment continues.

If output contains:

```text
Deployment delegated to ads-deploy-<id>.service
```

do not report success yet. Wait for the detached unit and inspect its result:

```bash
systemctl --user status ads-deploy-<id>.service --no-pager --full
journalctl --user -u ads-deploy-<id>.service --no-pager
```

Success requires the journal to contain both `ADS deployed to ...` and `Current runtime: ...`, with the transient unit exiting successfully.

### 5. Verify

Verify both services, the selected release, health endpoint, and homepage:

```bash
systemctl --user is-active ads-web ads-tg
readlink -f "$HOME/.local/share/ads-runtime/current"
curl -fsS --max-time 10 http://127.0.0.1:8787/healthz
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 http://127.0.0.1:8787/
```

Expected:

- `ads-web`: `active`
- `ads-tg`: `active`
- `/healthz`: `ok`
- Homepage GET: `200`

Use GET for the homepage check. A HEAD request may return `404` even when the page is available.

Inspect recent restart logs:

```bash
journalctl --user -u ads-web -u ads-tg --since '10 minutes ago' --no-pager
```

Report the resolved release directory and verification results.

## Interrupted Deployment Recovery

If `ads-web` is inactive:

1. Check whether an `ads-deploy-*` unit or deploy process is still running.
2. If deployment is active, wait and inspect its journal. Do not interfere.
3. If no deployment is active, inspect the current release and recent logs:

```bash
readlink -f "$HOME/.local/share/ads-runtime/current"
journalctl --user -u ads-web -n 120 --no-pager
```

4. If `current` points to an existing release, restore service availability:

```bash
systemctl --user start ads-web
```

5. Verify `/healthz` and the homepage with GET.
6. Rerun `npm run deploy:local` only after the service is restored and no other deployment is active.

Do not remove incomplete releases or staging directories unless the user explicitly requests cleanup and their ownership and safety have been verified.
