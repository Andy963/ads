import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createPromptStatusReporter,
  formatThinkingStatus,
} from "../src/promptStatus.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Telegram prompt status", () => {
  it("formats an animated thinking indicator", () => {
    assert.equal(formatThinkingStatus(0), "thinking");
    assert.equal(formatThinkingStatus(1), "thinking.");
    assert.equal(formatThinkingStatus(2), "thinking..");
    assert.equal(formatThinkingStatus(3), "thinking...");
    assert.equal(formatThinkingStatus(4), "thinking");
  });

  it("sends an immediate thinking status, animates dots, and deletes it on completion", async () => {
    const sent: string[] = [];
    const edits: Array<{ messageId: number; text: string }> = [];
    const deletions: number[] = [];
    let typingCount = 0;
    const reporter = createPromptStatusReporter({
      sendMessage: async (text) => {
        sent.push(text);
        return 42;
      },
      editMessage: async (messageId, text) => {
        edits.push({ messageId, text });
      },
      deleteMessage: async (messageId) => {
        deletions.push(messageId);
      },
      sendTyping: async () => {
        typingCount += 1;
      },
    }, {
      typingIntervalMs: 20,
      thinkingIntervalMs: 20,
    });

    await reporter.start();
    assert.deepEqual(sent, ["thinking"]);
    assert.equal(typingCount, 1);

    await delay(80);
    assert.ok(typingCount >= 2);
    assert.ok(edits.some((edit) => edit.messageId === 42 && edit.text === "thinking."));
    assert.ok(edits.every((edit) => /^thinking\.{0,3}$/.test(edit.text)));

    await reporter.complete();
    assert.deepEqual(deletions, [42]);

    const editsAfterComplete = edits.length;
    const deletionsAfterComplete = deletions.length;
    await delay(60);
    assert.equal(edits.length, editsAfterComplete);
    assert.equal(deletions.length, deletionsAfterComplete);
    reporter.stop();
  });

  it("deletes the status when a turn fails", async () => {
    const deletions: number[] = [];
    const reporter = createPromptStatusReporter({
      sendMessage: async () => 7,
      editMessage: async () => undefined,
      deleteMessage: async (messageId) => {
        deletions.push(messageId);
      },
      sendTyping: async () => undefined,
    }, { typingIntervalMs: 20, thinkingIntervalMs: 20 });

    await reporter.start();
    await reporter.fail();
    assert.deepEqual(deletions, [7]);
    reporter.stop();
  });

  it("tolerates Telegram API failures", async () => {
    const failing = createPromptStatusReporter({
      sendMessage: async () => {
        throw new Error("send failed");
      },
      editMessage: async () => {
        throw new Error("edit failed");
      },
      deleteMessage: async () => {
        throw new Error("delete failed");
      },
      sendTyping: async () => {
        throw new Error("typing failed");
      },
    }, { typingIntervalMs: 20, thinkingIntervalMs: 20 });
    await failing.start();
    await failing.complete();
    failing.stop();
  });
});
