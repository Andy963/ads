import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RotatingLogFile } from "../../src/utils/rotatingLogFile.js";

test("rotates before exceeding maxBytes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-rotating-log-"));
  const basePath = path.join(dir, "ads.log");
  const maxBytes = 100;

  const sink = new RotatingLogFile(basePath, { maxBytes });
  const line = "x".repeat(40) + "\n"; // 41 bytes

  for (let i = 0; i < 10; i += 1) {
    sink.write(line);
  }
  await sink.closeAsync();

  const entries = fs.readdirSync(dir).sort();
  assert.ok(entries.length >= 2, `expected rotated logs, got: ${entries.join(", ")}`);

  for (const entry of entries) {
    const size = fs.statSync(path.join(dir, entry)).size;
    assert.ok(size <= maxBytes, `expected ${entry} <= ${maxBytes}, got ${size}`);
  }
});

test("starts a new segment when base log is already oversized", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-rotating-log-"));
  const basePath = path.join(dir, "ads.log");
  const maxBytes = 100;

  fs.writeFileSync(basePath, "x".repeat(200), "utf8");
  fs.writeFileSync(path.join(dir, "ads.1.log"), "seed", "utf8");

  const sink = new RotatingLogFile(basePath, { maxBytes });
  assert.equal(path.basename(sink.path), "ads.2.log");

  sink.write("hello\n");
  await sink.closeAsync();

  const size = fs.statSync(path.join(dir, "ads.2.log")).size;
  assert.ok(size > 0 && size <= maxBytes);
});
