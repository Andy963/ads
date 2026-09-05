import { createHash } from "node:crypto";

import type { SyncEventStore } from "./store.js";

export const COMMAND_SNAPSHOT_EVENT_TYPE = "command_snapshot";
export const COMMAND_SNAPSHOT_MAX_CHARS = 200_000;

type CommandFrame = {
  type: "command";
  ts?: unknown;
  command?: {
    id?: unknown;
    identity?: unknown;
    command?: unknown;
    status?: unknown;
    exit_code?: unknown;
    outputDelta?: unknown;
    outputStartOffset?: unknown;
    outputEndOffset?: unknown;
  };
};

export type CommandSnapshotPosition = {
  eventId: string;
  identity: string;
  startOffset: number;
  endOffset: number;
  snapshotSeq: number | null;
  revision: number;
  terminal: boolean;
};

type SnapshotRow = {
  seq: number;
  eventId?: string;
  revision: number;
  payload: Record<string, unknown>;
  ts: number;
};

type ActiveCommand = {
  eventId: string;
  identity: string;
  id: string;
  command: string;
  output: string;
  startOffset: number;
  endOffset: number;
  revision: number;
  startedAt: number;
  status?: string;
  exitCode?: number;
  terminal: boolean;
  snapshotSeq: number | null;
  legacyKey: string;
};

type LegacyTrack = {
  identity: string;
  terminal: boolean;
  sawOutput: boolean;
  endOffset: number;
  lastOutput: string;
};

type SnapshotStore = Pick<SyncEventStore, "appendCoalesced" | "deleteCoalesced"> & {
  readCoalesced?: (args: { namespace: string; laneKey: string; type?: string }) => SnapshotRow[];
  deleteCoalescedByType?: (args: { namespace: string; laneKey: string; type: string }) => void;
};

function normalizeTimestamp(value: unknown, fallback: () => number): number {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? Math.floor(timestamp) : fallback();
}

function isTerminalStatus(value: unknown): boolean {
  const status = String(value ?? "").trim().toLowerCase();
  return status === "completed" || status === "failed" || status === "declined" || status === "cancelled";
}

