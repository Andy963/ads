import { truncateToWidth } from "../utils/terminalText.js";
import type { VectorQueryHit } from "./types.js";

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function snippetFor(hit: VectorQueryHit): string {
  const candidate = safeString(hit.snippet) || safeString(hit.text) || safeString(hit.metadata?.snippet);
  const normalized = candidate.replace(/\s+/g, " ").trim();
  return truncateToWidth(normalized, 260) || "(no snippet)";
}

function refFor(hit: VectorQueryHit): string {
  const md = hit.metadata ?? {};
  const sourceType = safeString((md as any).source_type) || "unknown";
  if (sourceType === "spec" || sourceType === "adr") {
    const path = safeString((md as any).path);
    return path ? `${sourceType} ${path}` : sourceType;
  }
  if (sourceType === "chat") {
    const ns = safeString((md as any).namespace);
    const session = safeString((md as any).session_id);
    const role = safeString((md as any).role);
    const rowId = safeString((md as any).row_id);
    const parts = [
      ns ? `ns=${ns}` : "",
      session ? `session=${session}` : "",
      role ? `role=${role}` : "",
      rowId ? `id=${rowId}` : "",
    ].filter(Boolean);
    return parts.length ? `chat (${parts.join(", ")})` : "chat";
  }
  return sourceType;
}

export function formatVectorSearchOutput(params: {
  query: string;
  hits: VectorQueryHit[];
  topK: number;
  warnings?: string[];
}): string {
  const lines: string[] = [];
  const warnings = params.warnings ?? [];
  lines.push(`Vector search results for: ${params.query}`);
  lines.push("");
  if (warnings.length > 0) {
    lines.push("---");
    for (const warning of warnings) {
      lines.push(`warning: ${warning}`);
    }
    lines.push("---");
    lines.push("");
  }

  if (params.hits.length === 0) {
    lines.push("(no results)");
    return lines.join("\n");
  }

  const max = Math.max(1, params.topK);
  const shown = params.hits.slice(0, max);
  for (let i = 0; i < shown.length; i += 1) {
    const hit = shown[i];
    const score = toNumber(hit.score);
    const rerankScore = toNumber(hit.rerankScore);
    const scoreText = score === undefined ? "?" : score.toFixed(3);
    if (rerankScore !== undefined) {
      const rerankText = rerankScore.toFixed(3);
      lines.push(`${i + 1}) [r=${rerankText} v=${scoreText}] ${refFor(hit)}`);
    } else {
      lines.push(`${i + 1}) [${scoreText}] ${refFor(hit)}`);
    }
    lines.push(`   ${snippetFor(hit)}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
