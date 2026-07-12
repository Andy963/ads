import os from "node:os";
import path from "node:path";

function pathEnvKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") return "PATH";
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function homeCandidates(env: NodeJS.ProcessEnv): string[] {
  const homes = [env.HOME, os.homedir()]
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  return Array.from(new Set(homes));
}

export function buildAgentCliPath(currentPath: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const currentEntries = String(currentPath ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const additions = homeCandidates(env)
    .map((home) => path.join(home, ".local", "bin"))
    .filter((entry) => !currentEntries.includes(entry));
  return [...additions, ...currentEntries].join(path.delimiter);
}

export function withAgentCliPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const merged = { ...env };
  const key = pathEnvKey(merged);
  merged[key] = buildAgentCliPath(merged[key], merged);
  return merged;
}
