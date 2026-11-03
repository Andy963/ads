import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REVIEW_VERDICT_READY_EVENT,
  createAcopilotLaneWaker,
} from "../../server/web/server/start/acopilotLaneWake.js";

function setup(options: { generation?: number } = {}) {
  const appended: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const acopilotClient = {} as never;
  const actionsClient = {} as never;
  const clientMetaByWs = new Map([
    [acopilotClient, {
      historyKey: options.generation && options.generation > 1
        ? "user-1::default::acopilot:generation:2"
        : "user-1::default::acopilot",
      sessionId: "default",
      chatSessionId: "acopilot",
      connectionId: "c1",
      authUserId: "user-1",
      sessionUserId: 1,
    }],
    [actionsClient, {
      historyKey: "user-1::default::main",
      sessionId: "default",
      chatSessionId: "main",
      connectionId: "c2",
      authUserId: "user-1",
      sessionUserId: 2,
    }],
  ]) as never;
  const wake = createAcopilotLaneWaker({
    syncEventStore: {
      append: (args: Record<string, unknown>) => {
        appended.push(args);
        return appended.length;
      },
      getLatestSeq: () => 0,
    } as never,
    laneGenerationStore: { getGeneration: () => options.generation ?? 1 } as never,
    clientMetaByWs,
    sendJson: (_ws, payload) => {
      sent.push(payload as Record<string, unknown>);
    },
    warn: (message) => warnings.push(message),
  });
  return { wake, appended, sent, warnings, acopilotClient, actionsClient };
}

describe("Acopilot review wake", () => {
  it("appends a durable event to the acopilot lane and pushes it to that lane only", () => {
    const { wake, appended, sent } = setup();
    wake({ projectId: "default", authUserId: "user-1", issueId: 613, prNumber: 614, status: "PASS", jobId: "job-1", headSha: "abc123" });

    assert.equal(appended.length, 1);
    const event = appended[0]!;
    assert.equal(event.namespace, "web-acopilot");
    assert.equal(event.laneKey, "user-1::default::acopilot");
    assert.equal(event.type, REVIEW_VERDICT_READY_EVENT);
    assert.equal(event.eventId, "review_verdict_ready:job-1");
    assert.deepEqual(event.payload, {
      type: REVIEW_VERDICT_READY_EVENT,
      eventId: "review_verdict_ready:job-1",
      ts: (event.payload as { ts: number }).ts,
      projectId: "default",
      issueId: 613,
      prNumber: 614,
      status: "PASS",
      jobId: "job-1",
      headSha: "abc123",
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.seq, 1);
  });

  it("deduplicates a repeated wake for the same job", () => {
    const { wake, appended, sent } = setup();
    const input = { projectId: "default", authUserId: "user-1", issueId: 613, status: "PASS" as const, jobId: "job-1" };
    wake(input);
    wake(input);
    assert.equal(appended.length, 1);
    assert.equal(sent.length, 1);
  });

  it("targets the current lane generation after a reset", () => {
    const { wake, appended } = setup({ generation: 2 });
    wake({ projectId: "default", authUserId: "user-1", issueId: 613, status: "REJECT", jobId: "job-2" });
    assert.equal(appended[0]!.laneKey, "user-1::default::acopilot:generation:2");
  });

  it("refuses to wake without a scoped identity", () => {
    const { wake, appended, warnings } = setup();
    wake({ projectId: "", authUserId: "user-1", issueId: 613, status: "PASS", jobId: "job-3" });
    assert.equal(appended.length, 0);
    assert.equal(warnings.length, 1);
  });
});
