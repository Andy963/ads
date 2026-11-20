import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { createUpstreamCredentialStore } from "../../server/state/upstreamCredentialStore.js";
import { buildModelsEndpoint } from "../../server/utils/upstreamUrl.js";

describe("upstream credential storage", () => {
  let directory: string;
  let db: Database.Database;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-upstream-"));
    db = new Database(path.join(directory, "state.db"));
  });
  afterEach(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

  it("encrypts at rest, scopes owners, and returns only non-secret metadata", () => {
    const store = createUpstreamCredentialStore(db, { pepper: "test-only-pepper" });
    store.save("alice", { baseUrl: "provider.test/v1/responses", apiKey: "unit-test-only-secret", provider: "custom" });
    const raw = JSON.stringify(db.prepare("SELECT * FROM kv_state").all());
    assert.ok(!raw.includes("unit-test-only-secret"));
    assert.equal(fs.statSync(db.name).mode & 0o777, 0o600);
    assert.deepEqual(store.getMetadata("alice"), { baseUrl: "https://provider.test/v1", provider: "custom", hasApiKey: true });
    assert.equal(store.getCredentials("alice")?.apiKey, "unit-test-only-secret");
    assert.equal(store.getCredentials("bob"), null);
    assert.throws(() => store.getCredentials(""), /authenticated owner/);
    const reopened = createUpstreamCredentialStore(db, { pepper: "test-only-pepper" });
    assert.equal(reopened.getCredentials("alice")?.apiKey, "unit-test-only-secret");
    assert.throws(() => createUpstreamCredentialStore(db, { pepper: "different-pepper" }).getCredentials("alice"), /cannot be decrypted/);
  });

  it("authenticates the owner, endpoint, and ciphertext and permits explicit repair", () => {
    const store = createUpstreamCredentialStore(db, { pepper: "test-only-pepper" });
    store.save("alice", { baseUrl: "https://provider.test", apiKey: "test-secret", provider: "openai" });
    const row = db.prepare("SELECT value FROM kv_state WHERE key = 'alice'").get() as { value: string };
    const original = JSON.parse(row.value);
    for (const tampered of [
      { ...original, baseUrl: "https://different.test/v1" },
      { ...original, provider: "different" },
      { ...original, ciphertext: Buffer.from("changed").toString("base64") },
    ]) {
      db.prepare("UPDATE kv_state SET value = ? WHERE key = 'alice'").run(JSON.stringify(tampered));
      assert.throws(() => store.getCredentials("alice"), /cannot be decrypted/);
    }
    db.prepare("UPDATE kv_state SET key = 'bob', value = ?").run(row.value);
    assert.throws(() => store.getCredentials("bob"), /cannot be decrypted/);
    store.save("bob", { baseUrl: "https://new.test/v1", apiKey: "replacement", provider: "openai" });
    assert.equal(store.getCredentials("bob")?.apiKey, "replacement");
  });

  it("uses a stable private key file when no pepper is configured", () => {
    const keyPath = path.join(directory, "credentials.key");
    const store = createUpstreamCredentialStore(db, { pepper: "", keyPath });
    store.save("alice", { baseUrl: "https://provider.test", apiKey: "test-secret", provider: "openai" });
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(keyPath).length, 32);
    assert.equal(createUpstreamCredentialStore(db, { pepper: "", keyPath }).getCredentials("alice")?.apiKey, "test-secret");
    fs.chmodSync(keyPath, 0o644);
    assert.throws(() => store.getCredentials("alice"), /cannot be decrypted/);
  });

  it("supports independent encrypted credential profiles", () => {
    const store = createUpstreamCredentialStore(db, { pepper: "test-only-pepper" });
    store.save("alice", { baseUrl: "https://one.test/v1", apiKey: "profile-one-secret", provider: "one" }, "one");
    store.save("alice", { baseUrl: "https://two.test/v1", apiKey: "profile-two-secret", provider: "two" }, "two");

    const raw = JSON.stringify(db.prepare("SELECT * FROM kv_state").all());
    assert.doesNotMatch(raw, /profile-one-secret|profile-two-secret/);
    assert.equal(store.getCredentials("alice", "one")?.apiKey, "profile-one-secret");
    assert.equal(store.getCredentials("alice", "two")?.apiKey, "profile-two-secret");
    assert.equal(store.getCredentials("alice")?.apiKey, undefined);
  });
});

describe("upstream model endpoint normalization", () => {
  for (const input of ["https://provider.test", "https://provider.test/", "https://provider.test/v1/", "provider.test/v1",
    "https://provider.test/v1/responses", "https://provider.test/v1/chat/completions", "https://provider.test/v1/completions",
    "https://provider.test/v1/models?ignored=true#fragment", "//provider.test/v1"]) {
    it(`normalizes ${input}`, () => assert.equal(buildModelsEndpoint(input), "https://provider.test/v1/models"));
  }
  it("preserves custom base paths and explicitly configured HTTP", () => {
    assert.equal(buildModelsEndpoint("http://localhost:1234/proxy/v2/responses/"), "http://localhost:1234/proxy/v2/models");
  });
  for (const input of ["", "ftp://provider.test", "https://user:password@provider.test", "not a URL", "javascript:alert(1)"]) {
    it(`rejects unsafe or invalid input ${input}`, () => assert.throws(() => buildModelsEndpoint(input)));
  }
});
