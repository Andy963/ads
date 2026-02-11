import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveSoulPath,
  readSoul,
  writeSoul,
  listPreferences,
  setPreference,
  deletePreference,
} from "../../src/memory/soul.js";
import { resolveWorkspaceStatePath } from "../../src/workspace/adsPaths.js";
import { installTempAdsStateDir, type TempAdsStateDir } from "../helpers/adsStateDir.js";

describe("soul store", () => {
  let workspace: string;
  let adsState: TempAdsStateDir | null = null;

  before(() => {
    adsState = installTempAdsStateDir("ads-state-soul-");
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-soul-"));
    resolveWorkspaceStatePath(workspace);
  });

  after(() => {
    adsState?.restore();
    adsState = null;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("resolveSoulPath returns path ending with soul.md", () => {
    const p = resolveSoulPath(workspace);
    assert.ok(p.endsWith("soul.md"), `expected path ending with soul.md, got ${p}`);
  });

  it("readSoul returns empty string when file missing", () => {
    const freshWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-soul-fresh-"));
    try {
      const content = readSoul(freshWorkspace);
      assert.equal(content, "");
    } finally {
      fs.rmSync(freshWorkspace, { recursive: true, force: true });
    }
  });

  it("writeSoul creates file and readSoul returns content", () => {
    const body = "# Soul\n\nHello world\n";
    writeSoul(workspace, body);
    const content = readSoul(workspace);
    assert.equal(content, body);
  });

  it("writeSoul creates parent directories", () => {
    const freshWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-soul-dirs-"));
    try {
      const body = "# Soul\n\nCreated with dirs\n";
      writeSoul(freshWorkspace, body);
      const content = readSoul(freshWorkspace);
      assert.equal(content, body);
    } finally {
      fs.rmSync(freshWorkspace, { recursive: true, force: true });
    }
  });
});

describe("preference management", () => {
  let workspace: string;
  let adsState: TempAdsStateDir | null = null;

  before(() => {
    adsState = installTempAdsStateDir("ads-state-pref-");
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-pref-"));
    resolveWorkspaceStatePath(workspace);
  });

  after(() => {
    adsState?.restore();
    adsState = null;
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("setPreference creates soul file with template if missing", () => {
    const freshWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-pref-template-"));
    try {
      setPreference(freshWorkspace, "lang", "en");
      const content = readSoul(freshWorkspace);
      assert.ok(content.includes("## Preferences"), "should contain Preferences section");
      assert.ok(content.includes("lang"), "should contain the preference key");
    } finally {
      fs.rmSync(freshWorkspace, { recursive: true, force: true });
    }
  });

  it("setPreference adds new preference", () => {
    setPreference(workspace, "theme", "dark");
    const prefs = listPreferences(workspace);
    const found = prefs.find((p) => p.key === "theme");
    assert.ok(found, "preference 'theme' should exist");
    assert.equal(found.value, "dark");
  });

  it("setPreference updates existing preference", () => {
    setPreference(workspace, "theme", "light");
    const prefs = listPreferences(workspace);
    const matches = prefs.filter((p) => p.key === "theme");
    assert.equal(matches.length, 1, "should have exactly one 'theme' preference");
    assert.equal(matches[0].value, "light");
  });

  it("setPreference is case-insensitive for key lookup", () => {
    const freshWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-pref-case-"));
    try {
      setPreference(freshWorkspace, "Lang", "en");
      setPreference(freshWorkspace, "lang", "zh");
      const prefs = listPreferences(freshWorkspace);
      const matches = prefs.filter((p) => p.key.toLowerCase() === "lang");
      assert.equal(matches.length, 1, "should not duplicate on case-insensitive match");
      assert.equal(matches[0].value, "zh");
    } finally {
      fs.rmSync(freshWorkspace, { recursive: true, force: true });
    }
  });

  it("listPreferences returns empty array when no preferences", () => {
    const freshWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-pref-empty-"));
    try {
      const prefs = listPreferences(freshWorkspace);
      assert.deepEqual(prefs, []);
    } finally {
      fs.rmSync(freshWorkspace, { recursive: true, force: true });
    }
  });

  it("listPreferences returns all preferences", () => {
    const freshWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-pref-all-"));
    try {
      setPreference(freshWorkspace, "lang", "en");
      setPreference(freshWorkspace, "theme", "dark");
      setPreference(freshWorkspace, "editor", "vim");
      const prefs = listPreferences(freshWorkspace);
      assert.equal(prefs.length, 3);
      const keys = prefs.map((p) => p.key).sort();
      assert.deepEqual(keys, ["editor", "lang", "theme"]);
    } finally {
      fs.rmSync(freshWorkspace, { recursive: true, force: true });
    }
  });

  it("deletePreference removes existing preference", () => {
    const freshWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-pref-del-"));
    try {
      setPreference(freshWorkspace, "color", "blue");
      const removed = deletePreference(freshWorkspace, "color");
      assert.equal(removed, true);
      const prefs = listPreferences(freshWorkspace);
      const found = prefs.find((p) => p.key === "color");
      assert.equal(found, undefined, "deleted preference should not appear");
    } finally {
      fs.rmSync(freshWorkspace, { recursive: true, force: true });
    }
  });

  it("deletePreference returns false for non-existent key", () => {
    const freshWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-pref-delnone-"));
    try {
      const removed = deletePreference(freshWorkspace, "nonexistent");
      assert.equal(removed, false);
    } finally {
      fs.rmSync(freshWorkspace, { recursive: true, force: true });
    }
  });

  it("deletePreference is case-insensitive", () => {
    const freshWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-pref-delcase-"));
    try {
      setPreference(freshWorkspace, "Font", "monospace");
      const removed = deletePreference(freshWorkspace, "font");
      assert.equal(removed, true);
      const prefs = listPreferences(freshWorkspace);
      assert.equal(prefs.length, 0);
    } finally {
      fs.rmSync(freshWorkspace, { recursive: true, force: true });
    }
  });

  it("preserves content outside Preferences section", () => {
    const freshWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-pref-preserve-"));
    try {
      const initialContent = "# Soul\n\n## Notes\n\nImportant notes here.\n\n## Preferences\n\n";
      writeSoul(freshWorkspace, initialContent);
      setPreference(freshWorkspace, "lang", "en");
      const content = readSoul(freshWorkspace);
      assert.ok(content.includes("## Notes"), "Notes section should be preserved");
      assert.ok(content.includes("Important notes here."), "Notes content should be preserved");
      assert.ok(content.includes("- **lang**: en"), "Preference should be present");
    } finally {
      fs.rmSync(freshWorkspace, { recursive: true, force: true });
    }
  });
});
