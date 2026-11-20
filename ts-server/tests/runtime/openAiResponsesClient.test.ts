import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { NativeImageInputError, NativeImageStore } from "../../server/runtime/nativeImages.js";
import type { NativeResponsesOutputItem } from "../../server/runtime/nativeResponsesTypes.js";
import { NativeProviderError, type NativeCompletionRequest } from "../../server/runtime/openAiCompatibleClient.js";
import { completeNativeResponses, getNativeResponsesScope } from "../../server/runtime/openAiResponsesClient.js";

const request: NativeCompletionRequest = {
  baseUrl: "https://provider.test/v1", apiKey: "test-secret-key", model: "unknown-provider/model-id",
  messages: [{ role: "user", content: "Hello" }], tools: [],
};

function message(text = "Hello", extra = {}): NativeResponsesOutputItem {
  return { type: "message", id: "msg_1", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }], ...extra };
}

function call(extra = {}): NativeResponsesOutputItem {
  return { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"file":"note.txt"}',
    status: "completed", ...extra };
}

const reasoning: NativeResponsesOutputItem = {
  type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Private reasoning summary" }],
  encrypted_content: "opaque-encrypted-reasoning",
};

function terminal(output: unknown[] = [message()], extra = {}) {
  return { id: "resp_1", status: "completed", output, usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 }, ...extra };
}

function completed(output: unknown[] = [message()], extra = {}) {
  return { type: "response.completed", response: terminal(output, extra) };
}

function encode(events: unknown[], ending = ""): string {
  return events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + ending;
}

function sse(events: unknown[], ending = ""): Response {
  return new Response(encode(events, ending), { headers: { "content-type": "text/event-stream" } });
}

function added(item: unknown, output_index = 0) {
  return { type: "response.output_item.added", output_index, item };
}

function textDelta(delta: string, extra = {}) {
  return { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta, ...extra };
}

function argsDelta(delta: string, extra = {}) {
  return { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta, ...extra };
}

function malformed(error: unknown): boolean {
  return error instanceof NativeProviderError && error.kind === "malformed";
}

async function capture(overrides: Partial<NativeCompletionRequest> = {}) {
  let url: unknown;
  let init: RequestInit | undefined;
  const result = await completeNativeResponses({
    ...request, streaming: false, ...overrides,
    fetchImpl: async (nextUrl, nextInit) => {
      url = nextUrl;
      init = nextInit;
      return Response.json(terminal());
    },
  });
  return { url, init: init!, body: JSON.parse(String(init?.body)), result };
}

