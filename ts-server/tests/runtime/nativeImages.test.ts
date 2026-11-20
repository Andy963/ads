import "../helpers/adsStateDir.js";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { NativeAgentAdapter } from "../../server/agents/adapters/nativeAgentAdapter.js";
import type { Input } from "../../server/agents/protocol/types.js";
import { NativeImageInputError, NativeImageStore } from "../../server/runtime/nativeImages.js";
import { estimateNativeMessageTokens, projectNativeContext } from "../../server/runtime/nativeContextProjection.js";
import { completeNativeChat, type NativeChatMessage, type NativeImageReference } from "../../server/runtime/openAiCompatibleClient.js";
import { getStateDatabase, resetStateDatabaseForTests } from "../../server/state/database.js";
import { NativeTranscriptStore } from "../../server/state/nativeTranscriptStore.js";
import { resolveWorkspaceStatePath } from "../../server/workspace/adsPaths.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNAAAAABJRU5ErkJggg==", "base64");
const expectedImage = { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } };
let workspace: string;
let source: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-native-images-"));
  source = path.join(workspace, "image.png");
  fs.writeFileSync(source, png);
});

afterEach(() => {
  resetStateDatabaseForTests();
  fs.rmSync(workspace, { recursive: true, force: true });
});

function model() {
  return { model: "gemini-test", provider: "gemini", baseUrl: "https://provider.test/v1", apiKey: "iVBORw0K" };
}

