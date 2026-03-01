import { describe, expect, it, vi } from "vitest";

import { createExecuteActions } from "../app/chatExecute";

describe("ingestCommand deduping", () => {
  it("dedups by (id, command) so a reused id still counts distinct commands", () => {
    const rt = { seenCommandIds: new Set<string>() } as any;
    const pushRecentCommand = vi.fn();

    const actions = createExecuteActions({
      runtimeOrActive: () => rt,
      setMessages: () => {},
      pushRecentCommand,
      randomId: () => "id",
      maxExecutePreviewLines: 8,
      maxTurnCommands: 64,
      isLiveMessageId: () => false,
      findFirstLiveIndex: () => -1,
      findLastLiveIndex: () => -1,
    });

    actions.ingestCommand("cmd-1", rt, "c-1");
    actions.ingestCommand("cmd-1", rt, "c-1");
    actions.ingestCommand("cmd-2", rt, "c-1");
    actions.ingestCommand("cmd-2", rt, "c-1");

    expect(pushRecentCommand.mock.calls.map((c) => c[0])).toEqual(["cmd-1", "cmd-2"]);
  });

  it("does not dedup when id is missing", () => {
    const rt = { seenCommandIds: new Set<string>() } as any;
    const pushRecentCommand = vi.fn();

    const actions = createExecuteActions({
      runtimeOrActive: () => rt,
      setMessages: () => {},
      pushRecentCommand,
      randomId: () => "id",
      maxExecutePreviewLines: 8,
      maxTurnCommands: 64,
      isLiveMessageId: () => false,
      findFirstLiveIndex: () => -1,
      findLastLiveIndex: () => -1,
    });

    actions.ingestCommand("cmd", rt, null);
    actions.ingestCommand("cmd", rt, null);

    expect(pushRecentCommand).toHaveBeenCalledTimes(2);
  });
});

