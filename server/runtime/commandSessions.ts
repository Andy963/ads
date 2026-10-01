import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import { createAbortError } from "../utils/abort.js";
import { assertCommandAllowed, assertShellCommandAllowed } from "../utils/commandRunner.js";

const MAX_SESSIONS = 16;
const KILL_GRACE_MS = 1200;
const PRIVATE_KEY_LABELS = ["PRIVATE KEY", "RSA PRIVATE KEY", "DSA PRIVATE KEY", "EC PRIVATE KEY",
  "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"];

/** Stateful suppression runs before line truncation, so dropped headers cannot expose later key lines. */
class PrivateKeyRedactor {
  private label: string | undefined;
  private pending = "";

  write(value: string, final = false): string {
    let input = this.pending + value;
    this.pending = "";
    let output = "";
    while (input) {
      const labels = this.label ? [this.label] : PRIVATE_KEY_LABELS;
      const markers = labels.map(label => `-----${this.label ? "END" : "BEGIN"} ${label}-----`);
      let found = -1;
      let position = input.length;
      for (let i = 0; i < markers.length; i++) {
        const index = input.indexOf(markers[i]);
        if (index >= 0 && index < position) { found = i; position = index; }
      }
      if (found >= 0) {
        if (!this.label) output += input.slice(0, position) + "[redacted]";
        input = input.slice(position + markers[found].length);
        this.label = this.label ? undefined : labels[found];
        continue;
      }
      let retained = 0;
      if (!final) {
        for (const marker of markers) {
          for (let size = 1; size < marker.length && size <= input.length; size++) {
            if (size > retained && input.endsWith(marker.slice(0, size))) retained = size;
          }
        }
      }
      if (!this.label) output += input.slice(0, input.length - retained);
      this.pending = retained ? input.slice(-retained) : "";
      break;
    }
    return output;
  }
}

/** Drain complete lines so a credential split between writes is never exposed by polling. */
class OutputBuffer {
  private readonly decoder = new StringDecoder("utf8");
  private readonly privateKeys = new PrivateKeyRedactor();
  private partial = "";
  private droppingLine = false;
  private text = "";
  private truncated = false;

  constructor(private readonly limit: number, private readonly sanitize: (text: string) => string) {}

  append(chunk: Buffer): void { this.accept(this.privateKeys.write(this.decoder.write(chunk))); }

  finish(): void {
    this.accept(this.privateKeys.write(this.decoder.end(), true));
    if (!this.droppingLine) this.store(this.partial);
    this.partial = "";
  }

  private accept(value: string): void {
    for (const part of value.split(/(?<=\n)/)) {
      const complete = part.endsWith("\n");
      if (!this.droppingLine) {
        this.partial += part;
        if (Buffer.byteLength(this.partial) > this.limit) {
          // Do not return a suffix stripped of its credential-assignment context.
          this.partial = "";
          this.droppingLine = true;
          this.truncated = true;
        }
      }
      if (complete) {
        if (!this.droppingLine) this.store(this.partial);
        this.partial = "";
        this.droppingLine = false;
      }
    }
  }

  private store(value: string): void {
    this.text += this.sanitize(value);
    while (Buffer.byteLength(this.text) > this.limit) {
      const end = this.text.indexOf("\n");
      this.text = end < 0 ? "" : this.text.slice(end + 1);
      this.truncated = true;
    }
  }

  drain(): { text: string; truncated: boolean } {
    const result = { text: this.text, truncated: this.truncated };
    this.text = "";
    this.truncated = false;
    return result;
  }
}

export interface CommandSessionRequest {
  callId: string;
  cmd: string;
  args: string[];
  shell: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  allowlist: string[] | null;
  maxOutputBytes: number;
  maxRuntimeMs?: number;
}

export interface CommandSessionResult {
  sessionId: string;
  callId: string;
  command: string;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  elapsedMs: number;
  stdout: string;
  stderr: string;
  truncatedStdout: boolean;
  truncatedStderr: boolean;
}

class CommandSession {
  readonly id = randomUUID();
  readonly command: string;
  readonly done: Promise<void>;
  readonly child: ChildProcess;
  private readonly startedAt = Date.now();
  private readonly stdout: OutputBuffer;
  private readonly stderr: OutputBuffer;
  private deadline?: NodeJS.Timeout;
  private termination?: Promise<void>;
  private finishedAt?: number;
  private error?: Error;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private timedOut = false;
  private cancelled = false;
  private ownsGroup = true;

