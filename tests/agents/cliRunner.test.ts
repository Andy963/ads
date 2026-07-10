import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCli, runCliRaw } from "../../server/agents/cli/cliRunner.js";

describe("cliRunner", () => {
  it("parses JSONL output and skips noise", async () => {
    const lines: unknown[] = [];
    const node = process.execPath;
    const script = [
      "console.log('{\"type\":\"a\"}')",
      "console.log('noise')",
      "console.log('{\"type\":\"b\",\"value\":1}')",
    ].join(";");

    const result = await runCli({ binary: node, args: ["-e", script] }, (parsed) => lines.push(parsed));
    assert.equal(result.exitCode, 0);
    assert.deepEqual(lines, [{ type: "a" }, { type: "b", value: 1 }]);
  });

  it("returns raw stdout from streamed runs", async () => {
    const node = process.execPath;
    const script = [
      "console.log('API Error: Request rejected (429) · Service Unavailable')",
      "console.log('{\"type\":\"ok\"}')",
    ].join(";");
    const lines: unknown[] = [];

    const result = await runCli({ binary: node, args: ["-e", script] }, (parsed) => lines.push(parsed));

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'API Error: Request rejected (429) · Service Unavailable\n{"type":"ok"}');
    assert.deepEqual(lines, [{ type: "ok" }]);
  });

  it("captures raw stdout for non-JSON commands", async () => {
    const node = process.execPath;
    const script = "process.stdout.write('hello\\nworld\\n'); process.stderr.write('err')";
    const result = await runCliRaw({ binary: node, args: ["-e", script] });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "hello\nworld");
    assert.equal(result.stderr, "err");
  });

  it("cancels without hanging when stdout is noisy", async () => {
    const node = process.execPath;
    const controller = new AbortController();
    const lines: unknown[] = [];
    const script = [
      "const timer = setInterval(() => console.log('{\"type\":\"tick\"}'), 1);",
      "process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });",
    ].join("");

    const timeout = setTimeout(() => controller.abort(), 25);
    const result = await Promise.race([
      runCli({ binary: node, args: ["-e", script], signal: controller.signal }, (parsed) => lines.push(parsed)),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), 2000)),
    ]).finally(() => clearTimeout(timeout));

    assert.equal(result.cancelled, true);
    assert.ok(lines.length >= 0);
  });

  it("terminates a hung child via timeoutMs and reports the timeout", async () => {
    const node = process.execPath;
    // Stays alive, emits no stdout, exits on SIGTERM — the classic "hung agent" shape.
    const script = [
      "const timer = setInterval(() => {}, 1000);",
      "process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });",
    ].join("");

    const result = await Promise.race([
      runCli({ binary: node, args: ["-e", script], timeoutMs: 50 }, () => {}),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("did not time out")), 3000)),
    ]);

    // Timeout is not a user cancellation; it surfaces as a terminated run with a notice.
    assert.equal(result.cancelled, false);
    assert.match(result.stderr, /超时/);
  });

  it("does not hang or leak when onLine throws", async () => {
    const node = process.execPath;
    const script = ["console.log('{\"a\":1}');", "setInterval(() => {}, 1000);"].join("");

    await assert.rejects(
      Promise.race([
        runCli({ binary: node, args: ["-e", script], timeoutMs: 0 }, () => {
          throw new Error("boom");
        }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("hung")), 3000)),
      ]),
      /boom/,
    );
  });

  it("caps retained stdout and stderr while preserving their tails", async () => {
    const node = process.execPath;
    const script = [
      "process.stdout.write('a'.repeat(100000) + 'stdout-tail');",
      "process.stderr.write('b'.repeat(100000) + 'stderr-tail');",
    ].join("");

    const result = await runCli({ binary: node, args: ["-e", script], maxOutputBytes: 64 * 1024 }, () => {});

    assert.equal(result.stdoutTruncated, true);
    assert.equal(result.stderrTruncated, true);
    assert.ok(Buffer.byteLength(result.stdout) <= 64 * 1024);
    assert.ok(Buffer.byteLength(result.stderr) <= 64 * 1024);
    assert.match(result.stdout, /stdout-tail$/);
    assert.match(result.stderr, /stderr-tail$/);
  });

  it("bounds concurrent and pending CLI executions", async () => {
    const previousConcurrency = process.env.ADS_CLI_MAX_CONCURRENCY;
    const previousPending = process.env.ADS_CLI_MAX_PENDING;
    process.env.ADS_CLI_MAX_CONCURRENCY = "1";
    process.env.ADS_CLI_MAX_PENDING = "1";

    try {
      const node = process.execPath;
      const script = [
        "console.log('{\"type\":\"started\"}');",
        "setTimeout(() => { console.log('{\"type\":\"done\"}'); }, 150);",
      ].join("");
      let firstStartedResolve!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        firstStartedResolve = resolve;
      });
      const first = runCli({ binary: node, args: ["-e", script] }, (event) => {
        if ((event as { type?: unknown }).type === "started") firstStartedResolve();
      });
      await firstStarted;

      let secondStarted = false;
      const second = runCli({ binary: node, args: ["-e", script] }, (event) => {
        if ((event as { type?: unknown }).type === "started") secondStarted = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(secondStarted, false);

      await assert.rejects(
        runCli({ binary: node, args: ["-e", script] }, () => {}),
        /queue is full/,
      );
      await Promise.all([first, second]);
      assert.equal(secondStarted, true);
    } finally {
      if (previousConcurrency === undefined) delete process.env.ADS_CLI_MAX_CONCURRENCY;
      else process.env.ADS_CLI_MAX_CONCURRENCY = previousConcurrency;
      if (previousPending === undefined) delete process.env.ADS_CLI_MAX_PENDING;
      else process.env.ADS_CLI_MAX_PENDING = previousPending;
    }
  });

  it("terminates descendant processes when a CLI run is cancelled", async (t) => {
    if (process.platform === "win32") {
      t.skip("process-group signaling is POSIX-specific");
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-cli-process-group-"));
    const pidFile = path.join(dir, "child.pid");
    const node = process.execPath;
    const script = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `const child = spawn(${JSON.stringify(node)}, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });`,
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      "console.log('{\"type\":\"started\"}');",
      "setInterval(() => {}, 1000);",
    ].join("");
    const controller = new AbortController();
    let descendantPid = 0;

    try {
      const result = await runCli(
        { binary: node, args: ["-e", script], signal: controller.signal },
        (event) => {
          if ((event as { type?: unknown }).type === "started") controller.abort();
        },
      );
      assert.equal(result.cancelled, true);
      descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);

      const deadline = Date.now() + 2000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try {
          process.kill(descendantPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
          alive = false;
        }
      }
      assert.equal(alive, false);
    } finally {
      if (descendantPid > 0) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // already dead
        }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
