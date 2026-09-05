#!/usr/bin/env node

let createTelegramBot;
try {
  ({ createTelegramBot } = await import("../dist/src/bot.js"));
} catch {
  ({ createTelegramBot } = await import("../src/bot.js"));
}

const command = (process.argv[2] ?? "start").trim().toLowerCase();

if (command === "help" || command === "--help" || command === "-h") {
  console.log(`
ADS Telegram Connector

Usage:
  ads-telegram [command]

Commands:
  start         Start the Telegram connector bot (default)
  help          Show this help message
  version       Show version information

Environment:
  TELEGRAM_BOT_TOKEN          Your Telegram bot token (required)
  TELEGRAM_ALLOWED_USER_ID    Allowed user ID (required)
  ADS_CORE_URL                ADS Core base URL (default: http://127.0.0.1:8787)
  ADS_CORE_WS_URL             ADS Core WebSocket URL (default: ws://127.0.0.1:3000/ws)
  ADS_CONNECTOR_TOKEN         API token for ADS Core authentication
`);
  process.exit(0);
}

if (command === "version" || command === "--version" || command === "-v") {
  console.log("ADS Telegram Connector v0.1.0");
  process.exit(0);
}

if (command === "start" || command === "run") {
  console.log("Starting ADS Telegram Connector...");
  try {
    const instance = createTelegramBot();
    await instance.start();
  } catch (error) {
    console.error(`Failed to start Telegram connector: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${command}. Run 'ads-telegram help' for usage.`);
  process.exit(2);
}