  constructor(readonly request: CommandSessionRequest, sanitize: (text: string) => string) {
    this.command = request.shell ? request.cmd : [request.cmd, ...request.args].join(" ");
    this.stdout = new OutputBuffer(request.maxOutputBytes, sanitize);
    this.stderr = new OutputBuffer(request.maxOutputBytes, sanitize);
    this.child = spawn(request.shell ? "/bin/sh" : request.cmd, request.shell ? ["-c", request.cmd] : request.args, {
      cwd: request.cwd, env: request.env, shell: false,
      stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    this.child.stdout!.on("data", (chunk: Buffer) => this.stdout.append(chunk));
    this.child.stderr!.on("data", (chunk: Buffer) => this.stderr.append(chunk));
    this.done = new Promise(resolve => {
      this.child.once("error", error => {
        this.error = error;
        this.stderr.append(Buffer.from(`${error.message}\n`));
      });
      this.child.once("close", (code, signal) => {
        this.exitCode = this.error ? (code || -1) : code;
        this.exitSignal = signal;
        this.stdout.finish();
        this.stderr.finish();
        this.finishedAt = Date.now();
        clearTimeout(this.deadline);
        resolve();
        // Release group ownership immediately; a later poll must never signal a recycled pid.
        if (this.groupExists()) void this.stop().catch(() => {});
      });
    });
    if (request.maxRuntimeMs !== undefined) {
      this.deadline = setTimeout(() => { void this.stop(true).catch(() => {}); }, request.maxRuntimeMs);
    }
  }

  private signalGroup(signal: NodeJS.Signals): void {
    if (!this.ownsGroup) return;
    try {
      if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private groupExists(): boolean {
    if (!this.ownsGroup) return false;
    try {
      if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, 0);
      else return this.finishedAt === undefined;
      return true;
    } catch {
      this.ownsGroup = false;
      return false;
    }
  }

  stop(timedOut = false): Promise<void> {
    if (this.termination) return this.termination;
    this.termination = (async () => {
      this.timedOut = timedOut;
      this.cancelled = !timedOut;
      clearTimeout(this.deadline);
      this.signalGroup("SIGTERM");
      let timer: NodeJS.Timeout | undefined;
      const grace = new Promise<void>(resolve => { timer = setTimeout(resolve, KILL_GRACE_MS); });
      await Promise.race([this.done, grace]);
      // A shell can exit before a descendant that ignores SIGTERM. Do not clear its kill timer early.
      if (this.groupExists()) {
        await grace;
        this.signalGroup("SIGKILL");
      } else clearTimeout(timer);
      await this.done;
    })();
    return this.termination;
  }

  async read(yieldMs: number): Promise<CommandSessionResult> {
    if (this.finishedAt === undefined) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.done, new Promise<void>(resolve => { timer = setTimeout(resolve, yieldMs); })]);
      clearTimeout(timer);
    }
    if (this.finishedAt !== undefined) {
      // Reap any background descendants even if the shell closed its own output streams.
      if (this.groupExists()) await this.stop();
      if (this.termination) await this.termination;
    }
    const stdout = this.stdout.drain();
    const stderr = this.stderr.drain();
    return {
      sessionId: this.id, callId: this.request.callId, command: this.command,
      running: this.finishedAt === undefined, exitCode: this.exitCode, signal: this.exitSignal,
      timedOut: this.timedOut, cancelled: this.cancelled,
      elapsedMs: (this.finishedAt ?? Date.now()) - this.startedAt,
      stdout: stdout.text, stderr: stderr.text,
      truncatedStdout: stdout.truncated, truncatedStderr: stderr.truncated,
    };
  }
}

/** Turn-local ownership: ids are unguessable, never global, and never replayed after restart. */
export class CommandSessions {
  private readonly sessions = new Map<string, CommandSession>();
  private closed = false;
  private cleanup?: Promise<void>;
  // The caller awaits the same cleanup promise; event callbacks must not create unhandled rejections.
  private readonly onAbort = (): void => { void this.dispose().catch(() => {}); };

  constructor(private readonly sanitize: (text: string) => string, private readonly signal?: AbortSignal) {
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.closed = true;
  }

  pendingIds(): string[] { return [...this.sessions.keys()]; }

  start(request: CommandSessionRequest): string {
    if (this.closed || this.signal?.aborted) throw createAbortError();
    if (this.sessions.size >= MAX_SESSIONS) throw new Error("Too many pending command sessions. Wait for or cancel an existing session before starting another.");
    if (request.shell) assertShellCommandAllowed(request.cmd, request.allowlist);
    else assertCommandAllowed(request.cmd, request.args, request.allowlist);
    const session = new CommandSession(request, this.sanitize);
    this.sessions.set(session.id, session);
    return session.id;
  }

  async read(id: string, yieldMs: number, cancel = false): Promise<CommandSessionResult> {
    if (this.closed || this.signal?.aborted) throw createAbortError();
    const session = this.sessions.get(id);
    if (!session) throw new Error("Unknown or completed command session in this turn. It may belong to an earlier turn or server process. Never rerun a command merely to recover its output; inspect execution history and workspace state first.");
    try {
      if (cancel) await session.stop();
      const result = await session.read(yieldMs);
      if (this.closed || this.signal?.aborted) throw createAbortError();
      if (!result.running) this.sessions.delete(id);
      return result;
    } catch (error) {
      await session.stop();
      this.sessions.delete(id);
      throw error;
    }
  }

  dispose(): Promise<void> {
    if (this.cleanup) return this.cleanup;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.cleanup = Promise.allSettled([...this.sessions.values()].map(session => session.stop()))
      .then(results => {
        this.sessions.clear();
        const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, "Failed to terminate command sessions");
      });
    return this.cleanup;
  }
}
