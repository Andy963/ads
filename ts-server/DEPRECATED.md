# DEPRECATED: ADS TypeScript Server (`ts-server`)

> **Status: DEPRECATED & ARCHIVED**
>
> This branch (`archive/ts-server-deprecated`) preserves the final frozen snapshot of the legacy TypeScript backend (`ts-server/`, branched from `dev` at `b77f0cb9`) for historical reference only.

## Replacement

All active backend development, maintenance, releases, and production deployments have moved exclusively to `rust-server/` on the `dev` branch:

- Core Web & WebSocket server: `rust-server/crates/ads-server` (`ads-server`)
- Telegram connector: `rust-server/crates/ads-telegram` (`ads-telegram`)
- Shared Web Console client: `client/`

Do not open new feature PRs or bug fixes against `ts-server/` or this archive branch.

