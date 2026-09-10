import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectCommandFrame } from "../../server/web/server/commandPresentation.js";

describe("web/commandPresentation", () => {
  for (const type of ["command", "command_snapshot"]) {
    it(`projects ${type} to command metadata without mutating the source`, () => {
      const frame = {
        type,
        ts: 100,
        seq: 12,
        afterSeq: 10,
        bootstrap: true,
        clientMessageId: "turn-1",
        detail: "private command detail",
        output: "private top-level output",
        command: {
          id: "cmd-1",
          identity: "cmd-1",
          command: "npm test",
          status: "failed",
          exit_code: 1,
          revision: 3,
          output: "private snapshot output",
          outputDelta: "private delta",
          aggregated_output: "private aggregated output",
          stdout: "private stdout",
          stderr: "private stderr",
          raw: { output: "private raw output" },
        },
      };
      const original = structuredClone(frame);

      assert.deepEqual(projectCommandFrame(frame), {
        type,
        ts: 100,
        seq: 12,
        afterSeq: 10,
        bootstrap: true,
        clientMessageId: "turn-1",
        command: {
          id: "cmd-1",
          identity: "cmd-1",
          command: "npm test",
          status: "failed",
          exit_code: 1,
          revision: 3,
        },
      });
      assert.deepEqual(frame, original);
    });
  }

  it("strips legacy execute results but leaves assistant results unchanged", () => {
    const commandResult = { type: "result", kind: "execute", ok: false, command: "npm test", output: "private failure" };
    assert.deepEqual(projectCommandFrame(commandResult), {
      type: "result", kind: "execute", ok: false, command: "npm test",
    });
    const assistantResult = { type: "result", ok: true, output: "Assistant summary" };
    assert.equal(projectCommandFrame(assistantResult), assistantResult);
  });

  it("strips legacy history output without changing conversation text", () => {
    const frame = {
      type: "history",
      items: [
        { role: "status", kind: "execute", text: "$ npm test\r\nprivate output\r\nprivate error", ts: 1 },
        { role: "user", text: "First line\nSecond line", ts: 2 },
        { role: "ai", text: "Assistant summary\nMore details", ts: 3 },
      ],
    };
    assert.deepEqual(projectCommandFrame(frame), {
      ...frame,
      items: [{ ...frame.items[0], text: "$ npm test" }, ...frame.items.slice(1)],
    });
    assert.match(frame.items[0]!.text, /private output/);
  });
});