function reply(streaming = true, tool = false): Response {
  const content = tool ? null : "Image received";
  const toolCalls = tool ? [{
    id: "read-1", type: "function", function: { name: "read_file", arguments: '{"file":"note.txt"}' },
  }] : null;
  const finish = tool ? "tool_calls" : "stop";
  if (!streaming) {
    return new Response(JSON.stringify({ choices: [{ message: { content, tool_calls: toolCalls }, finish_reason: finish }] }), {
      headers: { "content-type": "application/json" },
    });
  }
  const delta = { content, tool_calls: toolCalls?.map(call => ({ index: 0, ...call })) ?? null };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function imageInput(): Input {
  return [{ type: "text", text: "Describe this" }, { type: "local_image", path: source }, { type: "text", text: "Be brief" }];
}

function firstImage(content: NativeChatMessage["content"]): NativeImageReference {
  assert.ok(Array.isArray(content));
  const image = content.find(part => part.type === "image_ref");
  assert.ok(image && image.type === "image_ref");
  return image;
}

describe("native image input", () => {
  it("sends image bytes through an actual local Chat Completions HTTP endpoint", async () => {
    let received: Record<string, unknown> | undefined;
    let requestPath: string | undefined;
    const server = http.createServer(async (request, response) => {
      requestPath = request.url;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "Received over HTTP", tool_calls: null }, finish_reason: "stop" }] }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner", workspaceRoot: workspace,
        modelResolver: { resolve: () => ({ ...model(), baseUrl: `http://127.0.0.1:${address.port}/v1` }) },
      });
      assert.equal((await adapter.send(imageInput(), { streaming: false })).response, "Received over HTTP");
      assert.equal(requestPath, "/v1/chat/completions");
      assert.equal(received?.model, "gemini-test");
      assert.deepEqual((received?.messages as NativeChatMessage[])[0]?.content, [
        { type: "text", text: "Describe this" }, expectedImage, { type: "text", text: "Be brief" },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  for (const streaming of [true, false]) {
    it(`sends ordered multimodal content with streaming=${streaming} without leaking local references`, async () => {
      const requests: NativeChatMessage[][] = [];
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner", workspaceRoot: workspace,
        modelResolver: { resolve: model },
        fetchImpl: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)).messages);
          return reply(streaming);
        },
      });
      assert.ok(adapter.getCapabilities().includes("images"));
      await adapter.send(imageInput(), { streaming });
      assert.deepEqual(requests[0]?.[0]?.content, [
        { type: "text", text: "Describe this" }, expectedImage, { type: "text", text: "Be brief" },
      ]);
      fs.unlinkSync(source);
      await adapter.send("What color?", { streaming });
      assert.deepEqual(requests[1]?.map(message => message.role), ["user", "assistant", "user"]);
      assert.deepEqual(requests[1]?.[0]?.content, requests[0]?.[0]?.content);
      assert.doesNotMatch(JSON.stringify(requests), /image_ref|sha256/);
      assert.ok(!JSON.stringify(requests).includes(workspace));
      assert.equal(fs.existsSync(resolveWorkspaceStatePath(workspace, "attachments")), false, "Ephemeral sessions must not persist image bytes");
    });
  }

  it("preserves images through transient retry, tool rounds, upload cleanup, and durable restore", async () => {
    fs.writeFileSync(path.join(workspace, "note.txt"), "Tool result");
    const db = getStateDatabase(path.join(workspace, "state.db"));
    const store = new NativeTranscriptStore(db);
    const requests: NativeChatMessage[][] = [];
    const events: unknown[] = [];
    const createAdapter = () => new NativeAgentAdapter({
      credentialOwner: "test-owner", workspaceRoot: workspace,
      transcriptId: "images", transcriptStore: store, retryBackoffMs: [0],
      modelResolver: { resolve: model },
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)).messages);
        if (requests.length === 1) return new Response("Temporary failure", { status: 503 });
        return reply(true, requests.length === 2);
      },
    });
    const adapter = createAdapter();
    adapter.onEvent(event => events.push(event));
    await adapter.send(imageInput());
    fs.unlinkSync(source);
    const restored = createAdapter();
    assert.equal(restored.hasRestoredTranscript(), true);
    await restored.send("Explain the image again");
    assert.equal(requests.length, 4);
    for (const request of requests) assert.deepEqual(request[0]?.content, requests[0]?.[0]?.content);
    assert.deepEqual(requests[2]?.map(message => message.role), ["user", "assistant", "tool"]);
    assert.deepEqual(requests[3]?.map(message => message.role), ["user", "assistant", "tool", "assistant", "user"]);
    assert.deepEqual(store.listTurns("images").map(turn => turn.status), ["completed", "completed"]);
    const raw = JSON.stringify(db.prepare("SELECT messages_json, entries_json FROM native_transcript_turns").all());
    assert.doesNotMatch(raw, /data:image|base64|iVBORw0K/);
    assert.doesNotMatch(JSON.stringify(events), /data:image|base64|iVBORw0K/);
    const ref = firstImage(store.loadCompletedMessages("images")[0]?.content ?? null);
    const folder = resolveWorkspaceStatePath(workspace, "attachments", ref.sha256.slice(0, 2));
    assert.deepEqual(fs.readdirSync(folder), [`${ref.sha256}.png`]);
    assert.deepEqual(fs.readFileSync(path.join(folder, `${ref.sha256}.png`)), png);
  });

  it("allows image-only prompts and keeps plain text requests unchanged", async () => {
    const bodies: NativeChatMessage[][] = [];
    const adapter = new NativeAgentAdapter({
      credentialOwner: "test-owner", workspaceRoot: workspace,
      modelResolver: { resolve: model },
      fetchImpl: async (_url, init) => { bodies.push(JSON.parse(String(init?.body)).messages); return reply(); },
    });
    await adapter.send([{ type: "local_image", path: source }]);
    assert.deepEqual(bodies[0]?.[0]?.content, [expectedImage]);
    adapter.reset({ clearPersistedState: true });
    await adapter.send([{ type: "text", text: "First" }, { type: "text", text: "Second" }]);
    assert.deepEqual(bodies[1], [{ role: "user", content: "First\nSecond" }]);
  });

  for (const capability of ["unsupported", "unknown"] as const) {
    it(`rejects explicitly ${capability} images before reading or fetching`, async () => {
      const adapter = new NativeAgentAdapter({
        credentialOwner: "test-owner", workspaceRoot: workspace,
        modelResolver: { resolve: () => ({ ...model(), capabilities: { imageInput: capability } }) },
        fetchImpl: async () => { assert.fail("No upstream request expected"); },
      });
      assert.ok(!adapter.getCapabilities().includes("images"));
      await assert.rejects(adapter.send([{ type: "local_image", path: "/missing-image" }]), /imageInput/);
    });
  }

  it("does not silently drop prior images when switching to a text-only model", async () => {
    let supported = true;
    let fetchCalls = 0;
    const adapter = new NativeAgentAdapter({
      credentialOwner: "test-owner", workspaceRoot: workspace,
      modelResolver: { resolve: () => ({ ...model(), capabilities: { imageInput: supported ? "supported" : "unsupported" } }) },
      fetchImpl: async () => { fetchCalls += 1; return reply(); },
    });
    await adapter.send(imageInput());
    supported = false;
    await assert.rejects(adapter.send("Recall that image"), /imageInput/);
    assert.equal(fetchCalls, 1);
  });

  it("rejects missing, spoofed, oversized, and symlinked images without retries or partial user history", async () => {
    const invalid = path.join(workspace, "invalid.png");
    fs.writeFileSync(invalid, "Not an image");
    const oversized = path.join(workspace, "oversized.png");
    const fd = fs.openSync(oversized, "w");
    fs.ftruncateSync(fd, 25 * 1024 * 1024 + 1);
    fs.closeSync(fd);
    const symlink = path.join(workspace, "linked.png");
    fs.symlinkSync(source, symlink);
    const requests: NativeChatMessage[][] = [];
    const adapter = new NativeAgentAdapter({
      credentialOwner: "test-owner", workspaceRoot: workspace, retryBackoffMs: [0],
      modelResolver: { resolve: model },
      fetchImpl: async (_url, init) => { requests.push(JSON.parse(String(init?.body)).messages); return reply(); },
    });
    for (const file of [path.join(workspace, "missing.png"), invalid, oversized, symlink, workspace]) {
      await assert.rejects(adapter.send([{ type: "local_image", path: file, mime_type: "image/png" }]), NativeImageInputError);
    }
    assert.equal(requests.length, 0);
    await adapter.send("Try text");
    assert.deepEqual(requests[0], [{ role: "user", content: "Try text" }]);
  });

  it("deduplicates concurrent durable imports and scopes references to the workspace", async () => {
    const signal = new AbortController().signal;
    const images = new NativeImageStore(workspace, true);
    const contents = await Promise.all(Array.from({ length: 3 }, () => images.prepare(imageInput(), workspace, signal)));
    assert.deepEqual(contents[0], contents[1]);
    const ref = firstImage(contents[0]!);
    const folder = resolveWorkspaceStatePath(workspace, "attachments", ref.sha256.slice(0, 2));
    assert.deepEqual(fs.readdirSync(folder), [`${ref.sha256}.png`]);
    assert.equal(fs.statSync(path.join(folder, `${ref.sha256}.png`)).mode & 0o777, 0o600);
    const otherWorkspace = new NativeImageStore(path.join(workspace, "other"), true);
    await assert.rejects(otherWorkspace.read(ref, signal), NativeImageInputError);
    await assert.rejects(images.read({ ...ref, sha256: "../outside" }, signal), /invalid stored image reference/);
    fs.writeFileSync(path.join(folder, `${ref.sha256}.png`), "Corrupt bytes");
    await assert.rejects(images.read(ref, signal), /integrity/);
    await assert.rejects(images.prepare(imageInput(), workspace, signal), /integrity/);
  });

  it("recognizes JPEG, WebP, and GIF bytes independently of the upload extension", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0);
    webp.writeUInt32LE(22, 4);
    webp.write("WEBPVP8X", 8);
    webp.writeUInt32LE(10, 16);
    const gif = Buffer.from("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b", "hex");
    const images = new NativeImageStore(workspace, false);
    for (const [mediaType, bytes] of [["image/jpeg", jpeg], ["image/webp", webp], ["image/gif", gif]] as const) {
      fs.writeFileSync(source, bytes);
      const content = await images.prepare([{ type: "local_image", path: source, mime_type: "image/png" }], workspace, new AbortController().signal);
      assert.equal(firstImage(content).mediaType, mediaType);
    }
  });

  it("rejects oversized aggregate request images before fetch without changing references", async () => {
    const bytes = Buffer.alloc(17 * 1024 * 1024);
    png.copy(bytes);
    const ref: NativeImageReference = {
      type: "image_ref", sha256: createHash("sha256").update(bytes).digest("hex"), mediaType: "image/png", width: 1, height: 1,
    };
    await assert.rejects(completeNativeChat({
      ...model(), messages: [{ role: "user", content: [ref, ref, ref] }], tools: [],
      readImage: async () => bytes,
      fetchImpl: async () => { assert.fail("Oversized image requests must not be sent"); },
    }), /request images exceed 50 MiB/);
    assert.equal(ref.type, "image_ref");
  });

  it("rejects a missing restored attachment without a provider retry or a fake successful turn", async () => {
    const store = new NativeTranscriptStore(getStateDatabase(path.join(workspace, "state.db")));
    let fetchCalls = 0;
    const createAdapter = () => new NativeAgentAdapter({
      credentialOwner: "test-owner", workspaceRoot: workspace, transcriptId: "missing-image", transcriptStore: store,
      modelResolver: { resolve: model }, retryBackoffMs: [0],
      fetchImpl: async () => { fetchCalls += 1; return reply(); },
    });
    await createAdapter().send(imageInput());
    const ref = firstImage(store.loadCompletedMessages("missing-image")[0]!.content);
    fs.unlinkSync(resolveWorkspaceStatePath(workspace, "attachments", ref.sha256.slice(0, 2), `${ref.sha256}.png`));
    await assert.rejects(createAdapter().send("Recall the image"), NativeImageInputError);
    assert.equal(fetchCalls, 1);
    assert.deepEqual(store.listTurns("missing-image").map(turn => turn.status), ["completed", "failed"]);
  });

  it("stops before network I/O when cancelled during image materialization", async () => {
    const controller = new AbortController();
    const ref: NativeImageReference = { type: "image_ref", sha256: "a".repeat(64), mediaType: "image/png", width: 1, height: 1 };
    await assert.rejects(completeNativeChat({
      ...model(), messages: [{ role: "user", content: [ref] }], tools: [], signal: controller.signal,
      readImage: async () => { controller.abort(); return png; },
      fetchImpl: async () => { assert.fail("Cancelled image requests must not be sent"); },
    }), { name: "AbortError" });
  });

  it("counts image tokens without counting base64 and drops only complete old turns", async () => {
    const images = new NativeImageStore(workspace, false);
    const content = await images.prepare(imageInput(), workspace, new AbortController().signal);
    const user: NativeChatMessage = { role: "user", content };
    assert.ok(estimateNativeMessageTokens(user) >= 4_096);
    const projection = projectNativeContext([user, { role: "assistant", content: "Done" }, { role: "user", content: "Next" }], {
      contextWindow: 512, reservedTokens: 64,
    });
    assert.deepEqual(projection.messages, [{ role: "user", content: "Next" }]);
    assert.equal(projection.diagnostic.droppedMessages, 2);
    const whole = projectNativeContext([user]);
    assert.deepEqual(whole.messages, [user]);
    assert.notEqual(whole.messages[0]?.content, content);
    assert.notEqual(firstImage(whole.messages[0]!.content), firstImage(content));
    assert.throws(() => projectNativeContext([user], { contextWindow: 512 }), /context/i);
  });

  it("rejects cancelled input before any network or persistent write", async () => {
    const controller = new AbortController();
    controller.abort();
    const images = new NativeImageStore(workspace, true);
    await assert.rejects(images.prepare(imageInput(), workspace, controller.signal), { name: "AbortError" });
    assert.equal(fs.existsSync(resolveWorkspaceStatePath(workspace, "attachments")), false);
  });
});
