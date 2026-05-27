import { CodexAppServerClient, type CodexAppServerSpawnOptions } from "./rpcClient.js";
import { createLogger } from "../../utils/logger.js";

const logger = createLogger("CodexAppServerRegistry");

export interface DaemonOptions extends CodexAppServerSpawnOptions {
  /** Working directory for the daemon. Drives `cwd` of the spawned process. */
  workingDirectory?: string;
}

interface RegistryEntry {
  projectId: string;
  options: DaemonOptions;
  /** Resolves to a ready client. Reuses an in-flight start promise. */
  ready: Promise<CodexAppServerClient>;
  /** Snapshot of options used to start the active client. */
  client?: CodexAppServerClient;
}

function optionsEqual(a: DaemonOptions, b: DaemonOptions): boolean {
  if ((a.workingDirectory ?? null) !== (b.workingDirectory ?? null)) return false;
  if ((a.binary ?? null) !== (b.binary ?? null)) return false;
  const envA = a.env ?? {};
  const envB = b.env ?? {};
  const keysA = Object.keys(envA);
  const keysB = Object.keys(envB);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (envA[key] !== envB[key]) return false;
  }
  const ga = JSON.stringify(a.globalArgs ?? []);
  const gb = JSON.stringify(b.globalArgs ?? []);
  if (ga !== gb) return false;
  const ad = JSON.stringify(a.appServerArgs ?? []);
  const bd = JSON.stringify(b.appServerArgs ?? []);
  if (ad !== bd) return false;
  return true;
}

/**
 * Tracks a long-lived `codex app-server` daemon per project. Concurrent calls
 * for the same project share the same start promise; daemons that close
 * unexpectedly are dropped so the next `getOrStart` spawns a fresh one.
 *
 * Tests can override the client factory to construct in-memory `PassThrough`
 * clients instead of spawning the real binary.
 */
export class CodexAppServerDaemonRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly factory: (options: DaemonOptions) => CodexAppServerClient;

  constructor(options?: { factory?: (options: DaemonOptions) => CodexAppServerClient }) {
    this.factory =
      options?.factory ??
      ((opts) =>
        new CodexAppServerClient({
          binary: opts.binary,
          globalArgs: opts.globalArgs,
          appServerArgs: opts.appServerArgs,
          cwd: opts.workingDirectory,
          env: opts.env,
          defaultRequestTimeoutMs: opts.defaultRequestTimeoutMs,
        }));
  }

  /**
   * Return a ready client for the given project. Starts a new daemon if none
   * is running. If `options` differ from the active daemon's options (cwd,
   * env, binary), the previous daemon is stopped and a fresh one is started.
   */
  async getOrStart(projectId: string, options: DaemonOptions = {}): Promise<CodexAppServerClient> {
    const existing = this.entries.get(projectId);
    if (existing) {
      if (existing.client?.isClosed()) {
        this.entries.delete(projectId);
      } else if (!optionsEqual(existing.options, options)) {
        logger.info(`daemon options changed for project=${projectId}; restarting`);
        await this.stop(projectId);
      } else {
        return existing.ready;
      }
    }

    return this.spawn(projectId, options);
  }

  private spawn(projectId: string, options: DaemonOptions): Promise<CodexAppServerClient> {
    const client = this.factory(options);
    const ready = (async () => {
      await client.start();
      return client;
    })();
    const entry: RegistryEntry = {
      projectId,
      options,
      ready,
      client,
    };
    this.entries.set(projectId, entry);
    client.onClose((code) => {
      logger.info(`daemon for project=${projectId} closed (exit=${code ?? "null"})`);
      const current = this.entries.get(projectId);
      if (current && current.client === client) {
        this.entries.delete(projectId);
      }
    });
    ready.catch((err) => {
      logger.warn(
        `failed to start daemon for project=${projectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      const current = this.entries.get(projectId);
      if (current && current.ready === ready) {
        this.entries.delete(projectId);
      }
    });
    return ready;
  }

  /** Stop and remove the daemon for the given project, if any. */
  async stop(projectId: string): Promise<void> {
    const entry = this.entries.get(projectId);
    if (!entry) return;
    this.entries.delete(projectId);
    try {
      const client = await entry.ready.catch(() => entry.client);
      if (client) {
        await client.close();
      }
    } catch (err) {
      logger.debug(
        `error stopping daemon for project=${projectId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /** Stop every daemon (intended for server shutdown). */
  async stopAll(): Promise<void> {
    const ids = Array.from(this.entries.keys());
    await Promise.all(ids.map((id) => this.stop(id)));
  }

  /** Number of currently tracked daemons. */
  size(): number {
    return this.entries.size;
  }

  has(projectId: string): boolean {
    return this.entries.has(projectId);
  }
}

/**
 * Shared module-level registry used by adapters. Tests can construct their
 * own registry instance to keep state isolated.
 */
let sharedRegistry: CodexAppServerDaemonRegistry | null = null;

export function getSharedDaemonRegistry(): CodexAppServerDaemonRegistry {
  if (!sharedRegistry) {
    sharedRegistry = new CodexAppServerDaemonRegistry();
  }
  return sharedRegistry;
}

/** For tests only. */
export function __resetSharedDaemonRegistryForTests(): void {
  sharedRegistry = null;
}
