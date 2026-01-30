import type { Input } from "@openai/codex-sdk";

import type { VectorAutoContextReport } from "../../vectorSearch/context.js";

export function formatVectorAutoContextSummary(report: VectorAutoContextReport): string {
  const injected = report.injected ? 1 : 0;
  const cache = report.cacheHit ? "cache" : "fresh";
  const status = report.ok ? "ok" : report.code === "disabled" ? "skipped" : "failed";
  const ms = Math.max(0, Math.floor(report.elapsedMs));
  const injectedChars = Math.max(0, Math.floor(report.injectedChars));
  const hits = Math.max(0, Math.floor(report.hits));
  const filtered = Math.max(0, Math.floor(report.filtered));
  const retryCount = Math.max(0, Math.floor(report.retryCount ?? 0));
  const http = report.httpStatus ? ` http=${report.httpStatus}` : "";
  const code = report.code ? ` code=${report.code}` : "";
  const provider = report.providerCode ? ` provider=${report.providerCode}` : "";
  const reasonRaw = String(report.message ?? "").trim();
  const reason = reasonRaw ? ` reason=${reasonRaw.length > 160 ? reasonRaw.slice(0, 159) + "…" : reasonRaw}` : "";
  return `VectorSearch(auto) ${cache} status=${status}${code}${http}${provider}${reason} injected=${injected} hits=${hits} filtered=${filtered} chars=${injectedChars} retry=${retryCount} ms=${ms} qhash=${report.queryHash}`;
}

function normalizeInputToText(input: Input): string {
  if (typeof input === "string") {
    return input;
  }
  if (Array.isArray(input)) {
    return input
      .map((part) => {
        const current = part as { type?: string; text?: string; path?: string };
        if (current.type === "text" && typeof current.text === "string") {
          return current.text;
        }
        if (current.type === "local_image") {
          return `[image:${current.path ?? "blob"}]`;
        }
        return current.type ? `[${current.type}]` : "[content]";
      })
      .join("\n\n");
  }
  return String(input);
}

export function extractVectorQuery(input: Input): string {
  const text = (() => {
    if (typeof input === "string") {
      return input;
    }
    if (Array.isArray(input)) {
      return input
        .map((part) => {
          if (!part || typeof part !== "object") {
            return "";
          }
          const candidate = part as { type?: unknown; text?: unknown };
          if (candidate.type !== "text") {
            return "";
          }
          return typeof candidate.text === "string" ? candidate.text : String(candidate.text ?? "");
        })
        .filter(Boolean)
        .join("\n\n");
    }
    return normalizeInputToText(input);
  })().trim();
  if (!text) {
    return "";
  }
  const marker = "用户输入:";
  const idx = text.lastIndexOf(marker);
  if (idx >= 0) {
    return text.slice(idx + marker.length).trim();
  }
  return text;
}

function injectVectorContextIntoText(text: string, context: string): string {
  const normalizedText = String(text ?? "");
  const normalizedContext = String(context ?? "").trim();
  if (!normalizedContext) {
    return normalizedText;
  }

  const marker = "用户输入:";
  const idx = normalizedText.lastIndexOf(marker);
  if (idx >= 0) {
    const lineStart = normalizedText.lastIndexOf("\n", idx);
    const insertPos = lineStart >= 0 ? lineStart + 1 : 0;
    const before = normalizedText.slice(0, insertPos).trimEnd();
    const after = normalizedText.slice(insertPos).trimStart();
    return [before, normalizedContext, after].filter(Boolean).join("\n\n").trim();
  }

  return [normalizedContext, normalizedText].filter(Boolean).join("\n\n").trim();
}

export function injectVectorContext(input: Input, context: string): Input {
  if (!context.trim()) {
    return input;
  }
  if (typeof input === "string") {
    return injectVectorContextIntoText(input, context);
  }
  if (Array.isArray(input)) {
    return [{ type: "text", text: context }, ...input];
  }
  return input;
}

