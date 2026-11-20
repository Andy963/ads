import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { NativeToolExecutor } from "../../server/runtime/tools.js";
import { ToolLoopGuard } from "../../server/runtime/toolLoopGuard.js";

function call(name: string, args: Record<string, unknown>) {
  return { id: `call-${name}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for test process readiness");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux" && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8"))) return false;
    return true;
  } catch { return false; }
}

describe("Native command sessions", () => {
  let workspace: string;
  let executors: NativeToolExecutor[];
  const executor = (signal?: AbortSignal, redactions?: string[]) => {
    const result = new NativeToolExecutor({ workspaceRoot: workspace, signal, redactions });
    executors.push(result);
    return result;
  };
  const start = (tool: NativeToolExecutor, code: string, options: Record<string, unknown> = {}) => tool.execute(call("exec_command", {
    cmd: process.execPath, args: ["-e", code], yield_time_ms: 1, ...options,
  }));
  const gate = "const fs=require('fs'); fs.appendFileSync('starts','x'); const timer=setInterval(()=>{if(fs.existsSync('release')) {clearInterval(timer); process.stdout.write('done\\n');}},10);";
  const release = () => fs.writeFileSync(path.join(workspace, "release"), "");

  beforeEach(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-command-sessions-")); executors = []; });
  afterEach(async () => {
    await Promise.all(executors.map(tool => tool.dispose()));
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("yields without killing or restarting, and quiet verified waits bypass loop detection", async () => {
    const tool = executor();
    const first = await start(tool, gate);
    const id = JSON.parse(first.output).session_id;
    assert.equal(first.command?.status, "in_progress");
    assert.equal(first.failed, false);
    assert.equal(JSON.parse(first.output).exit_code, null);
    await until(() => fs.existsSync(path.join(workspace, "starts")));
    fs.writeFileSync(path.join(workspace, "progress.log"), "waiting\n");
    const guard = new ToolLoopGuard();
    for (let i = 0; i < 8; i++) {
      const request = call("wait_command", { session_id: id, yield_time_ms: 1 });
      const result = await tool.execute(request);
      assert.equal(result.poll, true);
      assert.equal(JSON.parse(result.output).running, true);
      assert.equal(guard.observe({ name: request.function.name, arguments: request.function.arguments,
        result: result.loopResult!, poll: result.poll }).action, "allow");
      const read = call("read_file", { file: "progress.log" });
      const log = await tool.execute(read);
      assert.equal(guard.observe({ name: read.function.name, arguments: read.function.arguments,
        result: log.output, stateVersion: log.stateVersion }).action, "allow");
    }
    release();
    const result = await tool.execute(call("wait_command", { session_id: id }));
    assert.equal(JSON.parse(result.output).stdout, "done");
    assert.equal(JSON.parse(result.output).exit_code, 0);
    assert.equal(JSON.parse(result.output).running, false);
    assert.equal(result.command?.id, first.command?.id);
    assert.equal(result.command?.status, "completed");
    assert.equal(fs.readFileSync(path.join(workspace, "starts"), "utf8"), "x");
    assert.deepEqual(tool.pendingCommandIds(), []);
    await assert.rejects(tool.execute(call("wait_command", { session_id: id })), /Unknown or completed/);
  });

  it("treats legacy timeout_ms as wait-only, not a kill deadline", async () => {
    const tool = executor();
    const first = await tool.execute(call("exec_command", { cmd: process.execPath, args: ["-e", gate], timeout_ms: 10 }));
    await until(() => fs.existsSync(path.join(workspace, "starts")));
    await delay(60);
    release();
    const result = JSON.parse((await tool.execute(call("wait_command", { session_id: JSON.parse(first.output).session_id }))).output);
    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
  });

  it("survives the original 180-second legacy deadline", async t => {
    const tool = executor();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = tool.execute(call("exec_command", { cmd: process.execPath, args: ["-e", gate], timeout_ms: 180_000 }));
    // Allow middleware's asynchronous admission before advancing the wait timer.
    await new Promise<void>(resolve => setImmediate(resolve));
    t.mock.timers.tick(181_000);
    const first = JSON.parse((await pending).output);
    t.mock.timers.reset();
    assert.equal(first.running, true);
    await until(() => fs.existsSync(path.join(workspace, "starts")));
    release();
    const result = JSON.parse((await tool.execute(call("wait_command", { session_id: first.session_id }))).output);
    assert.equal(result.exit_code, 0);
    assert.equal(result.timed_out, false);
  });

  it("enforces only an explicitly supplied runtime deadline", async () => {
    const tool = executor();
    const first = await start(tool, "setInterval(()=>{},1000)", { max_runtime_ms: 50 });
    const result = JSON.parse((await tool.execute(call("wait_command", { session_id: JSON.parse(first.output).session_id }))).output);
    assert.equal(result.running, false);
    assert.equal(result.timed_out, true);
    assert.notEqual(result.exit_code, 0);
  });

  it("returns incremental sanitized lines without leaking split credentials", async () => {
    const tool = executor(undefined, ["long-private-key"]);
    const first = await start(tool, "const fs=require('fs'); process.stdout.write('first\\nsecret=long-'); fs.writeFileSync('starts','x'); const t=setInterval(()=>{if(fs.existsSync('release')){clearInterval(t);process.stdout.write('private-key\\nlast\\n');process.stderr.write('error\\n');}},10);");
    const id = JSON.parse(first.output).session_id;
    await until(() => fs.existsSync(path.join(workspace, "starts")));
    const second = JSON.parse((await tool.execute(call("wait_command", { session_id: id, yield_time_ms: 20 }))).output);
    assert.equal(second.stdout, "first");
    assert.doesNotMatch(JSON.stringify(second), /long-/);
    release();
    const result = await tool.execute(call("wait_command", { session_id: id }));
    const last = JSON.parse(result.output);
    assert.equal(last.stdout, "secret=[redacted]\nlast");
    assert.equal(last.stderr, "error");
    assert.doesNotMatch(result.command!.aggregated_output!, /long-private-key/);
    assert.match(result.command!.aggregated_output!, /first/);
  });

  it("bounds flooding output, drops oversized lines and keeps JSON parseable", async () => {
    const tool = executor();
    const result = await start(tool, "process.stdout.write('secret='+ 'x'.repeat(100000)+'\\n'+ 'ok\\n'.repeat(100000));process.stderr.write('error\\n');", { yield_time_ms: 10_000, max_output_bytes: 1024 });
    const output = JSON.parse(result.output);
    assert.equal(output.exit_code, 0);
    assert.equal(output.truncated_stdout, true);
    assert.ok(output.stdout.length <= 1024);
    assert.doesNotMatch(output.stdout, /xxx/);
    assert.equal(output.stderr, "error");
  });

  it("redacts multiline secrets before splitting output into incremental records", async () => {
    const tool = executor(undefined, ["private-first-line\nprivate-second-line"]);
    const result = await start(tool, "process.stdout.write('private-first-line\\nprivate-second-line\\n');", { yield_time_ms: 10_000 });
    assert.doesNotMatch(result.output, /private-(first|second)-line/);
    assert.equal(JSON.parse(result.output).stdout, "[redacted]\n[redacted]");
  });

  for (const stream of ["stdout", "stderr"]) {
    for (const terminated of [true, false]) {
      it(`suppresses unknown PEM keys across ${stream} polls and truncation (terminated=${terminated})`, async () => {
        const tool = executor();
        const body = "UNCONFIGURED_PRIVATE_KEY_MATERIAL";
        const parts = [
          `before\n${"prefix".repeat(300)}-----BE`,
          "GIN RSA PRIVATE KEY-----\n",
          `${body.repeat(100)}\n`,
          ...(terminated ? ["-----END RSA PRI", "VATE KEY-----\nafter\n"] : []),
        ];
        fs.writeFileSync(path.join(workspace, "parts.json"), JSON.stringify(parts));
        const first = await start(tool, `const fs=require('fs');const parts=JSON.parse(fs.readFileSync('parts.json','utf8'));let i=0;const timer=setInterval(()=>{if(i<parts.length&&fs.existsSync('step-'+i)){process.${stream}.write(parts[i]);fs.writeFileSync('sent-'+i,'');i++;}if(fs.existsSync('release'))clearInterval(timer);},5);`, { max_output_bytes: 1024 });
        const id = JSON.parse(first.output).session_id;
        let visible = "";
        for (let i = 0; i < parts.length; i++) {
          fs.writeFileSync(path.join(workspace, `step-${i}`), "");
          await until(() => fs.existsSync(path.join(workspace, `sent-${i}`)));
          const result = await tool.execute(call("wait_command", { session_id: id, yield_time_ms: 20 }));
          assert.doesNotMatch(result.output + result.command!.aggregated_output, /UNCONFIGURED_PRIVATE_KEY_MATERIAL/);
          visible += JSON.parse(result.output)[stream];
        }
        release();
        const last = await tool.execute(call("wait_command", { session_id: id }));
        assert.doesNotMatch(last.output + last.command!.aggregated_output, /UNCONFIGURED_PRIVATE_KEY_MATERIAL/);
        visible += JSON.parse(last.output)[stream];
        assert.match(visible, /before/);
        if (terminated) assert.match(visible, /after/);
      });
    }
  }

  it("preserves the terminal failure of a nonzero test command after yielding", async () => {
    const tool = executor();
    const first = await start(tool, "setTimeout(()=>{process.stderr.write('test failed\\n');process.exitCode=7;},150)");
    const result = await tool.execute(call("wait_command", { session_id: JSON.parse(first.output).session_id }));
    assert.equal(result.failed, true);
    assert.equal(result.command?.status, "failed");
    assert.equal(JSON.parse(result.output).exit_code, 7);
    assert.equal(JSON.parse(result.output).timed_out, false);
  });

  it("does not allow another executor or a restored turn to operate the session", async () => {
    const owner = executor();
    const other = executor();
    const first = await start(owner, gate);
    const id = JSON.parse(first.output).session_id;
    for (const name of ["wait_command", "cancel_command"]) {
      await assert.rejects(other.execute(call(name, { session_id: id })), /Unknown or completed/);
    }
    assert.equal(owner.pendingCommandIds().length, 1);
    const cancelled = JSON.parse((await owner.execute(call("cancel_command", { session_id: id }))).output);
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.timed_out, false);
  });

  it("cancels a yielded shell and a descendant that ignores SIGTERM", async () => {
    const controller = new AbortController();
    const tool = executor(controller.signal);
    const code = "const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync('child-pid',String(process.pid));setInterval(()=>{},1000)";
    const first = await tool.execute(call("exec_command", {
      cmd: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)} & wait`, yield_time_ms: 1,
    }));
    assert.equal(JSON.parse(first.output).running, true);
    await until(() => fs.existsSync(path.join(workspace, "child-pid")));
    const pid = Number(fs.readFileSync(path.join(workspace, "child-pid"), "utf8"));
    assert.equal(isAlive(pid), true);
    controller.abort();
    await tool.dispose();
    await until(() => !isAlive(pid));
    assert.deepEqual(tool.pendingCommandIds(), []);
  });

  it("bounds concurrent sessions without limiting sequential command count", async () => {
    const tool = executor();
    for (let i = 0; i < 16; i++) await start(tool, "setInterval(()=>{},1000)");
    await assert.rejects(start(tool, "process.exit(0)"), /Too many pending/);
    await tool.execute(call("cancel_command", { session_id: tool.pendingCommandIds()[0] }));
    const result = await start(tool, "process.exit(0)", { yield_time_ms: 10_000 });
    assert.equal(JSON.parse(result.output).exit_code, 0);
  });

  it("cleans up spawn errors and rejects invalid timing parameters before spawning", async () => {
    const tool = executor();
    const failed = await tool.execute(call("exec_command", { cmd: "ads-does-not-exist", yield_time_ms: 10_000 }));
    assert.equal(failed.failed, true);
    assert.match(JSON.parse(failed.output).stderr, /ENOENT/);
    assert.equal(failed.command?.status, "failed");
    for (const max_runtime_ms of [0, -1, 2_147_483_648]) {
      await assert.rejects(start(tool, gate, { max_runtime_ms }), /max_runtime_ms/);
    }
    assert.deepEqual(tool.pendingCommandIds(), []);
    assert.equal(fs.existsSync(path.join(workspace, "starts")), false);
  });
});
