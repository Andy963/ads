import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installTempAdsStateDir } from "./adsStateDir.js";

const LOCK_FILE = path.join(os.tmpdir(), "ads-state-dir.lock");

function cleanupLock(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

describe("adsStateDir helper", () => {
  afterEach(() => {
    cleanupLock();
  });

  it("recovers from a stale lock file left by a dead process", () => {
    fs.writeFileSync(LOCK_FILE, "999999", "utf8");

    const temp = installTempAdsStateDir("ads-state-helper-");
    try {
      assert.ok(temp.stateDir.includes("ads-state-helper-"));
      assert.equal(process.env.ADS_STATE_DIR, temp.stateDir);
    } finally {
      temp.restore();
    }

    assert.equal(fs.existsSync(LOCK_FILE), false);
  });

  it("recovers from a malformed lock file", () => {
    fs.writeFileSync(LOCK_FILE, "not-a-pid", "utf8");

    const temp = installTempAdsStateDir("ads-state-helper-");
    try {
      assert.ok(temp.stateDir.includes("ads-state-helper-"));
    } finally {
      temp.restore();
    }

    assert.equal(fs.existsSync(LOCK_FILE), false);
  });
});
