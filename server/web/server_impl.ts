import "../utils/env.js";
import "../utils/logSink.js";

import { closeAllStateDatabases } from "../state/database.js";
import { closeAllWorkspaceDatabases } from "../storage/database.js";
import { createLogger } from "../utils/logger.js";
import { startWebServer } from "./server/startWebServer.js";

const logger = createLogger("WebSocket");

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", error);
  try {
    closeAllWorkspaceDatabases();
  } catch {
    // ignore
  }
  try {
    closeAllStateDatabases();
  } catch {
    // ignore
  }
  process.exit(1);
});

startWebServer().catch((error) => {
  logger.error("[web] fatal error", error);
  try {
    closeAllWorkspaceDatabases();
  } catch {
    // ignore
  }
  try {
    closeAllStateDatabases();
  } catch {
    // ignore
  }
  process.exit(1);
});
