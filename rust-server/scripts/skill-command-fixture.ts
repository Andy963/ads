/**
 * Line-oriented fixture that exposes the TypeScript command router to the Rust
 * skill conformance script. Each input line is echoed as one JSON result line.
 */
import readline from "node:readline";

import { runAdsCommandLine } from "../../ts-server/server/web/commandRouter.js";

const workspaceRoot = process.argv[2] ?? process.cwd();

const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim()) continue;
  let result: { ok: boolean; output: string };
  try {
    result = await runAdsCommandLine(line, { workspaceRoot });
  } catch (error) {
    result = {
      ok: false,
      output: error instanceof Error ? error.message : String(error),
    };
  }
  console.log(JSON.stringify(result));
}
