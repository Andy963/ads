import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdsMiddleware, TurnContext, ItemEndResult } from "../types.js";
import type { ThreadItem } from "../../agents/protocol/types.js";

export interface ContextArtifactMiddlewareOptions {
  maxOutputBytes?: number;
  artifactsDir?: string;
}

const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024; // 50 KB

export function createContextArtifactMiddleware(
  options: ContextArtifactMiddlewareOptions = {},
): AdsMiddleware {
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return {
    name: "contextArtifact",

    onItemEnd(ctx: TurnContext, item: ThreadItem): ItemEndResult | void {
      let rawOutput = "";
      if (item.type === "command_execution") {
        rawOutput = String(item.aggregated_output ?? item.stdout ?? "");
      } else if ("output" in item && typeof (item as { output?: unknown }).output === "string") {
        rawOutput = (item as unknown as { output: string }).output;
      }

      if (!rawOutput || Buffer.byteLength(rawOutput, "utf8") <= maxBytes) {
        return;
      }

      const baseDir = options.artifactsDir ?? path.join(ctx.workspaceRoot || os.tmpdir(), ".ads", "artifacts");
      try {
        fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
      } catch {
        // ignore
      }

      const artifactId = `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
      const artifactPath = path.join(baseDir, artifactId);
      try {
        fs.writeFileSync(artifactPath, rawOutput, { encoding: "utf8", mode: 0o600 });
        fs.chmodSync(artifactPath, 0o600);
        const lines = rawOutput.split("\n");
        const head = lines.slice(0, 20).join("\n");
        const tail = lines.slice(-20).join("\n");
        const modifiedOutput = `${head}\n\n... [Output truncated: ${rawOutput.length} characters / ${lines.length} lines saved to artifact: ${artifactPath}] ...\n\n${tail}`;
        return { modifiedOutput };
      } catch {
        return;
      }
    },
  };
}
