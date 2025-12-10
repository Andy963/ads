import "./utils/logSink.js";

import { Codex } from "@openai/codex-sdk";

import {
  resolveCodexConfig,
  maskKey,
  type CodexOverrides,
} from "./codexConfig.js";

function parseArgs(): {
  prompt: string;
  overrides: CodexOverrides;
} {
  const args = process.argv.slice(2);
  const overrides: CodexOverrides = {};
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--base-url" && i + 1 < args.length) {
      overrides.baseUrl = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--base-url=")) {
      overrides.baseUrl = arg.slice("--base-url=".length);
      continue;
    }
    if (arg === "--api-key" && i + 1 < args.length) {
      overrides.apiKey = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--api-key=")) {
      overrides.apiKey = arg.slice("--api-key=".length);
      continue;
    }
    remaining.push(arg);
  }

  const prompt =
    remaining.join(" ").trim() ||
    "Ping: please respond with a short confirmation that Codex is reachable.";

  return { prompt, overrides };
}

async function main(): Promise<void> {
  const { prompt, overrides } = parseArgs();

  let config;
  try {
    config = resolveCodexConfig(overrides);
  } catch (error) {
    console.error(
      "[codex-ping] Failed to resolve Codex configuration:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
    return;
  }

  const baseUrlLabel = config.baseUrl ?? "(Codex default)";
  console.log(`[codex-ping] Using base URL: ${baseUrlLabel}`);
  if (config.authMode === "apiKey") {
    console.log(`[codex-ping] Using API key: ${maskKey(config.apiKey)}`);
  } else {
    console.log("[codex-ping] Using device-auth tokens from ~/.codex/auth.json");
  }
  console.log(`[codex-ping] Prompt: ${prompt}`);

  const codex = new Codex({
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  });

  try {
    const thread = codex.startThread({
      skipGitRepoCheck: true,
    });
    const turn = await thread.run(prompt);
    console.log("[codex-ping] finalResponse:");
    console.log(turn.finalResponse);
    if (turn.items?.length) {
      console.log("[codex-ping] items:");
      for (const item of turn.items) {
        console.log(JSON.stringify(item, null, 2));
      }
    }
  } catch (error) {
    console.error(
      "[codex-ping] Request failed:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("[codex-ping] Unexpected failure:", error);
  process.exitCode = 1;
});
