import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolLoopGuard } from "../../server/runtime/toolLoopGuard.js";

describe("progress based loop guard", () => {
  const read = { name: "read", arguments: '{"path":"a"}', result: "same", stateVersion: "v1" };
  it("allows 1000 distinct observations with bounded private state", () => {
    const guard = new ToolLoopGuard();
    for (let i = 0; i < 1000; i++) assert.equal(guard.observe({ ...read, result: `result-${i}` }).action, "allow");
    assert.equal(guard.snapshot().history.length, 64);
    assert.doesNotMatch(JSON.stringify(guard.snapshot()), /result-|path/);
  });
  it("warns before pausing and resumes detection from a sanitized snapshot", () => {
    let guard = new ToolLoopGuard();
    assert.equal(guard.observe(read).action, "allow");
    assert.equal(guard.observe(read).action, "allow");
    assert.equal(guard.observe(read).action, "warn");
    guard = new ToolLoopGuard(guard.snapshot());
    assert.equal(guard.observe(read).action, "allow");
    assert.equal(guard.observe(read).action, "pause");
  });
  for (const period of [2, 3, 4]) {
    it(`detects a ${period}-operation cycle independent of JSON key ordering`, () => {
      const guard = new ToolLoopGuard();
      let decision;
      for (let i = 0; i < 5 * period; i++) decision = guard.observe({ ...read, name: `tool-${i % period}`,
        arguments: i % 2 ? '{"a":1,"b":2}' : '{"b":2,"a":1}' });
      assert.equal(decision?.action, "pause");
    });
  }
  it("does not treat verified waits or unknown shell state as a proven loop", () => {
    const guard = new ToolLoopGuard();
    for (let i = 0; i < 100; i++) assert.notEqual(guard.observe({ ...read, poll: true }).action, "pause");
    const shell = new ToolLoopGuard();
    for (let i = 0; i < 100; i++) assert.notEqual(shell.observe({ ...read, stateVersion: undefined }).action, "pause");
    const fakePoll = new ToolLoopGuard();
    for (let i = 0; i < 4; i++) fakePoll.observe({ ...read, name: "wait" });
    assert.equal(fakePoll.observe({ ...read, name: "wait" }).action, "pause");
  });
  it("allows tests after relevant resource changes without trusting successful exit codes", () => {
    const guard = new ToolLoopGuard();
    for (let i = 0; i < 100; i++) assert.equal(guard.observe({ ...read, stateVersion: `revision-${i}`, failed: false }).action, "allow");
    const unchanged = new ToolLoopGuard();
    for (let i = 0; i < 4; i++) unchanged.observe(read);
    assert.equal(unchanged.observe(read).action, "pause");
  });
  for (const period of [2, 3, 4]) {
    it(`allows a verified running wait mixed into a ${period}-operation polling cycle`, () => {
      let guard = new ToolLoopGuard();
      for (let i = 0; i < period * 20; i++) {
        if (i === period * 10) guard = new ToolLoopGuard(guard.snapshot());
        const poll = i % period === 0;
        assert.equal(guard.observe({ ...read, name: poll ? "wait_command" : `read-log-${i % period}`,
          poll }).action, "allow");
      }
      for (let i = 0; i < 4; i++) guard.observe(read);
      assert.equal(guard.observe(read).action, "pause");
    });
  }
  it("ignores corrupt snapshots without throwing", () => {
    const snapshot = new ToolLoopGuard().snapshot();
    snapshot.history.push(null as never);
    assert.deepEqual(new ToolLoopGuard(snapshot).snapshot().history, []);
  });
});
