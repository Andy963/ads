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

describe("live-step progress contract", () => {
  it("replaces the blank thinking placeholder with the live-step card on the first step delta", () => {
    const { rt, chat } = createHarness([
      { id: "u-1", role: "user", kind: "text", content: "fix the bug", ts: 1 },
      { id: "placeholder-1", role: "assistant", kind: "text", content: "", streaming: true, ts: 2 },
    ]);

    chat.upsertStepLiveDelta("Inspecting the failing test first.", rt);

    expect(rt.messages.value.some((message) => message.id === "placeholder-1")).toBe(false);
    const liveStep = rt.messages.value.find((message) => message.id === "live-step");
    expect(liveStep?.content).toBe("Inspecting the failing test first.");
    expect(liveStep?.streaming).toBe(true);
    expect(rt.messages.value.map((message) => message.id)).toEqual(["u-1", "live-step"]);
  });

  it("keeps the live-step card as the newest snapshot and clears it with live activity on turn completion", () => {
    const { rt, chat } = createHarness([
      { id: "u-1", role: "user", kind: "text", content: "fix the bug", ts: 1 },
      { id: "placeholder-1", role: "assistant", kind: "text", content: "", streaming: true, ts: 2 },
    ]);

    chat.upsertStepLiveDelta("Inspecting the failing test first.", rt);
    chat.upsertStepLiveDelta("Then running the checks.", rt);

    const liveSteps = rt.messages.value.filter((message) => message.id === "live-step");
    expect(liveSteps).toHaveLength(1);
    expect(liveSteps[0]?.content).toBe("Then running the checks.");

    chat.upsertStreamingDelta("All checks pass.", rt);
    chat.clearStepLive(rt);

    expect(rt.messages.value.some((message) => message.id === "live-step")).toBe(false);
    expect(rt.messages.value.some((message) => message.id === "live-activity")).toBe(false);
    expect(rt.messages.value.some((message) => message.kind === "thought")).toBe(false);
    expect(rt.messages.value.some((message) => message.content === "All checks pass.")).toBe(true);
  });
});
