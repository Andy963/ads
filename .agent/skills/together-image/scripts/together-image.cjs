"use strict";

const fs = require("node:fs");
const path = require("node:path");

try {
  // Optional: load local .env for convenience in development.
  // eslint-disable-next-line global-require
  require("dotenv").config();
} catch {
  // ignore
}

function printUsage() {
  process.stderr.write(`Usage:
  node .agent/skills/together-image/scripts/together-image.cjs [options]

Options:
  --prompt <text>                 Prompt text (optional if provided via stdin)
  --model <id>                    Default: Qwen/Qwen-Image
  --size <WxH>                    Example: 1024x1024
  --width <n>                     Width in pixels (overrides --size width)
  --height <n>                    Height in pixels (overrides --size height)
  --steps <n>                     Optional
  --seed <n>                      Optional
  --n <n>                         Number of images (default: 1)
  --response-format <b64_json|url> Default: b64_json
  --timeout-ms <n>                Overrides ADS_TOGETHER_IMAGE_TIMEOUT_MS (default: 120000)
  --out <path>                    Optional output file path (writes decoded bytes)
  --stdout <base64|none>          Default: base64 (auto-switches to none when --tg is set)
  --tg                            Send the image to Telegram (requires TELEGRAM_BOT_TOKEN; chat_id via --tg-chat-id, ADS_TELEGRAM_CHAT_ID, or TELEGRAM_ALLOWED_USERS)
  --tg-chat-id <id>               Telegram chat_id override (recommended for multi-user bots)
  --tg-mode <photo|document>      Default: photo
  --tg-caption <text>             Optional caption
  -h, --help                      Show this help

Examples:
  node .agent/skills/together-image/scripts/together-image.cjs --prompt "Cats eating popcorn"
  node .agent/skills/together-image/scripts/together-image.cjs --prompt "..." --out /tmp/out.png
  node .agent/skills/together-image/scripts/together-image.cjs --prompt "..." --tg --stdout none
  node .agent/skills/together-image/scripts/together-image.cjs --prompt "..." --tg --tg-chat-id 123 --stdout none
`);
}

function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function parseSize(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return { width: null, height: null };
  const match = raw.match(/^(\d+)\s*x\s*(\d+)$/);
  if (!match) return { width: null, height: null };
  const width = toInt(match[1]);
  const height = toInt(match[2]);
  return { width: width != null && width > 0 ? width : null, height: height != null && height > 0 ? height : null };
}

function resolveTimeoutMs(cliOverride) {
  const fromCli = toInt(cliOverride);
  if (fromCli != null) return Math.max(1000, fromCli);
  const fromEnv = toInt(process.env.ADS_TOGETHER_IMAGE_TIMEOUT_MS ?? 120000);
  return fromEnv != null ? Math.max(1000, fromEnv) : 120000;
}

