# ADS Telegram Connector

ADS includes a standalone Telegram Channel Connector in `connectors/telegram/`. It runs outside ADS Core and communicates with Core over an authenticated WebSocket. Telegram turns enter Core as `channel: "telegram"` and therefore run through the same `MiddlewarePipeline`, memory recall, and safety rules as Web turns.

Core streams prompt output as `delta` frames followed by a `result` frame. Task lifecycle notifications use the transport-neutral `task_terminal` event; only the connector calls the Telegram API.

## Configuration and Startup

Configure Core and the connector separately. Core only needs the connector credential; Telegram credentials must be available only to the connector process.

```bash
# ADS Core environment
ADS_CONNECTOR_TOKEN="your-shared-core-token"
ADS_CONNECTOR_USER_ID="connector"

# Telegram Connector environment
TELEGRAM_BOT_TOKEN="1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ"
TELEGRAM_ALLOWED_USER_ID="123456789"
ADS_CORE_URL="http://127.0.0.1:8787"
ADS_CORE_WS_URL="ws://127.0.0.1:8787/ws"
ADS_CONNECTOR_TOKEN="your-shared-core-token"
```

Start the two processes independently:

```bash
# Start ADS Core
node dist/server/cli.js web

# Start the Telegram Connector
node connectors/telegram/bin/ads-telegram.js start
```

## Supported Interaction

| Command | Arguments | Behavior |
|---|---|---|
| `/start` | None | Confirms that the connector is available. |
| `/model` | None | Shows an inline keyboard of enabled models from the global ADS model registry. |
| `/model` | `<modelId> [reasoningEffort]` | Switches the current Telegram chat to the selected global model and optional reasoning effort. |
| `/status` | None | Shows the active model and reasoning effort for the current Telegram chat. |
| `/new` | None | Clears history for the current Telegram chat only. |
| `/stop` | None | Interrupts an active turn for the current Telegram chat only. |
| Text message | Any non-command text | Sends a `channel: "telegram"` prompt to ADS Core. |

Each Telegram chat uses an independent Core chat session. History, `/new`, and `/stop` actions are scoped to that chat and cannot affect another chat.

The `/model` list is read from ADS Core's global model configuration registry (`/api/models`). Model configuration is not workspace-scoped. A model selection is stored in the chat's Core session, so changing it in one Telegram chat does not change another chat's active model.

The connector receives Core `task_terminal` events. A scheduled task with an explicit Telegram `chatId` is delivered to that chat; `TELEGRAM_NOTIFICATION_CHAT_ID` is an optional fallback.

This connector version handles text messages only. Voice transcription, image and document attachments, workspace navigation, and session browsing are outside its scope.

## Security Boundaries

- The connector accepts only users listed in `TELEGRAM_ALLOWED_USER_ID` or `TELEGRAM_ALLOWED_USERS`.
- `TELEGRAM_*` variables and the Telegram API token belong only to the connector environment. ADS Core never reads them.
- `ADS_CONNECTOR_TOKEN` is a Core credential. Set the same high-entropy value on Core and the connector, and rotate it if exposed.
- Core `ALLOWED_DIRS` and sandbox mode limit the workspace access available to Connector-originated prompts.

## Connector Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Required | Telegram Bot API token. |
| `TELEGRAM_ALLOWED_USER_ID` | Required | Authorized Telegram numeric user ID. |
| `TELEGRAM_ALLOWED_USERS` | Unset | Comma-separated legacy alternative to the single user variable. |
| `ADS_CORE_URL` | `http://127.0.0.1:8787` | ADS Core HTTP address. |
| `ADS_CORE_WS_URL` | Derived from `ADS_CORE_URL` | ADS Core WebSocket endpoint. |
| `ADS_CONNECTOR_TOKEN` | Required | Bearer token shared with ADS Core. |
| `ADS_CONNECTOR_USER_ID` | `connector` | Connector logical user ID, configured by Core. |
| `TELEGRAM_NOTIFICATION_CHAT_ID` | Unset | Fallback target for `task_terminal` notifications. |
| `TELEGRAM_MAX_REQUESTS_PER_MINUTE` | `30` | Per-user request limit. |
| `TELEGRAM_PROXY_URL` | Unset | HTTP(S) proxy URL. |
| `TELEGRAM_SILENT_NOTIFICATIONS` | `true` | Sends replies and notifications silently when enabled. |