describe("Native Responses wire request", () => {
  for (const baseUrl of ["provider.test", "https://provider.test/v1/", "https://provider.test/v1/responses",
    " https://provider.test/v1/chat/completions/?ignored=yes#fragment "]) {
    it(`normalizes only the configured endpoint: ${baseUrl}`, async () => {
      const { url, init, body } = await capture({ baseUrl, wireApi: "responses" });
      assert.equal(url, "https://provider.test/v1/responses");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.deepEqual(init.headers, {
        Accept: "application/json", Authorization: "Bearer test-secret-key", "Content-Type": "application/json",
      });
      assert.equal(body.model, request.model);
      assert.equal(body.store, false);
      assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
      assert.equal(body.stream, false);
      assert.equal(body.tool_choice, "none");
      assert.equal(body.tools, undefined);
      assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }]);
      assert.doesNotMatch(JSON.stringify(body), /wireApi|apiKey|baseUrl|test-secret-key|scope|previous_response_id/);
    });
  }

  for (const baseUrl of ["ftp://provider.test", "https://user:password@provider.test", "", "://invalid"]) {
    it(`rejects invalid/credentialed URLs before sending: ${baseUrl}`, async () => {
      let fetched = false;
      await assert.rejects(completeNativeResponses({ ...request, baseUrl,
        fetchImpl: async () => { fetched = true; return Response.json(terminal()); } }));
      assert.equal(fetched, false);
    });
  }

  it("sends flat optional-parameter tools and only Responses options", async () => {
    const parameters = { type: "object", properties: { file: { type: "string" }, limit: { type: "number" } }, required: ["file"] };
    const { body } = await capture({ tools: [{ type: "function", function: { name: "read_file", description: "Read a file", parameters } }],
      options: { maxTokens: 131072, temperature: 0, topP: 0.8, reasoningEffort: "high", parallelToolCalls: false, includeUsage: true } });
    assert.deepEqual(body.tools, [{ type: "function", name: "read_file", description: "Read a file", parameters, strict: false }]);
    assert.equal(body.tool_choice, "auto");
    assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.max_output_tokens, 131072);
    assert.equal(body.temperature, 0);
    assert.equal(body.top_p, 0.8);
    assert.deepEqual(body.reasoning, { effort: "high" });
    assert.doesNotMatch(JSON.stringify(body), /stream_options|max_tokens|reasoning_effort|includeUsage|response_format/);
    const noTools = await capture({ options: { parallelToolCalls: true } });
    assert.equal(noTools.body.parallel_tool_calls, undefined);
    assert.equal(noTools.body.max_output_tokens, undefined);
  });

  for (const [outputSchema, format] of [
    [{ type: "object", properties: {} }, { type: "json_schema", name: "ads_output", strict: true, schema: { type: "object", properties: {} } }],
    [{ type: "json_object" }, { type: "json_object" }],
    [{ type: "json_schema", json_schema: { name: "answer", description: "Result", strict: false, schema: { type: "object" } } },
      { type: "json_schema", name: "answer", description: "Result", strict: false, schema: { type: "object" } }],
  ]) {
    it(`maps Chat schema format ${JSON.stringify(outputSchema)} to text.format`, async () => {
      const { body } = await capture({ outputSchema });
      assert.deepEqual(body.text, { format });
      assert.equal(body.response_format, undefined);
    });
  }

  it("converts canonical history without ADS-only fields", async () => {
    const { body } = await capture({ messages: [
      { role: "system", content: "Be helpful" },
      { role: "assistant", name: "ads", content: [{ type: "text", text: "Reading" }], tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
      ] },
      { role: "tool", name: "read_file", tool_call_id: "call_1", content: "Uncertain tool result", nativeToolOutcome: "unknown" },
    ] });
    assert.deepEqual(body.input, [
      { role: "system", content: [{ type: "input_text", text: "Be helpful" }] },
      { role: "assistant", content: "Reading" },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "Uncertain tool result" },
    ]);
    assert.doesNotMatch(JSON.stringify(body), /nativeToolOutcome|tool_call_id|tool_calls|nativeResponses/);
  });

  it("does not forward authorization across HTTP redirects or try another endpoint", async () => {
    let redirectedRequests = 0;
    const target = http.createServer((_req, res) => { redirectedRequests++; res.end("unexpected"); });
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const targetAddress = target.address();
    assert.ok(targetAddress && typeof targetAddress !== "string");
    let originalRequests = 0;
    const source = http.createServer((req, res) => {
      originalRequests++;
      assert.equal(req.url, "/v1/responses");
      assert.equal(req.headers.authorization, "Bearer test-secret-key");
      res.writeHead(307, { Location: `http://127.0.0.1:${targetAddress.port}/stolen` });
      res.end();
    });
    source.listen(0, "127.0.0.1");
    await once(source, "listening");
    try {
      const address = source.address();
      assert.ok(address && typeof address !== "string");
      await assert.rejects(completeNativeResponses({ ...request, baseUrl: `http://127.0.0.1:${address.port}`, streaming: false }),
        error => error instanceof NativeProviderError && error.kind === "transient");
      assert.equal(originalRequests, 1);
      assert.equal(redirectedRequests, 0);
    } finally {
      source.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([source, target].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    }
  });
});

