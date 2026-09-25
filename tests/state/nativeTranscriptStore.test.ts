import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getStateDatabase,
  resetStateDatabaseForTests,
} from "../../server/state/database.js";
import { NativeTranscriptStore } from "../../server/state/nativeTranscriptStore.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  resetStateDatabaseForTests();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(redactions: string[] = []): {
  dbPath: string;
  store: NativeTranscriptStore;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-transcript-store-"));
  temporaryDirectories.push(directory);
  const dbPath = path.join(directory, "state.db");
  return {
    dbPath,
    store: new NativeTranscriptStore(getStateDatabase(dbPath), { redactions }),
  };
}

describe("NativeTranscriptStore", () => {
  it("persists ordered messages and tool artifacts while redacting secrets", () => {
    const { dbPath, store } = createStore(["secret-api-key", "environment-secret"]);
    const transcriptId = "transcript-complete";
    const db = getStateDatabase(dbPath);
    db.prepare(`
      INSERT INTO thread_state (namespace, user_hash, thread_id, cwd, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("codex", "user-hash", "codex-thread-id", "/tmp/codex-project", 1234);

    store.beginTurn({
      transcriptId,
      turnId: "turn-1",
      messages: [{ role: "user", content: "token=secret-api-key" }],
      entries: [{ kind: "message", message: { role: "user", content: "token=secret-api-key" } }],
      provider: { provider: "test", model: "test-model" },
    });
    store.updateTurn({
      transcriptId,
      turnId: "turn-1",
      status: "completed",
      messages: [
        { role: "user", content: "token=[redacted]" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call-1", type: "function", function: { name: "exec_command", arguments: "{}" } }],
        },
        { role: "tool", content: "environment-secret", tool_call_id: "call-1" },
      ],
      entries: [
        { kind: "message", message: { role: "user", content: "token=[redacted]" } },
        {
          kind: "command",
          toolCallId: "call-1",
          command: "echo safe",
          status: "completed",
          exitCode: 0,
          output: "safe",
        },
        { kind: "message", message: { role: "tool", content: "[redacted]", tool_call_id: "call-1" } },
      ],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    });

    const turns = store.listTurns(transcriptId);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.status, "completed");
    assert.deepEqual(turns[0]?.entries.map((entry) => entry.kind), ["message", "command", "message"]);
    assert.deepEqual(turns[0]?.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 });

    const rawRows = db
      .prepare("SELECT messages_json, entries_json, usage_json, provider_json FROM native_transcript_turns")
      .all();
    const raw = JSON.stringify(rawRows);
    assert.doesNotMatch(raw, /secret-api-key/);
    assert.doesNotMatch(raw, /environment-secret/);
    assert.deepEqual(
      db.prepare("SELECT namespace, user_hash, thread_id, cwd, updated_at FROM thread_state").get(),
      {
        namespace: "codex",
        user_hash: "user-hash",
        thread_id: "codex-thread-id",
        cwd: "/tmp/codex-project",
        updated_at: 1234,
      },
    );
  });

  it("marks a running turn interrupted and excludes it from restoration", () => {
    const { store } = createStore();
    const transcriptId = "transcript-interrupted";
    store.beginTurn({
      transcriptId,
      turnId: "turn-running",
      messages: [{ role: "user", content: "run the command" }],
      entries: [{ kind: "message", message: { role: "user", content: "run the command" } }],
      provider: { provider: "test", model: "test-model" },
    });

    assert.deepEqual(store.loadCompletedMessages(transcriptId), []);
    const turns = store.listTurns(transcriptId);
    assert.equal(turns[0]?.status, "interrupted");
    assert.match(turns[0]?.errorMessage ?? "", /interrupted/);
  });

  it("does not allow an old writer to complete an interrupted turn", () => {
    const { store } = createStore();
    const transcriptId = "transcript-writer-fence";
    store.claimTranscript(transcriptId, "old-writer");
    assert.throws(
      () => store.beginTurn({
        transcriptId,
        turnId: "stale-turn",
        messages: [{ role: "user", content: "stale" }],
        entries: [{ kind: "message", message: { role: "user", content: "stale" } }],
        provider: { provider: "test", model: "test-model" },
        writerId: "stale-writer",
      }),
      /superseded/,
    );
    store.beginTurn({
      transcriptId,
      turnId: "turn-writer-fence",
      messages: [{ role: "user", content: "run" }],
      entries: [{ kind: "message", message: { role: "user", content: "run" } }],
      provider: { provider: "test", model: "test-model" },
      writerId: "old-writer",
    });

    store.claimTranscript(transcriptId, "new-writer");
    assert.throws(
      () => store.updateTurn({
        transcriptId,
        turnId: "turn-writer-fence",
        status: "completed",
        messages: [{ role: "user", content: "run" }],
        entries: [{ kind: "message", message: { role: "user", content: "run" } }],
        usage: null,
        writerId: "old-writer",
      }),
      /turn not found|superseded/,
    );
    assert.equal(store.listTurns(transcriptId, "new-writer")[0]?.status, "interrupted");
  });

  it("fences every running-turn mutation after ownership changes", () => {
    const { store } = createStore();
    const transcriptId = "transcript-atomic-writer-fence";
    store.claimTranscript(transcriptId, "writer-one");
    store.beginTurn({
      transcriptId,
      turnId: "turn-one",
      messages: [{ role: "user", content: "run" }],
      entries: [{ kind: "message", message: { role: "user", content: "run" } }],
      provider: { provider: "test", model: "test-model" },
      writerId: "writer-one",
    });

    store.claimTranscript(transcriptId, "writer-two");
    assert.throws(
      () => store.updateTurn({
        transcriptId,
        turnId: "turn-one",
        status: "completed",
        messages: [{ role: "user", content: "run" }],
        entries: [{ kind: "message", message: { role: "user", content: "run" } }],
        usage: null,
        writerId: "writer-one",
      }),
      /superseded/,
    );
    assert.throws(
      () => store.beginTurn({
        transcriptId,
        turnId: "stale-turn",
        messages: [{ role: "user", content: "stale" }],
        entries: [{ kind: "message", message: { role: "user", content: "stale" } }],
        provider: { provider: "test", model: "test-model" },
        writerId: "writer-one",
      }),
      /superseded/,
    );
  });

  it("redacts explicit credentials even when they are shorter than four characters", () => {
    const { dbPath, store } = createStore(["abc"]);
    const transcriptId = "transcript-short-credential";
    store.beginTurn({
      transcriptId,
      turnId: "short-credential-turn",
      messages: [{ role: "user", content: "credential=abc" }],
      entries: [{ kind: "message", message: { role: "user", content: "credential=abc" } }],
      provider: { provider: "test", model: "test-model" },
    });

    const raw = JSON.stringify(
      getStateDatabase(dbPath)
        .prepare("SELECT messages_json, entries_json FROM native_transcript_turns")
        .all(),
    );
    assert.doesNotMatch(raw, /abc/);
    assert.match(raw, /\[redacted\]/);
  });

  it("redacts a bare short credential without replacing it inside unrelated text", () => {
    const { dbPath, store } = createStore(["q", "/"]);
    const transcriptId = "transcript-bare-short-credential";
    store.beginTurn({
      transcriptId,
      turnId: "bare-short-credential-turn",
      messages: [{ role: "user", content: "q" }],
      entries: [{ kind: "message", message: { role: "user", content: "q" } }],
      provider: { provider: "test", model: "test-model" },
    });
    store.beginTurn({
      transcriptId,
      turnId: "unrelated-short-text-turn",
      messages: [{ role: "user", content: "q /tmp/q" }],
      entries: [{ kind: "message", message: { role: "user", content: "q /tmp/q" } }],
      provider: { provider: "test", model: "test-model" },
    });

    const raw = JSON.stringify(
      getStateDatabase(dbPath)
        .prepare("SELECT messages_json, entries_json FROM native_transcript_turns")
        .all(),
    );
    assert.match(raw, /q \/tmp\/q/);
    assert.match(raw, /\[redacted\]/);
  });

  it("redacts common credential formats before persistence", () => {
    const { dbPath, store } = createStore();
    const transcriptId = "transcript-common-credentials";
    const credentials = [
      ["gh", "p", "_abcdefghijklmnopqrstuvwxyz1234567890"].join(""),
      ["AKIA", "IOSFODNN7", "EXAMPLE"].join(""),
      ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "signature"].join("."),
      "https://alice:password@example.test/path",
    ];

    store.beginTurn({
      transcriptId,
      turnId: "turn-credentials",
      messages: [{ role: "user", content: credentials.join("\n") }],
      entries: [{ kind: "message", message: { role: "user", content: credentials.join("\n") } }],
      provider: { provider: "test", model: "test-model" },
    });

    const raw = JSON.stringify(
      getStateDatabase(dbPath)
        .prepare("SELECT messages_json, entries_json FROM native_transcript_turns")
        .all(),
    );
    for (const credential of credentials.slice(0, 3)) {
      assert.equal(raw.includes(credential), false);
    }
    assert.doesNotMatch(raw, /alice:password/);
    assert.match(raw, /\[redacted\]/);
  });

  it("persists large tool-call arguments and results without corrupting restoration", () => {
    const { store } = createStore();
    const transcriptId = "transcript-large-tool-chain";
    const largeArguments = JSON.stringify({ path: "large.txt", content: "x".repeat(70 * 1024) });
    const largeResult = "y".repeat(80 * 1024);
    const messages = [
      { role: "user" as const, content: "apply a large patch" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{
          id: "large-call",
          type: "function" as const,
          function: { name: "apply_patch", arguments: largeArguments },
        }],
      },
      { role: "tool" as const, content: largeResult, tool_call_id: "large-call" },
    ];
    store.beginTurn({
      transcriptId,
      turnId: "large-turn",
      messages,
      entries: messages.map((message) => ({ kind: "message" as const, message })),
      provider: { provider: "test", model: "test-model" },
    });
    store.updateTurn({
      transcriptId,
      turnId: "large-turn",
      status: "completed",
      messages,
      entries: messages.map((message) => ({ kind: "message" as const, message })),
      usage: null,
    });

    const restored = store.loadCompletedMessages(transcriptId);
    assert.equal(restored.length, 3);
    assert.equal(restored[1]?.tool_calls?.[0]?.function.arguments, largeArguments);
    assert.equal(restored[2]?.content, largeResult);
  });

  it("redacts escaped and delimiter-delimited secrets without corrupting tool arguments", () => {
    const quotedSecret = "quoted\"slash\\LEAKQUOTE";
    const spacedSecret = "correct horse battery staple LEAKSPACE";
    const { dbPath, store } = createStore([quotedSecret, spacedSecret]);
    const transcriptId = "transcript-structured-secrets";
    const toolArguments = JSON.stringify({
      password: quotedSecret,
      note: spacedSecret,
      nested: { api_key: quotedSecret },
    });
    const jsonContent = JSON.stringify({ credential: quotedSecret });
    const messages = [
      { role: "user" as const, content: `password=${spacedSecret}; next=value` },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [{
          id: "secret-call",
          type: "function" as const,
          function: { name: "apply_patch", arguments: toolArguments },
        }],
      },
      { role: "tool" as const, content: jsonContent, tool_call_id: "secret-call" },
    ];
    store.beginTurn({
      transcriptId,
      turnId: "secret-turn",
      messages,
      entries: messages.map((message) => ({ kind: "message" as const, message })),
      provider: { provider: "test", model: "test-model" },
    });
    store.updateTurn({
      transcriptId,
      turnId: "secret-turn",
      status: "completed",
      messages,
      entries: messages.map((message) => ({ kind: "message" as const, message })),
      usage: null,
    });

    const raw = JSON.stringify(
      getStateDatabase(dbPath)
        .prepare("SELECT messages_json, entries_json FROM native_transcript_turns")
        .all(),
    );
    assert.doesNotMatch(raw, /LEAKQUOTE|LEAKSPACE/);

    const restored = store.loadCompletedMessages(transcriptId);
    assert.match(restored[0]?.content ?? "", /password=\[redacted\]; next=value/);
    const restoredArguments = JSON.parse(restored[1]?.tool_calls?.[0]?.function.arguments ?? "{}") as {
      password: string;
      note: string;
      nested: { api_key: string };
    };
    assert.deepEqual(restoredArguments, {
      password: "[redacted]",
      note: "[redacted]",
      nested: { api_key: "[redacted]" },
    });
    assert.deepEqual(JSON.parse(restored[2]?.content ?? "{}"), { credential: "[redacted]" });
  });

  it("redacts broad credential field names and preserves own __proto__ fields", () => {
    const { dbPath, store } = createStore();
    const transcriptId = "transcript-broad-credentials";
    const toolArguments = JSON.parse(JSON.stringify({
      client_secret: "client-secret-value",
      nested: {
        clientSecret: "camel-secret-value",
        private_key: "private-key-value",
        signingKey: "signing-key-value",
        "X-Auth-Token": "auth-token-value",
      },
    }));
    Object.defineProperty(toolArguments, "__proto__", {
      value: { safe: "proto-value" },
      enumerable: true,
      configurable: true,
    });
    const messages = [{
      role: "assistant" as const,
      content: null,
      tool_calls: [{
        id: "credential-call",
        type: "function" as const,
        function: { name: "apply_patch", arguments: JSON.stringify(toolArguments) },
      }],
    }];

    store.beginTurn({
      transcriptId,
      turnId: "credential-turn",
      messages,
      entries: [{ kind: "message", message: messages[0] }],
      provider: { provider: "test", model: "test-model" },
    });
    store.updateTurn({
      transcriptId,
      turnId: "credential-turn",
      status: "completed",
      messages,
      entries: [{ kind: "message", message: messages[0] }],
      usage: null,
    });

    const raw = JSON.stringify(
      getStateDatabase(dbPath)
        .prepare("SELECT messages_json, entries_json FROM native_transcript_turns")
        .all(),
    );
    assert.doesNotMatch(raw, /client-secret-value|camel-secret-value|private-key-value|signing-key-value|auth-token-value/);

    const restoredArguments = JSON.parse(
      store.loadCompletedMessages(transcriptId)[0]?.tool_calls?.[0]?.function.arguments ?? "{}",
    ) as Record<string, unknown>;
    assert.equal(Object.hasOwn(restoredArguments, "__proto__"), true);
    assert.deepEqual(restoredArguments.__proto__, { safe: "proto-value" });
    assert.equal(restoredArguments.client_secret, "[redacted]");
    assert.deepEqual(restoredArguments.nested, {
      clientSecret: "[redacted]",
      private_key: "[redacted]",
      signingKey: "[redacted]",
      "X-Auth-Token": "[redacted]",
    });
  });
});
