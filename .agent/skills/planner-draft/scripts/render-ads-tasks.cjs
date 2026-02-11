"use strict";

const fs = require("node:fs");

function printUsage() {
  process.stderr.write(`Usage:
  node .agent/skills/planner-draft/scripts/render-ads-tasks.cjs [options]

Options:
  --title <text>                 Task title (optional)
  --prompt <text>                Prompt text (optional; prefer --prompt-file or stdin)
  --prompt-file <path>           Read prompt text from file (UTF-8)
  --request-id <id>              Optional TaskBundle requestId
  --insert-position <front|back> Default: back
  --inherit-context <true|false> Default: true
  --decode-escapes <auto|always|never> Default: auto
  -h, --help                     Show this help

Examples:
  node .agent/skills/planner-draft/scripts/render-ads-tasks.cjs --title "My task" --prompt-file ./example.txt
  cat ./example.txt | node .agent/skills/planner-draft/scripts/render-ads-tasks.cjs --title "My task"
`);
}

function normalizeBoolean(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") return true;
  if (raw === "false" || raw === "0" || raw === "no") return false;
  return null;
}

function normalizeDecodeMode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "auto" || raw === "always" || raw === "never") return raw;
  return null;
}

function parseArgs(argv) {
  const args = {
    title: null,
    prompt: null,
    promptFile: null,
    requestId: null,
    insertPosition: "back",
    inheritContext: true,
    decodeEscapes: "auto",
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "-h" || token === "--help") {
      args.help = true;
      continue;
    }

    const [flag, inlineValue] = token.includes("=") ? token.split("=", 2) : [token, null];
    const nextValue = inlineValue ?? argv[i + 1] ?? null;
    const consumeValue = inlineValue == null;

    if (flag === "--title") {
      if (nextValue == null) throw new Error("--title requires a value");
      args.title = String(nextValue);
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--prompt") {
      if (nextValue == null) throw new Error("--prompt requires a value");
      args.prompt = String(nextValue);
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--prompt-file") {
      if (nextValue == null) throw new Error("--prompt-file requires a value");
      args.promptFile = String(nextValue);
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--request-id") {
      if (nextValue == null) throw new Error("--request-id requires a value");
      args.requestId = String(nextValue);
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--insert-position") {
      if (nextValue == null) throw new Error("--insert-position requires a value");
      const value = String(nextValue).trim().toLowerCase();
      if (value !== "front" && value !== "back") {
        throw new Error("--insert-position must be front|back");
      }
      args.insertPosition = value;
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--inherit-context") {
      if (nextValue == null) throw new Error("--inherit-context requires a value");
      const parsed = normalizeBoolean(nextValue);
      if (parsed == null) throw new Error("--inherit-context must be true|false");
      args.inheritContext = parsed;
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--decode-escapes") {
      if (nextValue == null) throw new Error("--decode-escapes requires a value");
      const parsed = normalizeDecodeMode(nextValue);
      if (parsed == null) throw new Error("--decode-escapes must be auto|always|never");
      args.decodeEscapes = parsed;
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--no-decode-escapes") {
      args.decodeEscapes = "never";
      continue;
    }

    if (flag === "--decode-escapes-always") {
      args.decodeEscapes = "always";
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function normalizeNewlines(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function decodeCommonEscapes(text) {
  return String(text).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
}

function normalizePromptText(promptText, decodeMode) {
  const raw = String(promptText ?? "");
  const hasRealNewline = raw.includes("\n") || raw.includes("\r");
  const hasEscapedNewline = raw.includes("\\n") || raw.includes("\\r") || raw.includes("\\t");

  let normalized = raw;
  if (decodeMode === "always") {
    normalized = decodeCommonEscapes(normalized);
  } else if (decodeMode === "auto") {
    if (!hasRealNewline && hasEscapedNewline) {
      normalized = decodeCommonEscapes(normalized);
    }
  }

  return normalizeNewlines(normalized);
}

function readFileUtf8(path) {
  return fs.readFileSync(path, { encoding: "utf8" });
}

function readStdinUtf8() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", (err) => reject(err));
  });
}

function buildTaskBundleJson(args, promptText) {
  const bundle = {
    version: 1,
    requestId: args.requestId || undefined,
    insertPosition: args.insertPosition,
    tasks: [
      {
        externalId: undefined,
        title: args.title || undefined,
        prompt: promptText,
        inheritContext: args.inheritContext,
      },
    ],
  };

  return JSON.stringify(bundle, null, 2);
}

function validateTaskBundleJson(jsonText) {
  const parsed = JSON.parse(jsonText);
  if (parsed?.version !== 1) throw new Error("Internal validation failed: version");
  if (!Array.isArray(parsed?.tasks) || parsed.tasks.length < 1) throw new Error("Internal validation failed: tasks");
  if (typeof parsed.tasks[0]?.prompt !== "string" || !parsed.tasks[0].prompt.trim()) {
    throw new Error("Internal validation failed: prompt");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const inputText =
    args.promptFile != null
      ? readFileUtf8(args.promptFile)
      : args.prompt != null
        ? args.prompt
        : await readStdinUtf8();

  if (!String(inputText ?? "").trim()) {
    throw new Error("Prompt is required (use --prompt-file or stdin)");
  }

  const promptText = normalizePromptText(inputText, args.decodeEscapes);
  const jsonText = buildTaskBundleJson(args, promptText);
  validateTaskBundleJson(jsonText);

  process.stdout.write("```ads-tasks\n");
  process.stdout.write(jsonText);
  process.stdout.write("\n```\n");
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

