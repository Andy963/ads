import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createPromptStatusReporter,
  formatElapsed,
  formatPromptStatus,
} from "../src/promptStatus.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Telegram prompt status", () => {
  it("formats elapsed time for short and long turns", () => {
    assert.equal(formatElapsed(0), "0s");
    assert.equal(formatElapsed(12_900), "12s");
    assert.equal(formatElapsed(65_000), "1m 05s");
    assert.equal(formatElapsed(3_725_000), "1h 02m");
  });

  it("formats each lifecycle state", () => {
    assert.equal(formatPromptStatus("starting", 0), "Received. Working on it...");
    assert.equal(formatPromptStatus("running", 12_000), "Working... 12s elapsed.");
    assert.equal(formatPromptStatus("completed", 65_000), "Completed in 1m 05s.");
    assert.equal(formatPromptStatus("failed", 8_000), "Stopped after 8s.");
  });

  it("sends an immediate status, refreshes typing, and finalizes once", async () => {
    let now = 0;
    const sent: string[] = [];
    const edits: Array<{ messageId: number; text: string }> = [];
    let typingCount = 0;
    const reporter = createPromptStatusReporter({
      sendMessage: async (text) => {
        sent.push(text);
        return 42;
      },
      editMessage: async (messageId, text) => {
        edits.push({ messageId, text });
      },
      sendTyping: async () => {
        typingCount += 1;
      },
    }, {
      now: () => now,
      typingIntervalMs: 20,
      updateIntervalMs: 30,
    });

    await reporter.start();
    assert.deepEqual(sent, ["Received. Working on it..."]);
    assert.equal(typingCount, 1);

    now = 5_000;
    await delay(80);
    assert.ok(typingCount >= 2);
    assert.ok(edits.some((edit) => edit.messageId === 42 && edit.text === "Working... 5s elapsed."));

    now = 65_000;
    await reporter.complete();
    assert.equal(edits.at(-1)?.messageId, 42);
    assert.equal(edits.at(-1)?.text, "Completed in 1m 05s.");

    const editsAfterComplete = edits.length;
    await delay(60);
    assert.equal(edits.length, editsAfterComplete);
    reporter.stop();
  });

  it("marks failed turns and tolerates Telegram API failures", async () => {
    let now = 0;
    const edits: string[] = [];
    const reporter = createPromptStatusReporter({
      sendMessage: async () => 7,
      editMessage: async (_messageId, text) => {
        edits.push(text);
      },
      sendTyping: async () => undefined,
    }, { now: () => now, typingIntervalMs: 20, updateIntervalMs: 30 });

    await reporter.start();
    now = 8_000;
    await reporter.fail();
    assert.equal(edits.at(-1), "Stopped after 8s.");

    const failing = createPromptStatusReporter({
      sendMessage: async () => {
        throw new Error("send failed");
      },
      editMessage: async () => {
        throw new Error("edit failed");
      },
      sendTyping: async () => {
        throw new Error("typing failed");
      },
    }, { typingIntervalMs: 20, updateIntervalMs: 30 });
    await failing.start();
    await failing.complete();
    failing.stop();
  });
});