function parseArgs(argv) {
  const args = {
    prompt: null,
    model: "Qwen/Qwen-Image",
    width: null,
    height: null,
    steps: null,
    seed: null,
    n: 1,
    responseFormat: "b64_json",
    timeoutMs: null,
    outPath: null,
    stdoutMode: "base64",
    telegramEnabled: false,
    telegramMode: "photo",
    telegramChatId: null,
    telegramCaption: null,
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

    if (flag === "--prompt") {
      if (nextValue == null) throw new Error("--prompt requires a value");
      args.prompt = String(nextValue);
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--model") {
      if (nextValue == null) throw new Error("--model requires a value");
      args.model = String(nextValue).trim() || args.model;
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--size") {
      if (nextValue == null) throw new Error("--size requires a value");
      const parsed = parseSize(nextValue);
      if (parsed.width != null) args.width = parsed.width;
      if (parsed.height != null) args.height = parsed.height;
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--width") {
      if (nextValue == null) throw new Error("--width requires a value");
      const parsed = toInt(nextValue);
      if (parsed == null || parsed <= 0) throw new Error("--width must be a positive integer");
      args.width = parsed;
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--height") {
      if (nextValue == null) throw new Error("--height requires a value");
      const parsed = toInt(nextValue);
      if (parsed == null || parsed <= 0) throw new Error("--height must be a positive integer");
      args.height = parsed;
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--steps") {
      if (nextValue == null) throw new Error("--steps requires a value");
      const parsed = toInt(nextValue);
      if (parsed == null || parsed <= 0) throw new Error("--steps must be a positive integer");
      args.steps = parsed;
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--seed") {
      if (nextValue == null) throw new Error("--seed requires a value");
      const parsed = toInt(nextValue);
      if (parsed == null) throw new Error("--seed must be an integer");
      args.seed = parsed;
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--n") {
      if (nextValue == null) throw new Error("--n requires a value");
      const parsed = toInt(nextValue);
      if (parsed == null || parsed <= 0) throw new Error("--n must be a positive integer");
      args.n = parsed;
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--response-format") {
      if (nextValue == null) throw new Error("--response-format requires a value");
      const value = String(nextValue).trim().toLowerCase();
      if (value !== "b64_json" && value !== "url") {
        throw new Error("--response-format must be b64_json|url");
      }
      args.responseFormat = value;
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--timeout-ms") {
      if (nextValue == null) throw new Error("--timeout-ms requires a value");
      args.timeoutMs = String(nextValue);
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--out") {
      if (nextValue == null) throw new Error("--out requires a value");
      args.outPath = String(nextValue);
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--stdout") {
      if (nextValue == null) throw new Error("--stdout requires a value");
      const value = String(nextValue).trim().toLowerCase();
      if (value !== "base64" && value !== "none") {
        throw new Error("--stdout must be base64|none");
      }
      args.stdoutMode = value;
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--tg") {
      args.telegramEnabled = true;
      continue;
    }

    if (flag === "--tg-chat-id") {
      if (nextValue == null) throw new Error("--tg-chat-id requires a value");
      const value = String(nextValue).trim();
      const num = Number(value);
      if (!Number.isSafeInteger(num) || num === 0) {
        throw new Error("--tg-chat-id must be a non-zero integer");
      }
      args.telegramChatId = String(num);
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--tg-mode") {
      if (nextValue == null) throw new Error("--tg-mode requires a value");
      const value = String(nextValue).trim().toLowerCase();
      if (value !== "photo" && value !== "document") {
        throw new Error("--tg-mode must be photo|document");
      }
      args.telegramMode = value;
      if (consumeValue) i += 1;
      continue;
    }

    if (flag === "--tg-caption") {
      if (nextValue == null) throw new Error("--tg-caption requires a value");
      args.telegramCaption = String(nextValue);
      if (consumeValue) i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function normalizeNewlines(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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

function parseJsonText(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function extractUpstreamErrorMessage(parsed, raw, status) {
  const record = parsed && typeof parsed === "object" ? parsed : null;
  const errorObj =
    record && typeof record.error === "object" && record.error != null ? record.error : record && typeof record.error === "string" ? null : null;
  const nestedMessage = errorObj && typeof errorObj.message === "string" ? errorObj.message : null;
  const directMessage = record && typeof record.message === "string" ? record.message : null;
  const fallback = String(raw ?? "").trim();
  return String(nestedMessage ?? directMessage ?? fallback ?? "").trim() || `Upstream error (${status})`;
}

async function fetchAsBase64(url, signal) {
  const res = await fetch(url, { method: "GET", signal });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw new Error(`Failed to download image url: status=${res.status} ${raw ? `body=${raw.slice(0, 200)}` : ""}`.trim());
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab).toString("base64");
}

function normalizeEnvValue(value) {
  return String(value ?? "").trim();
}

function parseSingleTelegramAllowedUserId(raw) {
  const ids = String(raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length !== 1) {
    return null;
  }
  const num = Number(ids[0]);
  if (!Number.isSafeInteger(num) || num <= 0) {
    return null;
  }
  return String(num);
}

function parseTelegramChatIdOverride(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num === 0) return "";
  return String(num);
}

function resolveTelegramConfigFromEnv(options) {
  const overrideChatId = parseTelegramChatIdOverride(options?.chatId);
  const botToken = normalizeEnvValue(process.env.TELEGRAM_BOT_TOKEN);
  const envChatId = parseTelegramChatIdOverride(process.env.ADS_TELEGRAM_CHAT_ID);
  const allowedUsers = normalizeEnvValue(process.env.TELEGRAM_ALLOWED_USERS);
  const allowedChatId = parseSingleTelegramAllowedUserId(allowedUsers) ?? "";
  const chatId = overrideChatId || envChatId || allowedChatId;
  return { botToken, chatId, ok: Boolean(botToken && chatId), hasAllowedUsersSingle: Boolean(allowedChatId) };
}

function inferFilenameFromOutPath(outPath) {
  const ext = typeof outPath === "string" ? path.extname(outPath).toLowerCase() : "";
  if (ext === ".jpg" || ext === ".jpeg") return "image.jpg";
  if (ext === ".webp") return "image.webp";
  if (ext === ".png") return "image.png";
  return "image.png";
}

async function sendImageToTelegram(args) {
  const { botToken, chatId, mode, caption, bytes, filename } = args;
  const method = mode === "document" ? "sendDocument" : "sendPhoto";
  const url = `https://api.telegram.org/bot${botToken}/${method}`;

  const form = new FormData();
  form.append("chat_id", chatId);
  if (typeof caption === "string" && caption.trim()) {
    form.append("caption", caption);
  }

  const field = mode === "document" ? "document" : "photo";
  const blob = new Blob([bytes], { type: "image/png" });
  form.append(field, blob, filename);

  let res;
  try {
    res = await fetch(url, { method: "POST", body: form });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Telegram fetch failed: ${message}`);
  }

  const raw = await res.text().catch(() => "");
  const parsed = parseJsonText(raw);
  const okFlag = parsed && typeof parsed === "object" && parsed != null ? parsed.ok === true : false;
  if (res.ok && okFlag) {
    return;
  }

  const description =
    parsed && typeof parsed === "object" && parsed != null && typeof parsed.description === "string" ? parsed.description : "";
  const errorCode =
    parsed && typeof parsed === "object" && parsed != null && typeof parsed.error_code === "number" ? parsed.error_code : res.status;
  const hint = description ? ` ${description}` : "";
  throw new Error(`Telegram API error: ${errorCode}${hint}`.trim());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exitCode = 0;
    return;
  }

  const apiKey = String(process.env.TOGETHER_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("Missing TOGETHER_API_KEY");
  }

  let prompt = args.prompt;
  if (!prompt) {
    if (process.stdin.isTTY) {
      throw new Error("Missing --prompt (or provide prompt via stdin)");
    }
    const stdin = normalizeNewlines(await readStdinUtf8());
    prompt = stdin.trim();
  }
  if (!prompt) {
    throw new Error("Prompt is empty");
  }

  const timeoutMs = resolveTimeoutMs(args.timeoutMs);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const stdoutMode = (() => {
      if (args.telegramEnabled && args.stdoutMode === "base64") {
        return "none";
      }
      return args.stdoutMode;
    })();

    const body = {
      model: args.model,
      prompt,
      n: args.n,
      response_format: args.responseFormat,
      width: args.width ?? undefined,
      height: args.height ?? undefined,
      steps: args.steps ?? undefined,
      seed: args.seed ?? undefined,
    };

    const upstream = await fetch("https://api.together.xyz/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await upstream.text().catch(() => "");
    const parsed = parseJsonText(raw);
    if (!upstream.ok) {
      throw new Error(extractUpstreamErrorMessage(parsed, raw, upstream.status));
    }

    const data = parsed && typeof parsed === "object" && parsed != null ? parsed.data : null;
    const first = Array.isArray(data) ? data[0] : null;
    const b64 = first && typeof first === "object" && first != null ? first.b64_json : null;
    const url = first && typeof first === "object" && first != null ? first.url : null;

    let base64 = typeof b64 === "string" && b64.trim() ? b64.trim() : "";
    if (!base64 && typeof url === "string" && url.trim()) {
      base64 = await fetchAsBase64(url.trim(), controller.signal);
    }
    if (!base64) {
      throw new Error("No image data returned (missing b64_json/url)");
    }

    if (args.telegramEnabled) {
      const telegram = resolveTelegramConfigFromEnv({ chatId: args.telegramChatId });
      if (!telegram.ok) {
        if (!normalizeEnvValue(process.env.TELEGRAM_BOT_TOKEN)) {
          throw new Error("Missing Telegram config: TELEGRAM_BOT_TOKEN");
        }
        if (!args.telegramChatId && !normalizeEnvValue(process.env.ADS_TELEGRAM_CHAT_ID) && !telegram.hasAllowedUsersSingle) {
          throw new Error("Missing Telegram chat_id: set --tg-chat-id, ADS_TELEGRAM_CHAT_ID, or TELEGRAM_ALLOWED_USERS (single id)");
        }
        throw new Error("Missing Telegram config: TELEGRAM_BOT_TOKEN + chat_id");
      }

      const filename = inferFilenameFromOutPath(args.outPath);
      await sendImageToTelegram({
        botToken: telegram.botToken,
        chatId: telegram.chatId,
        mode: args.telegramMode,
        caption: args.telegramCaption,
        bytes: Buffer.from(base64, "base64"),
        filename,
      });
    }

    if (args.outPath) {
      const outPath = path.resolve(process.cwd(), args.outPath);
      const dir = path.dirname(outPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(outPath, Buffer.from(base64, "base64"));
    }

    if (stdoutMode === "base64") {
      process.stdout.write(`${base64}\n`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message || "unknown error"}\n`);
  process.exitCode = 1;
});
