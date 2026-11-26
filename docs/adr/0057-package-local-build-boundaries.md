# ADR 0057: Package-Local Build and Test Boundaries

## Status

Accepted - 2026-11-21.

## Context

ADR 0055 split the implementation source into `client/`, `rust-server/`, and
`ts-server/`, but npm manifests, TypeScript configuration, ESLint, generated
output, and build scripts still lived at the repository root. That left the
root as a second package boundary and allowed stale `dist/server`,
`dist/shared`, or root connector artifacts to leak into release assembly.

## Decision

- `client/` owns its npm manifest, lockfile, Vite configuration, client build
  output, Vitest configuration, ESLint configuration, browser fixtures, and
  client/browser verification scripts.
- `ts-server/` owns its npm manifest, lockfile, TypeScript configuration,
  ESLint configuration, server tests, build utility scripts, deploy and
  release verification scripts, and the TypeScript Telegram connector package.
- The repository root contains no npm manifest, lockfile, TypeScript/ESLint
  configuration, `node_modules/`, or generated `dist/`.
- The client emits to `client/dist/`; the TypeScript server emits to
  `ts-server/dist/`. Release archives ship those directories plus
  `ts-server/package.json` and `ts-server/package-lock.json`, never root build
  outputs.
- Cross-package source imports remain explicit relative imports. The client
  may consume type/contract modules from `ts-server/shared/`, while browser
  integration fixtures resolve compiled server modules from
  `ts-server/dist/`.
- CI installs, builds, lints, and tests each package from its own working
  directory. Release smoke tests install the packaged `ts-server` production
  dependencies and run `dist/server/cli.js version` from that package root.

## Consequences

Root commands are no longer the build interface. Contributors use
`npm --prefix client ...` and `npm --prefix ts-server ...`, or run the commands
from each package directory. This keeps dependencies and generated artifacts
owned by the implementation that produces them, makes clean-checkout release
verification deterministic, and prevents legacy root outputs from being
packaged accidentally.

The cost is that integration steps must explicitly cross package boundaries,
and CI must install two dependency graphs. Those boundaries are intentional:
the client and TypeScript server can be built and tested independently while
the server release remains self-contained.

## Verification

- A clean repository has no root `package.json`, `package-lock.json`,
  `tsconfig*.json`, `eslint.config.js`, `node_modules/`, or `dist/`.
- `client` and `ts-server` install from independent lockfiles and expose their
  own build, lint, and test commands.
- Release verification requires `client/dist/index.html`, the TypeScript server
  build, builtin skill assets, and server package metadata, while rejecting
  root package or build artifacts.
- Rust, TypeScript server, client, connector, browser, and conformance checks
  run from package-local paths.
