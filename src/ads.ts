#!/usr/bin/env node

import "./utils/logSink.js";
import "./utils/env.js";

import { runInitAdminFromCli } from "./web/auth/initAdminCli.js";
import { runResetAdminFromCli } from "./web/auth/resetAdminCli.js";

function printLegacyHelp(): void {
  console.log("ADS CLI has been removed. Please use:");
  console.log("  - Web interface: node dist/src/web/server.js");
  console.log("  - Telegram bot: node dist/src/telegram/cli.js start");
  console.log("");
  console.log("Available CLI commands:");
  console.log("  - ads web init-admin --username <u> --password-stdin");
  console.log("  - ads web reset-admin --username <u> --password-stdin");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "web" && args[1] === "init-admin") {
    const exitCode = await runInitAdminFromCli(args.slice(2));
    process.exitCode = exitCode;
    return;
  }

  if (args[0] === "web" && args[1] === "reset-admin") {
    const exitCode = await runResetAdminFromCli(args.slice(2));
    process.exitCode = exitCode;
    return;
  }

  printLegacyHelp();
  process.exitCode = 1;
}

await main();
