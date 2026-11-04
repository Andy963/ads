import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

type SessionMetaRecord = {
  type?: unknown;
  payload?: {
    dynamic_tools?: unknown;
  };
};

function readToolNames(value: unknown): Set<string> {
  if (!Array.isArray(value)) {
    return new Set();
  }
  const names = value.flatMap((tool) => {
    if (!tool || typeof tool !== "object") {
      return [];
    }
    const name = (tool as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  });
  return new Set(names);
}

/** Read the dynamic-tool names persisted on the first line of a Codex rollout. */
export async function readPersistedDynamicToolNames(
  rolloutPath: string | null | undefined,
): Promise<Set<string> | null> {
  const normalizedPath = typeof rolloutPath === "string" ? rolloutPath.trim() : "";
  if (!normalizedPath) {
    return null;
  }

  const stream = createReadStream(normalizedPath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      const record = JSON.parse(line) as SessionMetaRecord;
      if (record.type !== "session_meta") {
        return null;
      }
      return readToolNames(record.payload?.dynamic_tools);
    }
    return null;
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}
