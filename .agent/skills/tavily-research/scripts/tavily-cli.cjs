#!/usr/bin/env node
"use strict";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function toList(value) {
  const s = String(value ?? "").trim();
  if (!s) return undefined;
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function ensureProxyEnv() {
  if (!process.env.TAVILY_HTTP_PROXY && process.env.HTTP_PROXY) process.env.TAVILY_HTTP_PROXY = process.env.HTTP_PROXY;
  if (!process.env.TAVILY_HTTPS_PROXY && process.env.HTTPS_PROXY) process.env.TAVILY_HTTPS_PROXY = process.env.HTTPS_PROXY;
}

async function main() {
  const { tavily } = require("@tavily/core");

  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  ensureProxyEnv();

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    console.error("Missing TAVILY_API_KEY");
    process.exit(2);
  }

  const client = tavily({ apiKey });

  if (cmd === "search") {
    const query = String(args.query ?? "").trim();
    if (!query) {
      console.error("Missing --query");
      process.exit(2);
    }

    const maxResults = args.maxResults ? Number(args.maxResults) : undefined;
    const searchDepth = args.searchDepth ? String(args.searchDepth) : undefined;
    const includeDomains = toList(args.includeDomains);
    const excludeDomains = toList(args.excludeDomains);
    const topic = args.topic ? String(args.topic) : undefined;
    const days = args.days ? Number(args.days) : undefined;

    const res = await client.search(query, {
      maxResults,
      searchDepth,
      includeDomains,
      excludeDomains,
      topic,
      days,
    });

    process.stdout.write(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === "fetch") {
    const url = String(args.url ?? "").trim();
    if (!url) {
      console.error("Missing --url");
      process.exit(2);
    }

    const includeImages = args.includeImages ? args.includeImages === "true" : undefined;
    const extractDepth = args.extractDepth ? String(args.extractDepth) : undefined;
    const format = args.format ? String(args.format) : undefined;
    const timeout = args.timeout ? Number(args.timeout) : undefined;
    const includeFavicon = args.includeFavicon ? args.includeFavicon === "true" : undefined;

    const res = await client.extract([url], {
      includeImages,
      extractDepth,
      format,
      timeout,
      includeFavicon,
    });

    process.stdout.write(JSON.stringify(res, null, 2));
    return;
  }

  console.error("Usage:");
  console.error('  node tavily-cli.cjs search --query "..." [--maxResults 5] [--searchDepth basic|advanced]');
  console.error('  node tavily-cli.cjs fetch --url "https://..." [--extractDepth basic|advanced] [--format markdown|text]');
  process.exit(2);
}

main().catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
