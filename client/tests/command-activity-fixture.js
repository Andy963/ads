import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NativeAgentAdapter } from "../../ts-server/dist/server/agents/adapters/nativeAgentAdapter.js";
import { ActivityTracker } from "../../ts-server/dist/server/utils/activityTracker.js";
import { attachWorkerPromptHandler } from "../../ts-server/dist/server/web/server/ws/workerPromptHandler.js";

const commandActivityCases = [
  { cmd: "ls", args: ["fixture.txt"], category: "List" },
  { cmd: "grep", args: ["needle", "fixture.txt"], category: "Search" },
  { cmd: "cat", args: ["fixture.txt"], category: "Read" },
  { cmd: "sed", args: ["-n", "1p", "fixture.txt"], category: "Read" },
  { cmd: "touch", args: ["created.txt"], category: "Write" },
  { cmd: "pwd", args: [], category: "Execute" },
];
const commandCommentary = "I will inspect the fixture before summarizing it.";
const commandFinalReply = "The fixture contains the expected needle.";

function sse(delta, finishReason) {
  const event = JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] });
  return new Response(`data: ${event}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

async function collectCommandActivityFrames() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-command-activity-"));
  const frames = [];
  const entries = [];
  let requestNumber = 0;
  const adapter = new NativeAgentAdapter({
    credentialOwner: "test-owner",
    workspaceRoot: workspace,
    workingDirectory: workspace,
    maxToolRounds: commandActivityCases.length + 1,
    modelResolver: {
      resolve: () => ({ model: "test-model", baseUrl: "https://provider.test/v1", apiKey: "test-key", provider: "test" }),
    },
    fetchImpl: async () => {
      const index = requestNumber++;
      const command = commandActivityCases[index];
      if (!command) return sse({ content: commandFinalReply }, "stop");
      return sse({
        ...(index === 0 ? { content: commandCommentary } : {}),
        tool_calls: [{
          index: 0,
          type: "function",
          id: `command-${index}`,
          function: {
            name: "exec_command",
            arguments: JSON.stringify({ cmd: command.cmd, args: command.args }),
          },
        }],
      }, "tool_calls");
    },
  });
  const bridge = attachWorkerPromptHandler({
    orchestrator: adapter,
    turnCwd: workspace,
    sendToChat: (payload) => frames.push(payload),
    logger: { info: () => {}, debug: () => {} },
    sessionLogger: null,
  });
  const tracker = new ActivityTracker((entry) => {
    entries.push(entry);
    bridge.handleExploredEntry(entry);
  });
  const unsubscribe = adapter.onEvent((event) => tracker.ingestThreadEvent(event.raw));
  try {
    fs.writeFileSync(path.join(workspace, "fixture.txt"), "needle in the fixture\n");
    await adapter.send("Inspect the temporary fixture");
    const commandFrameCount = frames.length;
    tracker.ingestToolInvoke("find", JSON.stringify({ pattern: "context.md", path: "notes" }));
    tracker.ingestToolInvoke("grep", JSON.stringify({ pattern: "context", path: "notes" }));
    tracker.ingestToolInvoke("read", JSON.stringify({ path: "notes/context.md" }));
    tracker.ingestToolInvoke("write", JSON.stringify({ path: "notes/summary.md" }));
    tracker.ingestThreadEvent({ type: "item.completed", item: { id: "web-search", type: "web_search", query: "reference documentation" } });
    return { frames, entries, commandFrameCount };
  } finally {
    unsubscribe();
    bridge.unsubscribe();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

const result = await collectCommandActivityFrames();
process.stdout.write(JSON.stringify(result));
