const FRAME_FIELDS = [
  "type", "ts", "seq", "eventId", "event_id", "snapshotSeq", "revision",
  "active", "afterSeq", "bootstrap", "runId", "kind", "ok",
  "clientMessageId", "client_message_id", "sessionId", "chatSessionId", "laneGeneration",
] as const;

const COMMAND_FIELDS = [
  "id", "identity", "command", "status", "exit_code", "revision",
  "startOffset", "endOffset", "outputStartOffset", "outputEndOffset",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function pickFields(record: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(record, field)).map((field) => [field, record[field]]));
}

export function stripCommandHistoryOutput(text: string, kind?: string): string {
  if (String(kind ?? "").trim().toLowerCase() !== "execute") return text;
  return text.split(/\r\n|\r|\n/, 1)[0] ?? "";
}

export function projectCommandFrame(payload: unknown): unknown {
  const frame = asRecord(payload);
  if (!frame) return payload;

  if (frame.type === "command" || frame.type === "command_snapshot") {
    const command = asRecord(frame.command);
    return {
      ...pickFields(frame, FRAME_FIELDS),
      ...(command ? { command: pickFields(command, COMMAND_FIELDS) } : {}),
    };
  }

  if (frame.type === "result" && frame.kind === "execute") {
    return { ...pickFields(frame, FRAME_FIELDS), command: frame.command };
  }

  if (frame.type === "history" && Array.isArray(frame.items)) {
    return {
      ...frame,
      items: frame.items.map((item) => {
        const entry = asRecord(item);
        if (!entry || typeof entry.text !== "string") return item;
        const text = stripCommandHistoryOutput(entry.text, String(entry.kind ?? ""));
        return text === entry.text ? item : { ...entry, text };
      }),
    };
  }

  return payload;
}
