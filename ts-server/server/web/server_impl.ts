import "../utils/env.js";
import "../utils/logSink.js";

import { createLogger } from "../utils/logger.js";
import { createGracefulCleanup } from "../utils/shutdown.js";
import { startWebServer } from "./server/startWebServer.js";

const logger = createLogger("WebSocket");
const cleanup = createGracefulCleanup({ logger });

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  cleanup.crash("Uncaught exception", error);
});

startWebServer().catch((error) => {
  cleanup.crash("[web] fatal error", error);
});