describe("Native Responses replay and output", () => {
  it("hashes normalized URL, exact model and credential without exposing the key", () => {
    const scope = getNativeResponsesScope(request);
    assert.match(scope, /^[a-f0-9]{64}$/);
    assert.equal(scope, getNativeResponsesScope({ ...request, baseUrl: "https://provider.test/v1/chat/completions/?q=x" }));
    for (const change of [{ baseUrl: "https://other.test/v1" }, { model: "other" }, { apiKey: "new-key" }]) {
      assert.notEqual(scope, getNativeResponsesScope({ ...request, ...change }));
    }
    assert.notEqual(getNativeResponsesScope({ ...request, model: "a:b", apiKey: "c" }),
      getNativeResponsesScope({ ...request, model: "a", apiKey: "b:c" }));
  });

  for (const streaming of [false, true]) {
    it(`returns call_id (not item.id), usage and ordered replay (streaming=${streaming})`, async () => {
      const output = [reasoning, message("Checking", { phase: "commentary" }), call(),
        message("", { id: "msg_2", phase: "final_answer", content: [{ type: "refusal", refusal: "Cannot continue" }] })];
      const snapshots: string[] = [];
      const result = await completeNativeResponses({ ...request, streaming, onTextDelta: text => snapshots.push(text),
        fetchImpl: async () => streaming ? sse([completed(output)]) : Response.json(terminal(output)) });
      assert.deepEqual(result.toolCalls, [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"file":"note.txt"}' } }]);
      assert.equal(result.text, "CheckingCannot continue");
      assert.equal(result.finishReason, "tool_calls");
      assert.deepEqual(result.usage, { input_tokens: 11, output_tokens: 7, total_tokens: 18 });
      assert.deepEqual(result.nativeResponses, { scope: getNativeResponsesScope(request), output });
      assert.deepEqual(snapshots, streaming ? [result.text] : []);
      const { body } = await capture({ messages: [{ role: "assistant", content: result.text, tool_calls: result.toolCalls, nativeResponses: result.nativeResponses },
        { role: "tool", tool_call_id: "call_1", content: "contents" }] });
      assert.deepEqual(body.input, [...output, { type: "function_call_output", call_id: "call_1", output: "contents" }]);
      assert.doesNotMatch(JSON.stringify(body), /scope|nativeResponses|test-secret-key/);
      assert.doesNotMatch(JSON.stringify(snapshots), /Private|opaque-encrypted/);
    });
  }

  for (const change of [{ model: "other" }, { apiKey: "new-key" }, { baseUrl: "https://other.test/v1" }]) {
    it(`falls back to canonical history across scope ${Object.keys(change)[0]}`, async () => {
      const { body } = await capture({ ...change, messages: [{ role: "assistant", content: "Canonical text", tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
      ], nativeResponses: { scope: getNativeResponsesScope(request), output: [reasoning, message(), call()] } }] });
      assert.deepEqual(body.input, [
        { role: "assistant", content: "Canonical text" },
        { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
      ]);
      assert.doesNotMatch(JSON.stringify(body), /opaque-encrypted|rs_1|msg_1|fc_1|scope/);
    });
  }

  it("strips non-wire fields from output and replay while preserving annotations", async () => {
    const result = await completeNativeResponses({ ...request, streaming: false, fetchImpl: async () => Response.json(terminal([
      { ...reasoning, content: [{ type: "reasoning_text", text: "SECRET" }], adsOnly: "private" },
      message("Text", { adsOnly: "private", content: [{ type: "output_text", text: "Text", annotations: [{ type: "url_citation", url: "https://example.test" }], adsOnly: "private" }] }),
    ])) });
    assert.doesNotMatch(JSON.stringify(result), /SECRET|adsOnly|private/);
    const { body } = await capture({ messages: [{ role: "assistant", content: result.text, nativeResponses: result.nativeResponses }] });
    assert.deepEqual(body.input, result.nativeResponses?.output);
  });

  for (const [label, content, calls] of [
    ["redacted text", "REDACTED", [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"file":"note.txt"}' } }]],
    ["forged call id", "Hello", [{ id: "canonical-id", type: "function", function: { name: "read_file", arguments: '{"file":"note.txt"}' } }]],
    ["redacted arguments", "Hello", [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"file":"REDACTED"}' } }]],
    ["changed tool name", "Hello", [{ id: "call_1", type: "function", function: { name: "list_files", arguments: '{"file":"note.txt"}' } }]],
    ["missing canonical call", "Hello", []],
  ] as const) {
    it(`uses canonical history instead of divergent replay: ${label}`, async () => {
      const tool_calls = calls.map(call => ({ ...call }));
      const { body } = await capture({ messages: [{ role: "assistant", content, tool_calls,
        nativeResponses: { scope: getNativeResponsesScope(request), output: [reasoning, message(), call()] } }] });
      assert.deepEqual(body.input, [
        { role: "assistant", content },
        ...calls.map(call => ({ type: "function_call", call_id: call.id, ...call.function })),
      ]);
      assert.doesNotMatch(JSON.stringify(body), /opaque-encrypted|rs_1|fc_1/);
    });
  }

  for (const streaming of [false, true]) {
    for (const [label, output] of [
      ["unsupported tool", [{ type: "web_search_call", id: "ws_1" }]],
      ["invalid content", [message("", { content: [{ type: "audio", data: "secret" }] })]],
      ["duplicate call ids", [call(), call({ id: "fc_2" })]],
      ["duplicate item ids", [message(), message()]],
      ["empty call id", [call({ call_id: "" })]],
      ["whitespace call id", [call({ call_id: " call_1 " })]],
      ["missing call id", [call({ call_id: undefined })]],
      ["empty function name", [call({ name: "" })]],
      ["malformed JSON args", [call({ arguments: '{"file":' })]],
      ["non-object args", [call({ arguments: "null" })]],
      ["non-string args", [call({ arguments: {} })]],
      ["unfinished call", [call({ status: "incomplete" })]],
      ["unfinished message", [message("", { status: "in_progress" })]],
      ["invalid phase", [message("", { phase: "analysis" })]],
    ] as Array<[string, unknown[]]>) {
      it(`rejects ${label} before execution (streaming=${streaming})`, async () => {
        await assert.rejects(completeNativeResponses({ ...request, streaming,
          fetchImpl: async () => streaming ? sse([completed(output)]) : Response.json(terminal(output)) }), malformed);
      });
    }
    for (const [reason, finishReason] of [["max_output_tokens", "length"], ["content_filter", "content_filter"]]) {
      it(`rejects ALL tools on ${reason} including complete calls (streaming=${streaming})`, async () => {
        const output = [message("Partial", { status: "incomplete" }), call({ status: "incomplete", arguments: '{"file":' }),
          call({ id: "fc_2", call_id: "call_2" })];
        const response = terminal(output, { status: "incomplete", incomplete_details: { reason } });
        await assert.rejects(completeNativeResponses({ ...request, streaming,
          fetchImpl: async () => streaming ? sse([{ type: "response.incomplete", response }]) : Response.json(response) }), malformed);
      });
      it(`maps text-only ${reason} to ${finishReason} (streaming=${streaming})`, async () => {
        const output = [message("Partial", { status: "incomplete" }), reasoning];
        const response = terminal(output, { status: "incomplete", incomplete_details: { reason } });
        const result = await completeNativeResponses({ ...request, streaming,
          fetchImpl: async () => streaming ? sse([{ type: "response.incomplete", response }]) : Response.json(response) });
        assert.equal(result.finishReason, finishReason);
        assert.deepEqual(result.toolCalls, []);
        assert.equal(result.text, "Partial");
        assert.deepEqual(result.nativeResponses?.output, output);
      });
    }
  }
});

describe("Native Responses image input", () => {
  it("reads real stored image bytes and preserves multimodal ordering across messages", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ads-responses-images-"));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNAAAAABJRU5ErkJggg==", "base64");
    try {
      await writeFile(path.join(directory, "pixel.png"), png);
      const signal = new AbortController().signal;
      const store = new NativeImageStore(directory, false);
      const content = await store.prepare([
        { type: "text", text: "Before" }, { type: "local_image", path: "pixel.png" }, { type: "text", text: "After" },
      ], directory, signal);
      await rm(path.join(directory, "pixel.png"));
      const { body } = await capture({ signal, messages: [
        { role: "system", content: "Vision" }, { role: "user", content },
        { role: "user", content: [{ type: "image_url", image_url: { url: "https://images.test/picture.png" } }, { type: "text", text: "Compare" }] },
      ], readImage: image => store.read(image, signal) });
      assert.deepEqual(body.input, [
        { role: "system", content: [{ type: "input_text", text: "Vision" }] },
        { role: "user", content: [{ type: "input_text", text: "Before" },
          { type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` }, { type: "input_text", text: "After" }] },
        { role: "user", content: [{ type: "input_image", image_url: "https://images.test/picture.png" }, { type: "input_text", text: "Compare" }] },
      ]);
      assert.doesNotMatch(JSON.stringify(body), /image_ref|sha256|mediaType|width|height|pixel.png/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  const image = { type: "image_ref" as const, sha256: "a".repeat(64), mediaType: "image/png", width: 1, height: 1 };
  it("enforces the aggregate 50 MiB image budget across messages before fetch", async () => {
    let fetched = false;
    let reads = 0;
    const bytes = Buffer.alloc(25 * 1024 * 1024 + 1);
    await assert.rejects(completeNativeResponses({ ...request,
      messages: [{ role: "user", content: [image] }, { role: "user", content: [image] }],
      readImage: async () => { reads++; return bytes; },
      fetchImpl: async () => { fetched = true; return Response.json(terminal()); },
    }), error => error instanceof NativeImageInputError);
    assert.equal(reads, 2);
    assert.equal(fetched, false);
  });

  for (const readImage of [undefined, async () => { throw new NativeImageInputError("stored image unavailable"); }]) {
    it(`keeps missing/unavailable image failures local (reader=${Boolean(readImage)})`, async () => {
      let fetched = false;
      await assert.rejects(completeNativeResponses({ ...request, messages: [{ role: "user", content: [image] }], readImage,
        fetchImpl: async () => { fetched = true; return Response.json(terminal()); } }), error => error instanceof NativeImageInputError);
      assert.equal(fetched, false);
    });
  }
});

describe("Native Responses typed SSE", () => {
  it("assembles tools and cumulative text, retaining terminal usage without duplicate text", async () => {
    const snapshots: string[] = [];
    const events = [
      { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [], usage: { input_tokens: 999 } } },
      added({ ...reasoning, summary: [], encrypted_content: undefined }, 0),
      { type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_1", delta: "SECRET" },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      added(message("", { content: [], status: "in_progress", phase: "commentary" }), 1),
      { type: "response.content_part.added", output_index: 1, item_id: "msg_1", content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      textDelta("Hel", { output_index: 1 }), textDelta("lo", { output_index: 1 }),
      { type: "response.output_text.done", output_index: 1, item_id: "msg_1", content_index: 0, text: "Hello" },
      { type: "response.content_part.done", output_index: 1, item_id: "msg_1", content_index: 0, part: { type: "output_text", text: "Hello", annotations: [] } },
      { type: "response.output_item.done", output_index: 1, item: message("Hello", { phase: "commentary" }) },
      added(call({ arguments: "", status: "in_progress" }), 2),
      argsDelta('{"file":', { output_index: 2 }), argsDelta('"note.txt"}', { output_index: 2 }),
      { type: "response.function_call_arguments.done", output_index: 2, item_id: "fc_1", arguments: '{"file":"note.txt"}', name: "read_file" },
      { type: "response.output_item.done", output_index: 2, item: call() },
      completed([reasoning, message("Hello", { phase: "commentary" }), call()]),
    ];
    const result = await completeNativeResponses({ ...request, fetchImpl: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("accept"), "text/event-stream");
      assert.equal(JSON.parse(String(init?.body)).stream, true);
      return sse(events, "data: [DONE]\n\n");
    }, onTextDelta: text => snapshots.push(text) });
    assert.equal(result.text, "Hello");
    assert.equal(result.toolCalls[0].id, "call_1");
    assert.deepEqual(result.usage, { input_tokens: 11, output_tokens: 7, total_tokens: 18 });
    assert.deepEqual(snapshots, ["Hel", "Hello"]);
  });

  it("handles interleaved parallel tool deltas by output index and call_id", async () => {
    const second = call({ id: "fc_2", call_id: "call_2", name: "list_files", arguments: "{}" });
    const result = await completeNativeResponses({ ...request, fetchImpl: async () => sse([
      added(call({ arguments: "" })), added({ ...second, arguments: "" }, 1),
      argsDelta('{"file":'), argsDelta("{}", { output_index: 1, item_id: "fc_2" }), argsDelta('"note.txt"}'),
      completed([call(), second]),
    ]) });
    assert.deepEqual(result.toolCalls.map(call => call.id), ["call_1", "call_2"]);
  });

  it("supports terminal-only and done-only output with no duplicated streamed text", async () => {
    const snapshots: string[] = [];
    const result = await completeNativeResponses({ ...request, onTextDelta: text => snapshots.push(text), fetchImpl: async () => sse([
      { type: "response.output_item.done", output_index: 0, item: message("Hello") },
      completed([message(), message(" world", { id: "msg_2" }), call()]),
    ]) });
    assert.equal(result.text, "Hello world");
    assert.equal(result.toolCalls.length, 1);
    assert.deepEqual(snapshots, ["Hello", "Hello world"]);
  });

  it("streams refusal text but not reasoning text", async () => {
    const snapshots: string[] = [];
    const result = await completeNativeResponses({ ...request, onTextDelta: text => snapshots.push(text), fetchImpl: async () => sse([
      { type: "response.reasoning_text.delta", item_id: "rs_1", output_index: 1, delta: "SECRET" },
      { type: "response.refusal.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "No" },
      { type: "response.refusal.done", item_id: "msg_1", output_index: 0, content_index: 0, refusal: "No" },
      completed([message("", { content: [{ type: "refusal", refusal: "No" }] }), reasoning]),
    ]) });
    assert.equal(result.text, "No");
    assert.deepEqual(snapshots, ["No"]);
  });

  it("parses byte-split UTF-8, CRLF, comments and multiline data with an EOF terminal frame", async () => {
    const final = JSON.stringify(completed([message("Caf\u00e9")]));
    const wire = `: heartbeat\r\n\r\nevent: response.output_text.delta\r\nid: 1\r\n` +
      `data: ${JSON.stringify(textDelta("Caf\u00e9"))}\r\n\r\ndata: ${final.slice(0, 1)}\r\ndata: ${final.slice(1)}`;
    const bytes = new TextEncoder().encode(wire);
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.slice(offset, ++offset));
    } });
    const result = await completeNativeResponses({ ...request, fetchImpl: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }) });
    assert.equal(result.text, "Caf\u00e9");
    assert.equal(body.locked, false);
  });

  const invalidStreams: Array<[string, unknown[]]> = [
    ["unknown event", [{ type: "response.web_search_call.in_progress" }]],
    ["untyped event", [{}]],
    ["non-object event", [null]],
    ["unknown function item", [argsDelta("{}"), completed([call({ arguments: "{}" })])]],
    ["negative index", [textDelta("Hello", { output_index: -1 }), completed()]],
    ["changed item id", [textDelta("Hello"), completed([message("Hello", { id: "other" })])]],
    ["changed call id", [added(call({ arguments: "" })), completed([call({ call_id: "other" })])]],
    ["changed call name", [added(call({ arguments: "" })), completed([call({ name: "execute" })])]],
    ["changed args", [added(call({ arguments: "" })), argsDelta("{}"), completed([call()])]],
    ["stale partial args", [added(call({ arguments: "" })), argsDelta('{"file":'), completed([call()])]],
    ["done args mismatch", [added(call({ arguments: "" })), argsDelta("{}"), { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_1", arguments: '{"other":true}' }]],
    ["args after done", [added(call({ arguments: "" })), { type: "response.function_call_arguments.done", output_index: 0, item_id: "fc_1", arguments: "{}" }, argsDelta("{}")]],
    ["text mismatch", [textDelta("Hello"), completed([message("Goodbye")])]],
    ["missing streamed output", [textDelta("Hello"), completed([])]],
    ["missing content part", [textDelta("Hello", { content_index: 1 }), completed()]],
    ["text after done", [{ type: "response.output_text.done", output_index: 0, item_id: "msg_1", content_index: 0, text: "Hello" }, textDelta("!")]],
    ["duplicate item added", [added(call()), added(call())]],
    ["changed response id", [{ type: "response.created", response: { id: "other" } }, completed()]],
    ["conflicting status", [completed([message()], { status: "in_progress" })]],
    ["unsupported incomplete reason", [{ type: "response.incomplete", response: terminal([], { status: "incomplete", incomplete_details: { reason: "unknown" } }) }]],
    ["unfinished response EOF", [textDelta("Hello")]],
  ];
  for (const [label, events] of invalidStreams) {
    it(`rejects ${label}`, async () => {
      await assert.rejects(completeNativeResponses({ ...request, fetchImpl: async () => sse(events) }), malformed);
    });
  }

  for (const body of ["", "data: [DONE]\n\n", "data: {broken}\n\n", encode([textDelta("Hello")], "data: [DONE]\n\n")]) {
    it(`never accepts an unterminated/malformed stream: ${JSON.stringify(body)}`, async () => {
      await assert.rejects(completeNativeResponses({ ...request,
        fetchImpl: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }) }), malformed);
    });
  }

  for (const events of [[completed()], [{ type: "response.output_item.added", output_index: 0, item: { type: "computer_call" } }]]) {
    it(`cancels and releases a still-open stream after ${events[0].type}`, async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(encode(events))); },
        cancel() { cancelled = true; } });
      const promise = completeNativeResponses({ ...request, fetchImpl: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }) });
      if (events[0].type === "response.completed") await promise;
      else await assert.rejects(promise, malformed);
      assert.equal(cancelled, true);
      assert.equal(body.locked, false);
    });
  }

  it("cancels pending stream reads on abort, even for custom fetch implementations", { timeout: 2000 }, async () => {
    const abort = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const promise = completeNativeResponses({ ...request, signal: abort.signal, fetchImpl: async () => {
      setTimeout(() => abort.abort(), 10);
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    } });
    await assert.rejects(promise, error => error instanceof Error && error.name === "AbortError");
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  });

  it("does not return tools when a terminal UI callback cancels the turn", async () => {
    const controller = new AbortController();
    await assert.rejects(completeNativeResponses({ ...request, signal: controller.signal,
      onTextDelta: () => controller.abort(), fetchImpl: async () => sse([completed([message(), call()])]),
    }), error => error instanceof Error && error.name === "AbortError");
  });
});

describe("Native Responses errors and usage", () => {
  for (const [status, kind] of [[400, "permanent"], [401, "permanent"], [403, "permanent"], [404, "permanent"],
    [408, "transient"], [425, "transient"], [429, "transient"], [500, "transient"], [502, "transient"], [503, "transient"], [504, "transient"], [524, "transient"]] as const) {
    it(`classifies HTTP ${status} as ${kind} without provider body exposure`, async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
      await assert.rejects(completeNativeResponses({ ...request, fetchImpl: async () => new Response(body, { status }) }), error => {
        assert.ok(error instanceof NativeProviderError);
        assert.equal(error.kind, kind);
        assert.equal(error.status, status);
        assert.match(error.message, /redacted/);
        return true;
      });
      assert.equal(cancelled, true);
      assert.equal(body.locked, false);
    });
  }

  for (const [code, kind] of [["server_error", "transient"], ["rate_limit_exceeded", "transient"], ["timeout", "transient"],
    ["invalid_api_key", "permanent"], ["insufficient_quota", "permanent"], ["unknown", "permanent"]] as const) {
    for (const mode of ["nonstream", "failed", "error"] as const) {
      it(`handles ${mode} ${code} without exposing payloads`, async () => {
        const error = { code, message: "SECRET provider body and credential", param: "SECRET" };
        await assert.rejects(completeNativeResponses({ ...request, streaming: mode !== "nonstream", fetchImpl: async () =>
          mode === "nonstream" ? Response.json(terminal([], { status: "failed", error }))
            : sse(mode === "failed" ? [{ type: "response.failed", response: terminal([], { status: "failed", error }) }]
              : [{ type: "error", ...error }]) }), error => {
          assert.ok(error instanceof NativeProviderError);
          assert.equal(error.kind, kind);
          assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)} ${error.cause}`, /SECRET|test-secret-key/);
          return true;
        });
      });
    }
  }

  for (const streaming of [true, false]) {
    it(`classifies disconnected response bodies as transient (streaming=${streaming})`, async () => {
      const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new TypeError("socket lost")); } });
      await assert.rejects(completeNativeResponses({ ...request, streaming, fetchImpl: async () => new Response(body,
        { headers: { "content-type": streaming ? "text/event-stream" : "application/json" } }) }),
      error => error instanceof NativeProviderError && error.kind === "transient");
      assert.equal(body.locked, false);
    });
    it(`rejects the wrong response mode (streaming=${streaming})`, async () => {
      await assert.rejects(completeNativeResponses({ ...request, streaming,
        fetchImpl: async () => streaming ? Response.json(terminal()) : sse([completed()]) }), malformed);
    });
  }

  it("releases successful JSON response readers", async () => {
    const response = Response.json(terminal());
    await completeNativeResponses({ ...request, streaming: false, fetchImpl: async () => response });
    assert.equal(response.body?.locked, false);
  });

  it("aborts and releases pending non-streaming bodies", { timeout: 2000 }, async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const promise = completeNativeResponses({ ...request, streaming: false, signal: controller.signal, fetchImpl: async () => {
      setTimeout(() => controller.abort(), 10);
      return new Response(body, { headers: { "content-type": "application/json" } });
    } });
    await assert.rejects(promise, error => error instanceof Error && error.name === "AbortError");
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  });

  it("classifies fetch network failure as transient and preserves aborts", async () => {
    await assert.rejects(completeNativeResponses({ ...request, fetchImpl: async () => { throw new TypeError("network error"); } }),
      error => error instanceof NativeProviderError && error.kind === "transient");
    const error = new DOMException("Aborted", "AbortError");
    await assert.rejects(completeNativeResponses({ ...request, fetchImpl: async () => { throw error; } }), value => value === error);
    const controller = new AbortController();
    controller.abort(error);
    let fetched = false;
    await assert.rejects(completeNativeResponses({ ...request, signal: controller.signal, fetchImpl: async () => {
      fetched = true; return Response.json(terminal());
    } }), value => value === error);
    assert.equal(fetched, false);
  });

  for (const payload of ["{broken", "null", "[]", '{"status":"in_progress","output":[]}', '{"status":"completed"}']) {
    it(`rejects malformed/nonterminal nonstream data: ${payload}`, async () => {
      await assert.rejects(completeNativeResponses({ ...request, streaming: false,
        fetchImpl: async () => new Response(payload, { headers: { "content-type": "application/json" } }) }), malformed);
    });
  }

  it("ignores early usage and uses only the completed response usage", async () => {
    const result = await completeNativeResponses({ ...request, fetchImpl: async () => sse([
      { type: "response.in_progress", response: { id: "resp_1", usage: { input_tokens: 999 } } },
      completed([message()], { usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, output_tokens_details: { reasoning_tokens: 123 } } }),
    ]) });
    assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 });
    const noUsage = await completeNativeResponses({ ...request, fetchImpl: async () => sse([
      { type: "response.in_progress", response: { usage: { input_tokens: 999 } } }, completed([], { usage: null }),
    ]) });
    assert.equal(noUsage.usage, null);
    assert.equal(noUsage.finishReason, "stop");
  });
});
