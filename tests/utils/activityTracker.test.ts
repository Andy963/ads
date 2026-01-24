import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ThreadEvent } from "@openai/codex-sdk";

import { ActivityTracker, formatExploredTree } from "../../src/utils/activityTracker.js";

describe("utils/activityTracker", () => {
  it("summarizes common command_execution events", () => {
    const tracker = new ActivityTracker();

    tracker.ingestThreadEvent({
      type: "item.started",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "ls -la",
        aggregated_output: "",
        status: "in_progress",
      },
    } as ThreadEvent);

    tracker.ingestThreadEvent({
      type: "item.started",
      item: {
        id: "cmd-2",
        type: "command_execution",
        command: 'rg -n "\\[CLI:SystemPrompt\\]|SystemPrompt\\] \\[SystemPrompt\\]|ads>" src',
        aggregated_output: "",
        status: "in_progress",
      },
    } as ThreadEvent);

    tracker.ingestThreadEvent({
      type: "item.started",
      item: {
        id: "cmd-3",
        type: "command_execution",
        command: "find .. -maxdepth 3 -name AGENTS.md -print",
        aggregated_output: "",
        status: "in_progress",
      },
    } as ThreadEvent);

    tracker.ingestThreadEvent({
      type: "item.started",
      item: {
        id: "cmd-4",
        type: "command_execution",
        command: "cat package.json",
        aggregated_output: "",
        status: "in_progress",
      },
    } as ThreadEvent);

    const entries = tracker.compact({ maxItems: 20, dedupe: "none" });
    assert.deepEqual(
      entries.map((entry) => `${entry.category} ${entry.summary}`),
      [
        "List ls -la",
        "Search \\[CLI:SystemPrompt\\]|SystemPrompt\\] \\[SystemPrompt\\]|ads> in src",
        "Search AGENTS.md in ..",
        "Read package.json",
      ],
    );
  });

  it("summarizes grep/find/vsearch/agent tool invokes", () => {
    const tracker = new ActivityTracker();

    tracker.ingestToolInvoke("grep", JSON.stringify({ pattern: "foo", path: "src", glob: "*.ts" }));
    tracker.ingestToolInvoke("find", JSON.stringify({ pattern: "*.test.ts", path: "tests" }));
    tracker.ingestToolInvoke("vsearch", "how to add tests");
    tracker.ingestToolInvoke("agent", JSON.stringify({ agentId: "Claude", prompt: "Do something" }));

    const entries = tracker.compact({ maxItems: 20, dedupe: "none" });
    assert.deepEqual(
      entries.map((entry) => `${entry.category} ${entry.summary}`),
      [
        "Search foo in src glob:*.ts",
        "List *.test.ts in tests",
        "Search how to add tests",
        "Agent claude: Do something",
      ],
    );
  });

  it("compacts consecutive duplicates and merges consecutive reads", () => {
    const tracker = new ActivityTracker();

    tracker.ingestThreadEvent({
      type: "item.started",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "ls -la src/utils",
        aggregated_output: "",
        status: "in_progress",
      },
    } as ThreadEvent);

    tracker.ingestThreadEvent({
      type: "item.started",
      item: {
        id: "cmd-2",
        type: "command_execution",
        command: "ls -la src/utils",
        aggregated_output: "",
        status: "in_progress",
      },
    } as ThreadEvent);

    tracker.ingestToolInvoke("read", '{"path":"src/utils/logger.ts","startLine":1,"endLine":10}');
    tracker.ingestToolInvoke("read", '{"path":"src/ads.ts","startLine":1,"endLine":10}');

    const entries = tracker.compact({ maxItems: 20, dedupe: "consecutive" });
    assert.deepEqual(
      entries.map((entry) => `${entry.category} ${entry.summary}`),
      ["List src/utils (x2)", "Read utils/logger.ts, src/ads.ts"],
    );
  });

  it("caps merged consecutive reads", () => {
    const tracker = new ActivityTracker();

    for (let i = 0; i < 10; i += 1) {
      tracker.ingestToolInvoke("read", JSON.stringify({ path: `src/file${i}.ts` }));
    }

    const entries = tracker.compact({ maxItems: 20, dedupe: "none" });
    assert.equal(entries.length, 1);
    assert.equal(
      `${entries[0]?.category} ${entries[0]?.summary}`,
      "Read src/file0.ts, src/file1.ts, src/file2.ts, src/file3.ts, … (+6 more)",
    );
  });

  it("formats a tree view", () => {
    const tracker = new ActivityTracker();
    tracker.ingestToolInvoke("exec", "npm test");
    const tree = formatExploredTree(tracker.compact({ maxItems: 10, dedupe: "consecutive" }));
    assert.match(tree, /^Explored\n/);
    assert.match(tree, /Execute npm test/);
  });
});
