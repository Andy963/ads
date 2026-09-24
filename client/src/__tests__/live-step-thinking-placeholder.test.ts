import { describe, expect, it } from "vitest";

import { createAppContext } from "../app/controller";
import type { ChatItem, ProjectRuntime } from "../app/controller";
import { createChatActions } from "../app/chat";

function createHarness(initial: ChatItem[]) {
  const ctx = createAppContext();
  const chat = createChatActions(ctx);
  const rt: ProjectRuntime = ctx.activeRuntime.value;
  rt.messages.value = initial;
  return { rt, chat };
}

describe("legacy live-step compatibility", () => {
  it("keeps an already-persisted live-step card readable", () => {
    const { rt, chat } = createHarness([
      { id: "u-1", role: "user", kind: "text", content: "fix the bug", ts: 1 },
      { id: "live-step", role: "assistant", kind: "text", content: "Legacy progress", streaming: false, ts: 2 },
    ]);

    chat.upsertStreamingDelta("All checks pass.", rt);
    chat.clearStepLive(rt);

    expect(rt.messages.value.find((message) => message.id === "live-step")?.content).toBe("Legacy progress");
    expect(rt.messages.value.some((message) => message.id === "live-activity")).toBe(false);
    expect(rt.messages.value.some((message) => message.kind === "thought")).toBe(false);
    expect(rt.messages.value.some((message) => message.content === "All checks pass.")).toBe(true);
  });
});
