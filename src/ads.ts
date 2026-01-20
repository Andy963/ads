#!/usr/bin/env node

import "./utils/logSink.js";
import "./utils/env.js";

// CLI support removed - use web or telegram interface
console.log("ADS CLI has been removed. Please use:");
console.log("  - Web interface: node dist/src/web/server.js");
console.log("  - Telegram bot: node dist/src/telegram/cli.js start");
