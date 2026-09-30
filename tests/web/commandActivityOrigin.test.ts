import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ActivityTracker } from "../../server/utils/activityTracker.js";
import { attachWorkerPromptHandler } from "../../server/web/server/ws/workerPromptHandler.js";
import { collectCommandActivityFrames, commandActivityCases, commandCommentary, commandFinalReply } from "./commandActivityHarness.js";

describe("worker prompt command activity origin", () => {
  it("keeps native commands in the execution channel without losing other activity or assistant text", async () => {
    const { frames, events, entries, result, commandFrameCount } = await collectCommandActivityFrames();
    assert.ok(result.response.includes(commandCommentary));
    assert.ok(result.response.includes(commandFinalReply));
    assert.deepEqual(entries.slice(0, commandActivityCases.length).map((entry) => entry.category),
      commandActivityCases.map((command) => command.category));
    for (const [index, command] of commandActivityCases.entries()) {
      const commandLine = [command.cmd, ...command.args].join(" ");
      assert.equal(entries[index]?.meta?.command, commandLine);
      const lifecycle = frames.filter((frame) => frame.type === "command" && frame.command?.id === `command-${index}`);
      assert.deepEqual(lifecycle.map((frame) => frame.command), [
        { id: `command-${index}`, command: commandLine, status: "in_progress", exit_code: undefined },
        { id: `command-${index}`, command: commandLine, status: "completed", exit_code: 0 },
      ]);
    }
    const completed = events.flatMap((event) =>
      event.raw.type === "item.completed" && event.raw.item.type === "command_execution" ? [event.raw.item] : []);
    assert.equal(completed.length, commandActivityCases.length);
    assert.equal(completed.find((item) => item.command === "cat fixture.txt")?.aggregated_output, "needle in the fixture");
    // The existing Web contract sends metadata only; raw output remains available to other consumers.
    assert.equal(frames.some((frame) => frame.type === "command" && /aggregated_output|outputDelta/.test(JSON.stringify(frame))), false);
    assert.deepEqual(frames.slice(0, commandFrameCount).filter((frame) => frame.type === "explored"), []);
    assert.deepEqual(frames.filter((frame) => frame.type === "delta").map((frame) => frame.delta), [commandCommentary, commandFinalReply]);
    const explored = frames.filter((frame) => frame.type === "explored");
    assert.deepEqual(explored.map((frame) => frame.entry), entries.slice(commandActivityCases.length).map(({ category, summary }) => ({ category, summary })));
    assert.deepEqual(explored.map((frame) => frame.header), [true, false, false, false, false]);
  });

  it("suppresses tool-hook command origins without filtering by category or consuming the header", () => {
    const frames: unknown[] = [];
    const bridge = attachWorkerPromptHandler({
      orchestrator: { onEvent: () => () => {} },
      turnCwd: "/tmp/project",
      sendToChat: (frame) => frames.push(frame),
      logger: { info: () => {}, debug: () => {} },
      sessionLogger: null,
    });
    const tracker = new ActivityTracker(bridge.handleExploredEntry);
    for (const { cmd, args } of commandActivityCases) {
      tracker.ingestToolInvoke("exec", JSON.stringify({ cmd, args }));
    }
    assert.deepEqual(frames, []);
    bridge.handleExploredEntry({ category: "Execute", summary: "Non-command activity", source: "tool_hook", ts: 1 });
    assert.deepEqual(frames, [{ type: "explored", header: true, entry: { category: "Execute", summary: "Non-command activity" } }]);
    bridge.unsubscribe();
  });
});
