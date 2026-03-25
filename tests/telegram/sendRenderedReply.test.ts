import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { sendRenderedTelegramReply } from "../../server/telegram/adapters/codex/sendRenderedReply.js";

describe("telegram/sendRenderedReply", () => {
  it("falls back to plain text without sending an extra warning message", async () => {
    const delivered: Array<{ text: string; options: Record<string, unknown> }> = [];
    const warnings: string[] = [];
    const fallbackRecords: Array<{ stage: string; original: string; escaped: string }> = [];

    const ctx = {
      reply: async (text: string, options: Record<string, unknown>) => {
        if (options.parse_mode === "MarkdownV2") {
          throw new Error("parse failed");
        }
        delivered.push({ text, options });
        return { message_id: delivered.length };
      },
    } as any;

    await sendRenderedTelegramReply({
      ctx,
      text: "当前没有。A (b). c",
      silentNotifications: true,
      replyOptions: { reply_parameters: { message_id: 123 } },
      logWarning: (message) => warnings.push(message),
      recordFallback: (stage, original, escaped) => fallbackRecords.push({ stage, original, escaped }),
    });

    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]?.text, "当前没有。A (b). c");
    assert.deepEqual(delivered[0]?.options.reply_parameters, { message_id: 123 });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /Failed to send MarkdownV2 chunk/);
    assert.equal(fallbackRecords.length, 1);
  });
});