function commandEventId(identity: string): string {
  return `active-command:${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

function commandIdentitySuffix(command: string): string {
  return createHash("sha256").update(command).digest("hex").slice(0, 12);
}

function readOffset(value: unknown): number | null {
  const offset = Number(value);
  return Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : null;
}

function commandFromPayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  const command = payload.command;
  return command && typeof command === "object" && !Array.isArray(command)
    ? (command as Record<string, unknown>)
    : null;
}

function hasCommandHeader(outputDelta: string, commandLine: string): boolean {
  const normalized = String(outputDelta ?? "").replace(/^\s+/, "");
  return normalized.startsWith(`$ ${commandLine}\n`) || normalized.startsWith(`$ ${commandLine}\r\n`);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Coalesces command output into one durable runtime row per command identity.
 *
 * Rows survive individual command completion and are removed only after the
 * enclosing result/error. This lets a reconnect restore every command block
 * from one still-running turn. Identity handling differs deliberately for
 * modern and legacy producers:
 *
 * - an explicit identity is authoritative;
 * - an id plus command is stable, while the same id with another command gets
 *   a deterministic suffix;
 * - id-less commands get a new identity after a terminal instance, a command
 *   header, or an output-offset rollback.
 */
export function createCommandSnapshotCoalescer(args: {
  store: SnapshotStore;
  namespace: string;
  laneKey: string;
  now?: () => number;
  hydrate?: boolean;
}) {
  const now = args.now ?? (() => Date.now());
  const active = new Map<string, ActiveCommand>();
  const legacyTracks = new Map<string, LegacyTrack>();
  const explicitIdentities = new Map<string, string>();
  let anonymousCounter = 0;
  let hydrated = false;

  const hydrate = (): void => {
    if (hydrated || !args.hydrate || !args.store.readCoalesced) return;
    hydrated = true;
    for (const row of args.store.readCoalesced({
      namespace: args.namespace,
      laneKey: args.laneKey,
      type: COMMAND_SNAPSHOT_EVENT_TYPE,
    })) {
      const command = commandFromPayload(row.payload);
      if (row.payload.active === false || command === null) continue;
      const identity = String(command.identity ?? command.id ?? "").trim();
      const commandLine = String(command.command ?? "").trim();
      if (!identity || !commandLine) continue;
      const output = String(command.output ?? "").slice(-COMMAND_SNAPSHOT_MAX_CHARS);
      const endOffset = readOffset(command.endOffset) ?? output.length;
      const startOffset = readOffset(command.startOffset) ?? Math.max(0, endOffset - output.length);
      const id = String(command.id ?? "").trim();
      const status = String(command.status ?? "").trim() || undefined;
      const terminal = isTerminalStatus(status);
      const eventId = String(row.eventId ?? commandEventId(identity)).trim() || commandEventId(identity);
      const entry: ActiveCommand = {
        eventId,
        identity,
        id,
        command: commandLine,
        output,
        startOffset,
        endOffset,
        revision: Math.max(1, Math.floor(Number(command.revision) || row.revision || 1)),
        startedAt: normalizeTimestamp(command.ts, () => row.ts || now()),
        status,
        exitCode: isFiniteNumber(command.exit_code) ? command.exit_code : undefined,
        terminal,
        snapshotSeq: Number.isFinite(row.seq) && row.seq > 0 ? Math.floor(row.seq) : null,
        legacyKey: `${id}\u0000${commandLine}`,
      };
      active.set(identity, entry);
      legacyTracks.set(entry.legacyKey, {
        identity,
        terminal,
        sawOutput: Boolean(output),
        endOffset,
        lastOutput: output,
      });
      if (id) explicitIdentities.set(entry.legacyKey, identity);
    }
  };

  hydrate();

  const resolveExplicitIdentity = (payload: Record<string, unknown>, commandLine: string): string | null => {
    const explicit = String(payload.identity ?? "").trim();
    if (explicit) return explicit;

    const id = String(payload.id ?? "").trim();
    if (!id) return null;
    const key = `${id}\u0000${commandLine}`;
    const known = explicitIdentities.get(key);
    if (known) return known;

    // Preserve the first id verbatim for compatibility. A reused id with a
    // different command receives a deterministic identity and cannot overwrite
    // the first command's output.
    const sameId = [...explicitIdentities.entries()].find(([entryKey]) => entryKey.startsWith(`${id}\u0000`));
    const identity = sameId ? `${id}:${commandIdentitySuffix(commandLine)}` : id;
    explicitIdentities.set(key, identity);
    return identity;
  };

  const resolveLegacyIdentity = (
    commandLine: string,
    outputDelta: string,
    startOffset: number | null,
    endOffset: number | null,
    terminal: boolean,
  ): string => {
    const legacyKey = `\u0000${commandLine}`;
    const previous = legacyTracks.get(legacyKey);
    const header = hasCommandHeader(outputDelta, commandLine);
    const offsetRollback = startOffset !== null && previous !== undefined && startOffset < previous.endOffset;
    const duplicateTerminal = Boolean(
      previous?.terminal && terminal &&
      (outputDelta === "" || outputDelta === previous.lastOutput || (endOffset !== null && endOffset <= previous.endOffset)),
    );
    const startsNew = Boolean(
      !previous ||
      (!duplicateTerminal && previous.terminal) ||
      (!duplicateTerminal && offsetRollback) ||
      (!duplicateTerminal && header && (previous.sawOutput || previous.terminal)),
    );
    if (!startsNew && previous) return previous.identity;
    const identity = `anonymous-command-${++anonymousCounter}`;
    legacyTracks.set(legacyKey, {
      identity,
      terminal: false,
      sawOutput: false,
      endOffset: 0,
      lastOutput: "",
    });
    return identity;
  };

  const record = (frame: CommandFrame): CommandSnapshotPosition | null => {
    const payload = frame.command;
    const commandLine = String(payload?.command ?? "").trim();
    if (!commandLine) return null;

    const outputDelta = String(payload?.outputDelta ?? "");
    const explicitStart = readOffset(payload?.outputStartOffset);
    const explicitEnd = readOffset(payload?.outputEndOffset);
    const terminal = isTerminalStatus(payload?.status);
    const id = String(payload?.id ?? "").trim();
    const explicitIdentity = resolveExplicitIdentity((payload ?? {}) as Record<string, unknown>, commandLine);
    const identity = explicitIdentity ?? resolveLegacyIdentity(commandLine, outputDelta, explicitStart, explicitEnd, terminal);
    const legacyKey = `${id}\u0000${commandLine}`;
    const timestamp = normalizeTimestamp(frame.ts, now);
    const existing = active.get(identity);
    const entry: ActiveCommand = existing ?? {
      eventId: commandEventId(identity),
      identity,
      id,
      command: commandLine,
      output: "",
      startOffset: explicitStart ?? 0,
      endOffset: explicitStart ?? 0,
      revision: 0,
      startedAt: timestamp,
      terminal: false,
      snapshotSeq: null,
      legacyKey,
    };

    let changed = !existing;
    const previousEnd = entry.endOffset;
    let appendable = outputDelta;
    if (explicitStart !== null) {
      const overlap = Math.max(0, previousEnd - explicitStart);
      if (explicitEnd !== null && explicitEnd <= previousEnd) {
        appendable = "";
      } else if (overlap > 0) {
        appendable = outputDelta.slice(Math.min(outputDelta.length, overlap));
      }
    } else if (appendable) {
      // Legacy producers sometimes send cumulative output. Avoid appending the
      // same prefix twice while still accepting ordinary output deltas.
      if (entry.output === appendable || entry.output.endsWith(appendable)) {
        appendable = "";
      } else if (appendable.startsWith(entry.output) && entry.output.length > 0) {
        appendable = appendable.slice(entry.output.length);
      }
    }

    if (appendable) {
      const appendStart = explicitStart ?? entry.endOffset;
      if (entry.output.length === 0) entry.startOffset = Math.max(0, appendStart);
      entry.output = `${entry.output}${appendable}`.slice(-COMMAND_SNAPSHOT_MAX_CHARS);
      entry.endOffset = explicitEnd ?? appendStart + outputDelta.length;
      entry.startOffset = Math.max(0, entry.endOffset - entry.output.length);
      changed = true;
    } else if (explicitEnd !== null && explicitEnd > entry.endOffset) {
      entry.endOffset = explicitEnd;
      entry.startOffset = Math.max(0, entry.endOffset - entry.output.length);
      changed = true;
    }

    const nextStatus = String(payload?.status ?? "").trim();
    if (nextStatus && nextStatus !== entry.status) {
      entry.status = nextStatus;
      changed = true;
    }
    if (isFiniteNumber(payload?.exit_code) && payload.exit_code !== entry.exitCode) {
      entry.exitCode = payload.exit_code;
      changed = true;
    }
    if (terminal && !entry.terminal) {
      entry.terminal = true;
      changed = true;
    }

    if (!changed && existing) {
      const track = legacyTracks.get(legacyKey);
      if (track) {
        track.terminal = entry.terminal;
        track.endOffset = entry.endOffset;
        track.lastOutput = outputDelta || track.lastOutput;
      }
      return {
        eventId: entry.eventId,
        identity: entry.identity,
        startOffset: explicitStart ?? entry.endOffset,
        endOffset: explicitEnd ?? entry.endOffset,
        snapshotSeq: entry.snapshotSeq,
        revision: entry.revision,
        terminal,
      };
    }

    entry.revision = Math.max(1, entry.revision + 1);
    active.set(identity, entry);
    legacyTracks.set(legacyKey, {
      identity,
      terminal: entry.terminal,
      sawOutput: Boolean(entry.output),
      endOffset: entry.endOffset,
      lastOutput: outputDelta || entry.output,
    });
    if (id) explicitIdentities.set(legacyKey, identity);

    const snapshotSeq = args.store.appendCoalesced({
      namespace: args.namespace,
      laneKey: args.laneKey,
      type: COMMAND_SNAPSHOT_EVENT_TYPE,
      eventId: entry.eventId,
      revision: entry.revision,
      payload: {
        type: COMMAND_SNAPSHOT_EVENT_TYPE,
        active: true,
        ts: entry.startedAt,
        eventId: entry.eventId,
        snapshotSeq: entry.snapshotSeq,
        command: {
          id: entry.id,
          identity: entry.identity,
          command: entry.command,
          status: entry.status,
          exit_code: entry.exitCode,
          output: entry.output,
          startOffset: entry.startOffset,
          endOffset: entry.endOffset,
          revision: entry.revision,
        },
      },
      ts: timestamp,
    });
    if (snapshotSeq !== null) entry.snapshotSeq = snapshotSeq;
    return {
      eventId: entry.eventId,
      identity: entry.identity,
      startOffset: explicitStart ?? previousEnd,
      endOffset: explicitEnd ?? entry.endOffset,
      snapshotSeq: entry.snapshotSeq,
      revision: entry.revision,
      terminal,
    };
  };

  const finish = (): void => {
    if (args.store.deleteCoalescedByType) {
      args.store.deleteCoalescedByType({
        namespace: args.namespace,
        laneKey: args.laneKey,
        type: COMMAND_SNAPSHOT_EVENT_TYPE,
      });
    } else {
      for (const entry of active.values()) {
        args.store.deleteCoalesced({
          namespace: args.namespace,
          laneKey: args.laneKey,
          type: COMMAND_SNAPSHOT_EVENT_TYPE,
          eventId: entry.eventId,
        });
      }
    }
    active.clear();
    legacyTracks.clear();
    explicitIdentities.clear();
    hydrated = true;
  };

  const getSnapshots = (): Array<Record<string, unknown>> => {
    hydrate();
    return [...active.values()].map((entry) => ({
      type: COMMAND_SNAPSHOT_EVENT_TYPE,
      eventId: entry.eventId,
      snapshotSeq: entry.snapshotSeq,
      revision: entry.revision,
      active: true,
      afterSeq: entry.snapshotSeq ?? 0,
      ts: entry.startedAt,
      command: {
        id: entry.id,
        identity: entry.identity,
        command: entry.command,
        status: entry.status,
        exit_code: entry.exitCode,
        output: entry.output,
        startOffset: entry.startOffset,
        endOffset: entry.endOffset,
        revision: entry.revision,
      },
    }));
  };

  return {
    record,
    finish,
    getActiveCount: () => active.size,
    getSnapshots,
  };
}
