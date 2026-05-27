import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import { createLogger } from "../../utils/logger.js";

const logger = createLogger("CodexAppServerRpc");

export interface CodexAppServerSpawnOptions {
  /** Path or name of the codex binary. Defaults to `ADS_CODEX_BIN` or `"codex"`. */
  binary?: string;
  /** Extra arguments inserted before the `app-server` subcommand. */
  globalArgs?: string[];
  /** Arguments appended after `app-server` (e.g. `--enable feature`). */
  appServerArgs?: string[];
  /** Working directory for the spawned daemon. */
  cwd?: string;
  /** Override the environment (merged with `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Default per-request timeout (ms). 0 disables timeouts. */
  defaultRequestTimeoutMs?: number;
}

export interface JsonRpcSuccessResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  result: T;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string;
  error: JsonRpcErrorObject;
}

export interface JsonRpcNotification<T = unknown> {
  jsonrpc?: "2.0";
  method: string;
  params: T;
}

export interface JsonRpcRequest<T = unknown> {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params: T;
}

export type NotificationHandler = (params: unknown, method: string) => void;
export type CloseHandler = (code: number | null) => void;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class CodexAppServerRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "CodexAppServerRpcError";
    this.code = code;
    this.data = data;
  }
}

export class CodexAppServerRpcClosedError extends Error {
  readonly exitCode: number | null;
  constructor(exitCode: number | null, message?: string) {
    super(message ?? `codex app-server closed (exit=${exitCode ?? "null"})`);
    this.name = "CodexAppServerRpcClosedError";
    this.exitCode = exitCode;
  }
}

interface ClientHandle {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
  /**
   * Optional promise that resolves when the underlying process exits. When
   * absent (in tests with PassThrough streams) closure is detected via
   * stdout `end`.
   */
  waitClose?: () => Promise<number | null>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * JSON-RPC 2.0 client over the Codex app-server stdio transport.
 *
 * Each instance owns either a spawned `codex app-server` child process or a
 * caller-supplied duplex pair (used by tests to avoid relying on the real
 * binary).
 */
export class CodexAppServerClient {
  private handle: ClientHandle | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<NotificationHandler>>();
  private readonly anyNotificationHandlers = new Set<NotificationHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();
  private stdoutBuffer = "";
  private closed = false;
  private closeReported = false;
  private readonly defaultTimeoutMs: number;
  private readonly spawnOptions: CodexAppServerSpawnOptions;
  private startPromise: Promise<void> | null = null;

  constructor(options: CodexAppServerSpawnOptions = {}) {
    this.spawnOptions = options;
    this.defaultTimeoutMs = options.defaultRequestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Spawn the child process (or attach a caller-supplied handle for tests) and
   * send the JSON-RPC `initialize` request.
   */
  async start(): Promise<void> {
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.doStart().catch((err) => {
      this.startPromise = null;
      throw err;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    if (!this.handle) {
      if (this.spawnOptions && (this.spawnOptions as { handle?: ClientHandle }).handle) {
        this.attach((this.spawnOptions as { handle: ClientHandle }).handle);
      } else {
        this.spawnChild();
      }
    }

    await this.request("initialize", {
      clientInfo: { name: "ads-codex-appserver-adapter", title: null, version: "0.1.0" },
      capabilities: null,
    });
  }

  /**
   * Allows tests (or future transports) to inject a custom duplex stream pair
   * after construction instead of spawning the codex binary.
   */
  attach(handle: ClientHandle): void {
    if (this.handle) {
      throw new Error("CodexAppServerClient already attached");
    }
    this.handle = handle;
    this.wireStdout(handle.stdout);
    if (handle.stderr) {
      this.wireStderr(handle.stderr);
    }
    handle.stdout.once("end", () => this.handleClose(null));
    handle.stdout.once("error", (err) => {
      logger.debug(`stdout error: ${err instanceof Error ? err.message : String(err)}`);
      this.handleClose(null);
    });
  }

  private spawnChild(): void {
    const binary = this.spawnOptions.binary ?? process.env.ADS_CODEX_BIN ?? "codex";
    const globalArgs = this.spawnOptions.globalArgs ?? [];
    const appServerArgs = this.spawnOptions.appServerArgs ?? [];
    const args = [...globalArgs, "app-server", ...appServerArgs];

    const child = spawn(binary, args, {
      cwd: this.spawnOptions.cwd,
      env: this.spawnOptions.env ? { ...process.env, ...this.spawnOptions.env } : undefined,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;
    this.attach({
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      kill: (signal?: NodeJS.Signals | number) => child.kill(signal),
      waitClose: () =>
        new Promise<number | null>((resolve) => {
          if (child.exitCode !== null) {
            resolve(child.exitCode);
            return;
          }
          child.once("close", (code) => resolve(code));
        }),
    });

    child.once("error", (err) => {
      logger.warn(`spawn error: ${err.message}`);
      this.handleClose(null, err);
    });
    child.once("close", (code) => {
      this.handleClose(code);
    });
  }

  private wireStdout(stdout: Readable): void {
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      this.stdoutBuffer += chunk;
      while (true) {
        const newlineIdx = this.stdoutBuffer.indexOf("\n");
        if (newlineIdx < 0) {
          break;
        }
        const line = this.stdoutBuffer.slice(0, newlineIdx).replace(/\r$/, "");
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
        if (line.trim().length === 0) {
          continue;
        }
        this.handleLine(line);
      }
    });
  }

  private wireStderr(stderr: Readable): void {
    stderr.setEncoding("utf8");
    let buffer = "";
    stderr.on("data", (chunk: string) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.trim().length > 0) {
          logger.debug(`stderr: ${line}`);
        }
      }
    });
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      logger.debug(`unparsable line: ${line.slice(0, 200)} (${err instanceof Error ? err.message : err})`);
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    const obj = parsed as Record<string, unknown>;
    if ("id" in obj && (typeof obj.id === "number" || typeof obj.id === "string")) {
      // Response (success or error). Server-initiated requests will also have
      // an `id` plus a `method`; we currently treat those as notifications.
      if ("method" in obj && typeof obj.method === "string") {
        this.dispatchNotification(obj.method, obj.params);
        return;
      }
      this.dispatchResponse(obj as unknown as JsonRpcSuccessResponse | JsonRpcErrorResponse);
      return;
    }
    if (typeof obj.method === "string") {
      this.dispatchNotification(obj.method, obj.params);
      return;
    }
    logger.debug(`unrouted JSON-RPC payload: ${line.slice(0, 200)}`);
  }

