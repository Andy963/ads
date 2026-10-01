import { createHmac, randomBytes } from "node:crypto";

type Observation = { fingerprint: string; verifiable: boolean; poll: boolean };
export interface ToolLoopGuardState {
  version: 1;
  salt: string;
  history: Observation[];
  warned: string[];
}
export interface ToolLoopObservation {
  name: string;
  arguments: string;
  result: string;
  failed?: boolean;
  /** A resource revision, not a counter of successful commands. Unknown shell state is warn-only. */
  stateVersion?: string;
  /** Only the caller's verified wait operation may set this; tool names are not exemptions. */
  poll?: boolean;
}
export interface ToolLoopDecision { action: "allow" | "warn" | "pause"; reason?: string }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]));
}

/** Bounded, per-execution evidence. Nothing here infers progress from prose or exit code zero. */
export class ToolLoopGuard {
  private readonly state: ToolLoopGuardState;

  constructor(snapshot?: ToolLoopGuardState | null) {
    this.state = snapshot?.version === 1 && /^[a-f0-9]{64}$/.test(snapshot.salt)
      && Array.isArray(snapshot.history) && snapshot.history.every(item => item
        && /^[a-f0-9]{64}$/.test(item.fingerprint) && typeof item.verifiable === "boolean" && typeof item.poll === "boolean")
      && Array.isArray(snapshot.warned) && snapshot.warned.every(item => typeof item === "string" && item.length <= 259)
      ? structuredClone({ ...snapshot, history: snapshot.history.slice(-64), warned: snapshot.warned.slice(-16) })
      : { version: 1, salt: randomBytes(32).toString("hex"), history: [], warned: [] };
  }

  snapshot(): ToolLoopGuardState { return structuredClone(this.state); }

  observe(input: ToolLoopObservation): ToolLoopDecision {
    let args: unknown = input.arguments;
    try { args = canonical(JSON.parse(input.arguments)); } catch { /* Invalid arguments remain distinct evidence. */ }
    const fingerprint = createHmac("sha256", this.state.salt)
      .update(JSON.stringify([input.name, args, input.result, !!input.failed, input.stateVersion ?? null])).digest("hex");
    const history = this.state.history;
    history.push({ fingerprint, verifiable: input.stateVersion !== undefined, poll: input.poll === true });
    if (history.length > 64) history.shift();
    for (let period = 1; period <= 4; period += 1) {
      let laps = 1;
      while ((laps + 1) * period <= history.length) {
        const start = history.length - (laps + 1) * period;
        if (!history.slice(start, start + period).every((item, i) =>
          item.fingerprint === history[history.length - period + i]?.fingerprint)) break;
        laps += 1;
      }
      if (laps < 3) continue;
      const cycle = history.slice(-period);
      // A live process can legitimately alternate waiting and reading an unchanged progress log.
      // Such a cycle does not establish unchanged execution state, even if its reads are immutable.
      if (cycle.some(item => item.poll)) continue;
      const reason = `Repeated ${period === 1 ? "an identical operation" : `a ${period}-operation cycle`} ${laps} times with unchanged results. Change the approach or verify the relevant state before repeating it.`;
      if (laps >= 5 && cycle.every(item => item.verifiable)) return { action: "pause", reason };
      const key = cycle.map(item => item.fingerprint).join(":");
      if (!this.state.warned.includes(key)) {
        this.state.warned = [...this.state.warned.slice(-15), key];
        return { action: "warn", reason };
      }
    }
    return { action: "allow" };
  }
}

export class ToolLoopPausedError extends Error {
  readonly code = "LOOP_DETECTED";
  constructor(reason: string) {
    super(`Paused: loop detected. ${reason} Completed results are preserved. Send a revised instruction to continue, or start a new session to reset the execution history.`);
    this.name = "ToolLoopPausedError";
  }
}
