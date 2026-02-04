import os from "node:os";
import path from "node:path";

export function resolveCodexHomeDir(): string {
  const raw = String(process.env.CODEX_HOME ?? "").trim();
  if (raw) {
    // Expand "~" to the user's home directory for convenience (`CODEX_HOME=~/.codex`).
    if (raw === "~") {
      return os.homedir();
    }
    if (raw.startsWith("~/") || raw.startsWith("~\\")) {
      return path.resolve(path.join(os.homedir(), raw.slice(2)));
    }
    return path.resolve(raw);
  }
  return path.join(os.homedir(), ".codex");
}
