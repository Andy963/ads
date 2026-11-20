import { CodexAppServerAdapter } from "../../server/agents/adapters/codexAppServerAdapter.js";
import { getSharedDaemonRegistry } from "../../server/codex/appServer/daemonRegistry.js";

const binary = process.env.ADS_APP_SERVER_PROBE_BIN?.trim();
const cwd = process.env.ADS_APP_SERVER_PROBE_CWD?.trim();
if (!binary || !cwd) {
  throw new Error("ADS_APP_SERVER_PROBE_BIN and ADS_APP_SERVER_PROBE_CWD are required");
}

const events: unknown[] = [];
const adapter = new CodexAppServerAdapter({
  projectId: "app-server-conformance",
  workspaceRoot: cwd,
  workingDirectory: cwd,
  binary,
  model: "probe-model",
  sandboxMode: "workspace-write",
  developerInstructions: "Follow the conformance contract.",
  registry: getSharedDaemonRegistry(),
  turnTimeoutMs: 10_000,
});
adapter.onEvent((event) => {
  events.push({
    phase: event.phase,
    title: event.title,
    detail: event.detail ?? null,
    delta: event.delta ?? null,
    sessionFallback: event.sessionFallback ?? null,
  });
});

try {
  const result = await adapter.send("probe request", {
    actionTools: {
      review_action: async () => ({ ok: true, jobId: "job-1", status: "queued" }),
    },
  });
  console.log(JSON.stringify({
    response: result.response,
    usage: result.usage,
    agentId: result.agentId,
    threadId: adapter.getThreadId(),
    events,
  }));
} finally {
  await getSharedDaemonRegistry().stopAll();
}
