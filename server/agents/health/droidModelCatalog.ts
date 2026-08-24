import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ModelConfig } from "../../tasks/types.js";
import { createLogger } from "../../utils/logger.js";
import { withAgentCliPath } from "../cli/pathEnv.js";

const logger = createLogger("DroidModelCatalog");
const execFileAsync = promisify(execFile);
const CACHE_TTL_MS = 5 * 60_000;

type DroidModelDetails = {
  reasoningEfforts: string[];
  defaultReasoningEffort?: string;
};

let cached: { expiresAt: number; models: ModelConfig[] } | null = null;
let pending: Promise<ModelConfig[]> | null = null;

function normalizeDetailName(value: string): string {
  return value.replace(/\s+\(default\)$/i, "").trim().toLowerCase();
}

export function parseDroidModelCatalog(helpText: string): ModelConfig[] {
  const rows: Array<{ modelId: string; displayName: string; isDefault: boolean }> = [];
  const details = new Map<string, DroidModelDetails>();
  let section: "none" | "models" | "custom" | "details" = "none";

  for (const line of String(helpText ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "Available Models:") {
      section = "models";
      continue;
    }
    if (trimmed === "Custom Models:") {
      section = "custom";
      continue;
    }
    if (trimmed === "Model details:") {
      section = "details";
      continue;
    }
    if (!trimmed) continue;

    if (section === "models" || section === "custom") {
      const match = line.match(/^\s{2}(\S+)\s{2,}(.+?)\s*$/);
      if (!match) {
        section = "none";
        continue;
      }
      const modelId = match[1]?.trim() ?? "";
      const rawDisplayName = match[2]?.trim() ?? "";
      if (!modelId || !rawDisplayName || modelId.toLowerCase() === "auto") continue;
      rows.push({
        modelId,
        displayName: rawDisplayName.replace(/\s+\(default\)$/i, "").trim(),
        isDefault: /\(default\)$/i.test(rawDisplayName),
      });
      continue;
    }

    if (section === "details") {
      const match = line.match(
        /^\s*-\s+(.+?):\s+supports reasoning:\s+(?:yes|no);\s+supported:\s+\[([^\]]*)\];\s+default:\s+(\S+)/i,
      );
      if (!match) {
        section = "none";
        continue;
      }
      const name = normalizeDetailName(match[1] ?? "");
      const reasoningEfforts = String(match[2] ?? "")
        .split(",")
        .map((effort) => effort.trim().toLowerCase())
        .filter(Boolean);
      const defaultReasoningEffort = String(match[3] ?? "").trim().toLowerCase() || undefined;
      details.set(name, { reasoningEfforts, defaultReasoningEffort });
    }
  }

  return rows.map((row) => {
    const modelDetails = details.get(normalizeDetailName(row.displayName));
    return {
      id: `droid-discovered:${row.modelId}`,
      modelId: row.modelId,
      displayName: row.displayName,
      provider: "factory",
      isEnabled: true,
      isDefault: row.isDefault,
      configJson: {
        allowedAgents: ["droid"],
        ...(modelDetails?.reasoningEfforts.length
          ? { reasoningEfforts: modelDetails.reasoningEfforts }
          : {}),
        ...(modelDetails?.defaultReasoningEffort
          ? { defaultReasoningEffort: modelDetails.defaultReasoningEffort }
          : {}),
      },
    };
  });
}

async function loadDroidModelCatalog(): Promise<ModelConfig[]> {
  if (String(process.env.ADS_DROID_ENABLED ?? "").trim() === "0") return [];
  const binary = String(process.env.ADS_DROID_BIN ?? "droid").trim() || "droid";
  const env = withAgentCliPath(process.env);
  const { stdout } = await execFileAsync(binary, ["exec", "--help"], {
    env,
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return parseDroidModelCatalog(stdout);
}

export async function discoverDroidModels(): Promise<ModelConfig[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.models;
  if (pending) return pending;

  pending = loadDroidModelCatalog()
    .then((models) => {
      cached = { expiresAt: Date.now() + CACHE_TTL_MS, models };
      return models;
    })
    .catch((error) => {
      logger.warn(`Failed to load Droid model catalog: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
