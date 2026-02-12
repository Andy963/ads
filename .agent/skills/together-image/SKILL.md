---
name: together-image
description: "Generate raster images via Together API with optional Telegram delivery."
---

# Together Image

## Overview
This skill generates **raster images** using Together's Images API and returns base64 output by default.

It can also **send the generated image to Telegram** via Bot API when explicitly requested.

## Requirements
- Node.js available (`node`)
- Environment variables:
  - `TOGETHER_API_KEY` (required)
  - Optional: `ADS_TOGETHER_IMAGE_TIMEOUT_MS` (default: `120000`)
  - Telegram delivery (optional):
    - `TELEGRAM_BOT_TOKEN`
    - `TELEGRAM_ALLOWED_USERS` (must contain exactly one numeric user id; used as `chat_id`)

## Script
- `.agent/skills/together-image/scripts/together-image.cjs`

## How to use (agent behavior)
When the user asks to generate an image (e.g. "生成图片", "画图", "generate image"):
1) Generate an image from a user-provided prompt:
   - `node .agent/skills/together-image/scripts/together-image.cjs --prompt "Cats eating popcorn"`
2) If the user wants a file:
   - `node .agent/skills/together-image/scripts/together-image.cjs --prompt "..." --out /tmp/out.png`
3) If the user is chatting via Telegram, prefer Telegram delivery (avoid printing base64):
   - `node .agent/skills/together-image/scripts/together-image.cjs --prompt "..." --tg --stdout none`
   - Chat routing:
     - Uses `--tg-chat-id` when provided
     - Else uses `ADS_TELEGRAM_CHAT_ID` when present (Telegram adapter injects this per-request)
     - Else falls back to `TELEGRAM_ALLOWED_USERS` when it contains exactly one user id
4) If the user explicitly wants base64 output (e.g. for embedding), use stdout base64:
   - `node .agent/skills/together-image/scripts/together-image.cjs --prompt "..." --stdout base64`

## Output discipline
- stdout (default): base64 string only (single line)
- stdout (when `--stdout none`): empty
- stderr: diagnostics/errors only
- Never print API keys.
