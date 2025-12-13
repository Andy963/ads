import "./utils/logSink.js";

import { Codex } from "@openai/codex-sdk";

import {
  resolveCodexConfig,
  maskKey,
  type CodexOverrides,
} from "./codexConfig.js";

const writeStdout = (text: string): void => {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
};

const writeStderr = (text: string): void => {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
};

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
    writeStderr(
      `[codex-ping] Failed to resolve Codex configuration: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
    return;
  }

  const baseUrlLabel = config.baseUrl ?? "(Codex default)";
  writeStdout(`[codex-ping] Using base URL: ${baseUrlLabel}`);
  if (config.authMode === "apiKey") {
    writeStdout(`[codex-ping] Using API key: ${maskKey(config.apiKey)}`);
  } else {
    writeStdout("[codex-ping] Using device-auth tokens from ~/.codex/auth.json");
  }
  writeStdout(`[codex-ping] Prompt: ${prompt}`);

  const codex = new Codex({
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  });

  try {
    const thread = codex.startThread({
      skipGitRepoCheck: true,
    });
    const turn = await thread.run(prompt);
    writeStdout("[codex-ping] finalResponse:");
    writeStdout(turn.finalResponse);
    if (turn.items?.length) {
      writeStdout("[codex-ping] items:");
      for (const item of turn.items) {
        writeStdout(JSON.stringify(item, null, 2));
      }
    }
  } catch (error) {
    writeStderr(`[codex-ping] Request failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  writeStderr(`[codex-ping] Unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
