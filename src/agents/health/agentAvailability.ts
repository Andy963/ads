import { spawn } from "node:child_process";

import type { AgentIdentifier, AgentStatus } from "../types.js";

export type AvailabilityRecord = {
  ready: boolean;
  error?: string;
  checkedAt: number;
};

export interface AgentAvailability {
  probeAll(agentIds?: AgentIdentifier[]): Promise<void>;
  get(agentId: AgentIdentifier): AvailabilityRecord | undefined;
  mergeStatus(agentId: AgentIdentifier, adapterStatus: AgentStatus): AgentStatus;
}

export class NoopAgentAvailability implements AgentAvailability {
  async probeAll(_agentIds?: AgentIdentifier[]): Promise<void> {
    return;
  }

  get(_agentId: AgentIdentifier): AvailabilityRecord | undefined {
    return undefined;
  }

  mergeStatus(_agentId: AgentIdentifier, adapterStatus: AgentStatus): AgentStatus {
    return adapterStatus;
  }
}

type ProbeRunResult =
  | { ok: true }
  | { ok: false; error: string };

export type ProbeRunner = (input: {
  binary: string;
  args: string[];
  timeoutMs: number;
}) => Promise<ProbeRunResult>;

function defaultBinaryForAgent(agentId: AgentIdentifier): string | null {
  switch (agentId) {
    case "codex":
      return process.env.ADS_CODEX_BIN ?? "codex";
    case "amp":
      return process.env.ADS_AMP_BIN ?? "amp";
    case "claude":
      return process.env.ADS_CLAUDE_BIN ?? "claude";
    case "gemini":
      return process.env.ADS_GEMINI_BIN ?? "gemini";
    case "droid":
      return process.env.ADS_DROID_BIN ?? "droid";
    default:
      return null;
  }
}

function defaultArgsCandidatesForAgent(_agentId: AgentIdentifier): string[][] {
  return [["--version"], ["-v"], ["version"], ["--help"]];
}

async function runProbeCommandWithTimeout(options: {
  binary: string;
  args: string[];
  timeoutMs: number;
}): Promise<ProbeRunResult> {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 500;

  const child = spawn(options.binary, options.args, {
    stdio: ["ignore", "ignore", "pipe"],
    shell: false,
    env: process.env,
  });

  let timedOut = false;
  let stderr = "";
  const stderrChunks: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const spawnError = await new Promise<Error | null>((resolve) => {
    child.on("error", (err) => resolve(err));
    child.on("spawn", () => resolve(null));
  });

  if (spawnError) {
    const errno = spawnError as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return { ok: false, error: `Binary not found: ${options.binary}` };
    }
    return { ok: false, error: spawnError.message };
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 250).unref?.();
  }, timeoutMs);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  clearTimeout(timeout);
  stderr = Buffer.concat(stderrChunks).toString("utf8").trim();

  if (timedOut) {
    return { ok: false, error: `Probe timed out: ${options.binary} ${options.args.join(" ")}` };
  }

  if (exitCode === 0) {
    return { ok: true };
  }

  const hint = stderr ? ` (stderr: ${stderr.slice(0, 180)})` : "";
  return { ok: false, error: `Probe failed: ${options.binary} ${options.args.join(" ")} (exit ${exitCode ?? "null"})${hint}` };
}

export class CliAgentAvailability implements AgentAvailability {
  private readonly timeoutMs: number;
  private readonly runner: ProbeRunner;
  private readonly records = new Map<AgentIdentifier, AvailabilityRecord>();

  constructor(options?: { timeoutMs?: number; runner?: ProbeRunner }) {
    const timeoutMsRaw = Number(options?.timeoutMs ?? process.env.ADS_AGENT_PROBE_TIMEOUT_MS ?? 3000);
    this.timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(50, Math.floor(timeoutMsRaw)) : 3000;
    this.runner = options?.runner ?? runProbeCommandWithTimeout;
  }

  get(agentId: AgentIdentifier): AvailabilityRecord | undefined {
    return this.records.get(agentId);
  }

  mergeStatus(agentId: AgentIdentifier, adapterStatus: AgentStatus): AgentStatus {
    const record = this.records.get(agentId);
    if (!record) {
      return adapterStatus;
    }
    if (!adapterStatus.ready) {
      return adapterStatus;
    }
    if (record.ready) {
      return adapterStatus;
    }
    return {
      ...adapterStatus,
      ready: false,
      error: adapterStatus.error ?? record.error ?? "unavailable",
    };
  }

  async probeAll(agentIds?: AgentIdentifier[]): Promise<void> {
    const targets = (agentIds && agentIds.length > 0 ? agentIds : (["codex", "amp", "claude", "gemini", "droid"] as const))
      .map((id) => String(id).trim())
      .filter(Boolean) as AgentIdentifier[];

    await Promise.all(targets.map(async (agentId) => {
      const binary = defaultBinaryForAgent(agentId);
      if (!binary) {
        return;
      }
      const argsCandidates = defaultArgsCandidatesForAgent(agentId);
      const checkedAt = Date.now();
      let lastError: string | undefined;

      for (const args of argsCandidates) {
        const result = await this.runner({ binary, args, timeoutMs: this.timeoutMs });
        if (result.ok) {
          this.records.set(agentId, { ready: true, checkedAt });
          return;
        }
        lastError = result.error;
      }

      this.records.set(agentId, { ready: false, error: lastError ?? "unavailable", checkedAt });
    }));
  }
}
