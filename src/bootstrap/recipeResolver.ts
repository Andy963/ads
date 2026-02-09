import fs from "node:fs";
import path from "node:path";

import type { VerificationCommand } from "../agents/tasks/schemas.js";
import type { BootstrapRecipe } from "./types.js";

export type RecipeResolution =
  | { ok: true; recipe: BootstrapRecipe; detected: { kind: "node"; packageManager: "npm" | "pnpm" | "yarn" } }
  | { ok: true; recipe: BootstrapRecipe; detected: { kind: "python"; installer: "uv" | "poetry" | "pip" } }
  | { ok: false; reason: "needs_config" | "unsupported"; message: string };

function fileExists(dir: string, relPath: string): boolean {
  try {
    return fs.existsSync(path.join(dir, relPath));
  } catch {
    return false;
  }
}

function readUtf8IfExists(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function cmd(cmd: string, args: string[], timeoutMs: number): VerificationCommand {
  return { cmd, args, timeoutMs };
}

function resolveNodeRecipe(projectDir: string): RecipeResolution | null {
  const packageJsonPath = path.join(projectDir, "package.json");
  const raw = readUtf8IfExists(packageJsonPath);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "needs_config", message: "package.json is not valid JSON" };
  }
  const scripts = (parsed as { scripts?: unknown }).scripts;
  const scriptsObj = scripts && typeof scripts === "object" && !Array.isArray(scripts) ? (scripts as Record<string, unknown>) : {};
  const hasLint = typeof scriptsObj.lint === "string" && scriptsObj.lint.trim().length > 0;
  const hasTest = typeof scriptsObj.test === "string" && scriptsObj.test.trim().length > 0;

  if (!hasLint || !hasTest) {
    return { ok: false, reason: "needs_config", message: "missing required package.json scripts: lint and/or test" };
  }

  const packageManager: "npm" | "pnpm" | "yarn" = fileExists(projectDir, "pnpm-lock.yaml")
    ? "pnpm"
    : fileExists(projectDir, "yarn.lock")
      ? "yarn"
      : "npm";

  const install: VerificationCommand[] = (() => {
    if (packageManager === "pnpm") {
      return [fileExists(projectDir, "pnpm-lock.yaml") ? cmd("pnpm", ["install", "--frozen-lockfile"], 15 * 60 * 1000) : cmd("pnpm", ["install"], 15 * 60 * 1000)];
    }
    if (packageManager === "yarn") {
      return [fileExists(projectDir, "yarn.lock") ? cmd("yarn", ["install", "--frozen-lockfile"], 15 * 60 * 1000) : cmd("yarn", ["install"], 15 * 60 * 1000)];
    }
    if (fileExists(projectDir, "package-lock.json")) {
      return [cmd("npm", ["ci"], 15 * 60 * 1000)];
    }
    return [cmd("npm", ["install"], 15 * 60 * 1000)];
  })();

  const lint: VerificationCommand[] = (() => {
    if (packageManager === "pnpm") return [cmd("pnpm", ["lint"], 10 * 60 * 1000)];
    if (packageManager === "yarn") return [cmd("yarn", ["lint"], 10 * 60 * 1000)];
    return [cmd("npm", ["run", "lint"], 10 * 60 * 1000)];
  })();

  const test: VerificationCommand[] = (() => {
    if (packageManager === "pnpm") return [cmd("pnpm", ["test"], 20 * 60 * 1000)];
    if (packageManager === "yarn") return [cmd("yarn", ["test"], 20 * 60 * 1000)];
    return [cmd("npm", ["test"], 20 * 60 * 1000)];
  })();

  return {
    ok: true,
    recipe: { version: 1, install, lint, test, env: { CI: "1" } },
    detected: { kind: "node", packageManager },
  };
}

function detectRuffConfigured(projectDir: string): boolean {
  const pyprojectPath = path.join(projectDir, "pyproject.toml");
  const content = readUtf8IfExists(pyprojectPath);
  if (!content) return false;
  return /\[\s*tool\.ruff\s*\]/i.test(content);
}

function resolvePythonRecipe(projectDir: string): RecipeResolution | null {
  const hasUv = fileExists(projectDir, "uv.lock");
  const hasPoetry = fileExists(projectDir, "poetry.lock");
  const hasRequirements = fileExists(projectDir, "requirements.txt");
  if (!hasUv && !hasPoetry && !hasRequirements) {
    return null;
  }

  const installer: "uv" | "poetry" | "pip" = hasUv ? "uv" : hasPoetry ? "poetry" : "pip";
  const install: VerificationCommand[] = (() => {
    if (installer === "uv") {
      return [cmd("uv", ["sync", "--frozen"], 15 * 60 * 1000)];
    }
    if (installer === "poetry") {
      return [cmd("poetry", ["install", "--no-interaction", "--no-ansi"], 15 * 60 * 1000)];
    }
    return [
      cmd("python", ["-m", "venv", ".venv"], 5 * 60 * 1000),
      cmd(path.join(".venv", "bin", "pip"), ["install", "-r", "requirements.txt"], 15 * 60 * 1000),
    ];
  })();

  if (!detectRuffConfigured(projectDir)) {
    return { ok: false, reason: "needs_config", message: "python project detected but ruff is not configured in pyproject.toml" };
  }

  const lint: VerificationCommand[] = [cmd("ruff", ["check", "."], 10 * 60 * 1000)];
  const test: VerificationCommand[] = [cmd("pytest", [], 20 * 60 * 1000)];

  return {
    ok: true,
    recipe: { version: 1, install, lint, test, env: { CI: "1" } },
    detected: { kind: "python", installer },
  };
}

export function resolveBootstrapRecipe(projectDir: string): RecipeResolution {
  const resolved = path.resolve(projectDir);

  const node = resolveNodeRecipe(resolved);
  if (node) return node;

  const python = resolvePythonRecipe(resolved);
  if (python) return python;

  return { ok: false, reason: "unsupported", message: "unable to detect a bootstrap recipe for this project" };
}

