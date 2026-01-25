import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { loadIntakeState, saveIntakeState, clearIntakeState } from "../../src/intake/storage.js";
import type { IntakeState } from "../../src/intake/types.js";
import { resolveWorkspaceStatePath } from "../../src/workspace/adsPaths.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

describe("intake/storage", () => {
  let tmpDir: string;
  let adsDir: string;
  let adsState: TempAdsStateDir | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-intake-test-"));
    adsState = installTempAdsStateDir("ads-state-intake-");
    adsDir = resolveWorkspaceStatePath(tmpDir);
    fs.mkdirSync(adsDir, { recursive: true });
  });

  afterEach(() => {
    adsState?.restore();
    adsState = null;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("saveIntakeState", () => {
    it("should save state to file", async () => {
      const state: IntakeState = {
        workflowId: "test-workflow",
        workflowTitle: "Test Workflow",
        specDir: "/path/to/spec",
        originalInput: "Test input",
        fields: {
          goal: "Test goal",
        },
        pending: ["background", "scope"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await saveIntakeState(state, tmpDir);

      const filePath = path.join(adsDir, "intake-state.json");
      assert.ok(fs.existsSync(filePath), "State file should exist");

      const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      assert.strictEqual(content.workflowId, "test-workflow");
      assert.strictEqual(content.fields.goal, "Test goal");
    });

    it("should create state directory if not exists", async () => {
      const newTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ads-intake-new-"));
      try {
        const state: IntakeState = {
          workflowId: "test",
          workflowTitle: "Test",
          specDir: "/spec",
          originalInput: "input",
          fields: {},
          pending: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await saveIntakeState(state, newTmpDir);

        const filePath = resolveWorkspaceStatePath(newTmpDir, "intake-state.json");
        assert.ok(fs.existsSync(filePath));
      } finally {
        fs.rmSync(newTmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("loadIntakeState", () => {
    it("should load state from file", async () => {
      const state: IntakeState = {
        workflowId: "load-test",
        workflowTitle: "Load Test",
        specDir: "/spec",
        originalInput: "input",
        fields: { goal: "goal" },
        pending: ["background"],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      fs.writeFileSync(
        path.join(adsDir, "intake-state.json"),
        JSON.stringify(state)
      );

      const loaded = await loadIntakeState(tmpDir);
      assert.ok(loaded);
      assert.strictEqual(loaded.workflowId, "load-test");
      assert.strictEqual(loaded.fields.goal, "goal");
    });

    it("should return null when file does not exist", async () => {
      const loaded = await loadIntakeState(tmpDir);
      assert.strictEqual(loaded, null);
    });

    it("should handle malformed JSON gracefully", async () => {
      fs.writeFileSync(
        path.join(adsDir, "intake-state.json"),
        "not valid json"
      );

      const loaded = await loadIntakeState(tmpDir);
      assert.strictEqual(loaded, null);
    });

    it("should ensure pending is an array", async () => {
      const state = {
        workflowId: "test",
        workflowTitle: "Test",
        specDir: "/spec",
        originalInput: "input",
        fields: {},
        pending: null, // invalid
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      fs.writeFileSync(
        path.join(adsDir, "intake-state.json"),
        JSON.stringify(state)
      );

      const loaded = await loadIntakeState(tmpDir);
      assert.ok(loaded);
      assert.ok(Array.isArray(loaded.pending));
    });
  });

  describe("clearIntakeState", () => {
    it("should delete state file", async () => {
      const filePath = path.join(adsDir, "intake-state.json");
      fs.writeFileSync(filePath, "{}");
      assert.ok(fs.existsSync(filePath));

      await clearIntakeState(tmpDir);
      assert.ok(!fs.existsSync(filePath));
    });

    it("should not throw when file does not exist", async () => {
      await assert.doesNotReject(async () => {
        await clearIntakeState(tmpDir);
      });
    });
  });
});
