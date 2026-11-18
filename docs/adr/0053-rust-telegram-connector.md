# ADR 0053: Run the Telegram Connector as a Rust Core Client

## Status

Accepted

## Context

The Telegram connector was extracted from ADS Core into a standalone Node
process. That boundary is correct: Core owns sessions, providers, prompt queues,
history, and Actions; the connector owns Telegram transport and presentation.
The Rust backend migration nevertheless left the connector on Node, so two
implementations of the same Core WebSocket contract had to stay in sync.

The connector also exposed a provider-routing requirement in the Rust Core.
ADS model configuration IDs are not Codex model names. A selected model must be
resolved to its agent `model_id`, and its provider must be injected as Codex
app-server configuration before `thread/start` or `turn/start`.

## Decision

- Add `ads-telegram` as a Rust workspace binary and keep Telegram as an
  independent connector outside ADS Core.
- Preserve the existing Core contract: one WebSocket per Telegram chat with
  `ads-session.telegram` and `ads-chat.chat-<id>`, plus a separate
  `telegram-notifications` connection for `task_terminal` events.
- Keep commands and delivery behavior compatible: `/start`, `/new`, `/stop`,
  `/model`, `/status`, inline model selection, authorization, rate limiting,
  typing status, MarkdownV2 delivery with plain-text fallback, and idle/max
  duration notices.
- Keep the Node connector artifacts and service backup available during rollout
  so the deployment can be reverted without changing the Core database or
  protocol.
- Resolve ADS model configuration IDs in Rust Core before invoking Codex. The
  actual agent model ID goes into thread/turn parameters; provider name, base
  URL, wire API, provider slug, and decrypted API key go into app-server global
  arguments and child-process environment respectively.

## Consequences

The connector and Core can now be built and tested in one Rust workspace, while
the WebSocket and REST boundary remains the compatibility contract. A fake
Telegram API plus fake Core WebSocket covers prompt delivery, per-chat protocol
identity, model menus, status cleanup, idle notices, and maximum-duration
failure without requiring a live bot.

The MarkdownV2 renderer intentionally handles a conservative subset: fenced
code and inline code are preserved, while other Markdown syntax is escaped.
Telegram delivery falls back to plain text when MarkdownV2 parsing fails.

Production rollback remains a service-entry change from the Rust binary back to
the preserved Node connector binary. It does not require a database rollback
because both connectors use the same Core APIs and per-chat identities.
