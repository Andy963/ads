import fs from "node:fs";
import path from "node:path";

import type { BootstrapIterationOutcome, BootstrapRunResult, BootstrapRunSpec } from "./types.js";

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeUtf8(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({ error: "failed to stringify value" }, null, 2);
  }
}

export class BootstrapArtifactStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    ensureDir(this.rootDir);
  }

  iterationDir(iteration: number): string {
    return path.join(this.rootDir, "iterations", String(iteration));
  }

  writeIteration(outcome: BootstrapIterationOutcome): void {
    const dir = this.iterationDir(outcome.iteration);
    ensureDir(dir);

    writeUtf8(path.join(dir, "outcome.json"), safeStringify(outcome));

    if (outcome.installReport) {
      writeUtf8(path.join(dir, "install.json"), safeStringify(outcome.installReport));
    }

    if (outcome.lintReport) {
      writeUtf8(path.join(dir, "lint.json"), safeStringify(outcome.lintReport));
    }

    if (outcome.testReport) {
      writeUtf8(path.join(dir, "test.json"), safeStringify(outcome.testReport));
    }
  }

  writeDiffPatch(iteration: number, patch: string): string {
    const filePath = path.join(this.iterationDir(iteration), "diff.patch");
    writeUtf8(filePath, patch);
    return filePath;
  }

  writeStrategyLog(lines: string[]): void {
    const filePath = path.join(this.rootDir, "strategy.log");
    const content = lines.map((l) => l.trimEnd()).join("\n").trimEnd() + "\n";
    writeUtf8(filePath, content);
  }

  writeFinalReport(payload: { spec: BootstrapRunSpec; result: BootstrapRunResult; outcomes: BootstrapIterationOutcome[]; startedAt: string; finishedAt: string }): string {
    const filePath = path.join(this.rootDir, "report.json");
    writeUtf8(filePath, safeStringify(payload));
    return filePath;
  }
}

