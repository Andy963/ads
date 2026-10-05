import { it } from "node:test";
import assert from "node:assert/strict";
import { createActionSupervision } from "../../server/actions/supervision.js";
import { createActionToolBridge } from "../../server/codex/appServer/actionTools.js";
import { NativeToolExecutor } from "../../server/runtime/tools.js";

const pass = { status: "PASS" as const, summary: "Reviewed", defects: [], reviewedAt: 1 };

it("parent shutdown cancels and drains a running child before relinquishing ownership", async () => {
  let stopped = false;
  const tools = createActionSupervision({ signal: new AbortController().signal, snapshot: () => "head",
    review: (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { stopped = true; reject(signal.reason); }, { once: true });
    }), deliver: () => ({ ok: true }) });
  const child = tools.review_action();
  const rejection = assert.rejects(child, /abort/i);
  await tools.dispose();
  await rejection;
  assert.equal(stopped, true);
  await assert.rejects(tools.deliver_action(), /abort/i);
});

it("returns operational failures to one parent, preserves PASS across PR retry, and bounds calls", async () => {
  let reviews = 0;
  let deliveries = 0;
  const tools = createActionSupervision({
    signal: new AbortController().signal, snapshot: () => "base:head",
    review: async () => { if (++reviews === 1) throw new Error("Evidence unavailable"); return pass; },
    deliver: () => ({ ok: ++deliveries > 1, error: "PR creation failed" }),
  });
  assert.match(String((await tools.review_action()).error), /Evidence unavailable/);
  assert.equal((await tools.review_action()).ok, true);
  assert.equal((await tools.deliver_action()).ok, false);
  assert.equal((await tools.deliver_action()).ok, true);
  assert.equal((await tools.deliver_action()).ok, true);
  assert.equal(reviews, 2);
  assert.equal(deliveries, 2);
});

it("cannot deliver missing, rejected, stale or concurrently changing review evidence", async () => {
  let head = "first";
  let deliveries = 0;
  const tools = createActionSupervision({ signal: new AbortController().signal,
    snapshot: () => head, review: async () => pass, deliver: () => { deliveries++; return { ok: true }; } });
  assert.equal((await tools.deliver_action()).ok, false);
  await tools.review_action();
  head = "second";
  assert.equal((await tools.deliver_action()).ok, false);
  await tools.review_action();
  assert.equal((await tools.deliver_action()).ok, true);
  assert.equal(deliveries, 1);
});

it("bounds unsuccessful review calls and propagates parent cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const tools = createActionSupervision({ signal: controller.signal, snapshot: () => "head",
    review: async () => { calls++; return { ...pass, status: "REJECT" }; }, deliver: () => ({ ok: true }) });
  for (let i = 0; i < 4; i++) assert.equal((await tools.review_action()).ok, false);
  assert.equal(calls, 3);
  controller.abort();
  await assert.rejects(tools.review_action(), /abort/i);
});

it("Codex tool bridge deduplicates in-flight child calls and rejects foreign turns", async () => {
  let calls = 0;
  let finish!: (value: { ok: boolean }) => void;
  const bridge = createActionToolBridge({
    scope: () => ({ threadId: "parent", turnId: "turn", active: true }), markSideEffect: () => {},
    tools: { review_action: () => { calls++; return new Promise(resolve => { finish = resolve; }); }, deliver_action: async () => ({ ok: true }) },
  });
  const request = { threadId: "parent", turnId: "turn", callId: "child", tool: "review_action", arguments: {} };
  const first = bridge.handle(request);
  const duplicate = bridge.handle(request);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(bridge.matches({ ...request, turnId: "foreign" }), false);
  assert.equal((await bridge.handle({ ...request, tool: "deliver_action" })).success, false);
  finish({ ok: true });
  assert.deepEqual(await first, await duplicate);
});

it("Native tools invoke only job-scoped children and cache duplicate calls", async () => {
  let calls = 0;
  const executor = new NativeToolExecutor({ workspaceRoot: process.cwd(), actionTools: {
    review_action: async () => { calls++; return { ok: true, verdict: pass }; }, deliver_action: async () => ({ ok: true }),
  } });
  const call = { id: "review", type: "function" as const, function: { name: "review_action", arguments: "{}" } };
  try {
    assert.match((await executor.execute(call)).output, /PASS/);
    await executor.execute(call);
    assert.equal(calls, 1);
    await assert.rejects(executor.execute({ ...call, id: "bad", function: { ...call.function, arguments: '{"job_id":"foreign"}' } }), /empty argument/);
  } finally { await executor.dispose(); }
});