  private dispatchResponse(payload: JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    const id = typeof payload.id === "number" ? payload.id : Number(payload.id);
    if (!Number.isFinite(id)) {
      logger.debug(`response with non-numeric id ignored: ${JSON.stringify(payload.id)}`);
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      logger.debug(`response for unknown request id=${id}`);
      return;
    }
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if ("error" in payload && payload.error) {
      const { code, message, data } = payload.error;
      pending.reject(new CodexAppServerRpcError(code, message, data));
      return;
    }
    pending.resolve((payload as JsonRpcSuccessResponse).result);
  }

  private dispatchNotification(method: string, params: unknown): void {
    const handlers = this.notificationHandlers.get(method);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(params, method);
        } catch (err) {
          logger.warn(`notification handler for ${method} threw: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    for (const handler of this.anyNotificationHandlers) {
      try {
        handler(params, method);
      } catch (err) {
        logger.warn(`global notification handler threw: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /**
   * Subscribe to a JSON-RPC notification method. Returns an unsubscribe
   * function. Pass `"*"` to subscribe to all notifications.
   */
  onNotification(method: string, handler: NotificationHandler): () => void {
    if (method === "*") {
      this.anyNotificationHandlers.add(handler);
      return () => this.anyNotificationHandlers.delete(handler);
    }
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => {
      const current = this.notificationHandlers.get(method);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.notificationHandlers.delete(method);
      }
    };
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /**
   * Issue a JSON-RPC request and resolve with the `result` field.
   */
  async request<TParams = unknown, TResult = unknown>(
    method: string,
    params: TParams,
    options?: { timeoutMs?: number },
  ): Promise<TResult> {
    if (!this.handle) {
      throw new Error("CodexAppServerClient: not started");
    }
    if (this.closed) {
      throw new CodexAppServerRpcClosedError(null, "client is closed");
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest<TParams> = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    const line = `${JSON.stringify(payload)}\n`;
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;

    return await new Promise<TResult>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve: (value) => resolve(value as TResult),
        reject,
        timer: null,
      };
      if (timeoutMs && timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(
            new CodexAppServerRpcError(
              -32099,
              `codex app-server request "${method}" timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
      }
      this.pending.set(id, pending);
      try {
        const ok = this.handle!.stdin.write(line);
        if (!ok) {
          // Keep going; the stream will drain. We don't need to wait here for
          // backpressure because notifications and responses are independent.
        }
      } catch (err) {
        this.pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Fire-and-forget JSON-RPC notification.
   */
  notify<TParams = unknown>(method: string, params: TParams): void {
    if (!this.handle) {
      throw new Error("CodexAppServerClient: not started");
    }
    if (this.closed) {
      throw new CodexAppServerRpcClosedError(null, "client is closed");
    }
    const payload: JsonRpcNotification<TParams> = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.handle.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /**
   * Gracefully close the daemon: end stdin, give it a grace period, then send
   * SIGTERM/SIGKILL.
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (!this.handle) {
      return;
    }
    try {
      this.handle.stdin.end();
    } catch (err) {
      logger.debug(`stdin.end failed: ${err instanceof Error ? err.message : err}`);
    }
    if (this.child) {
      const exited = await Promise.race([
        this.handle.waitClose ? this.handle.waitClose() : Promise.resolve<number | null>(null),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1500)),
      ]);
      if (exited === "timeout") {
        try {
          this.child.kill("SIGTERM");
        } catch {
          // ignore
        }
        const exited2 = await Promise.race([
          this.handle.waitClose ? this.handle.waitClose() : Promise.resolve<number | null>(null),
          new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1500)),
        ]);
        if (exited2 === "timeout") {
          try {
            this.child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
      }
    }
    this.handleClose(null);
  }

  private handleClose(code: number | null, _err?: Error): void {
    if (this.closeReported) {
      return;
    }
    this.closeReported = true;
    this.closed = true;
    const closeError = new CodexAppServerRpcClosedError(code);
    for (const [id, pending] of this.pending.entries()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(closeError);
      this.pending.delete(id);
    }
    for (const handler of this.closeHandlers) {
      try {
        handler(code);
      } catch (err) {
        logger.warn(`close handler threw: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  /** Internal: exposed for adapter use. Indicates whether the client is alive. */
  isClosed(): boolean {
    return this.closed;
  }
}
