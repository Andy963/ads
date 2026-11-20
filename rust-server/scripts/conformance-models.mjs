#!/usr/bin/env node
/**
 * Black-box model catalog conformance: compare the TypeScript and Rust
 * model-config, model-service, and conversation-model APIs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assert,
  assertJson,
  compare,
  loginAs,
  startServerPair,
} from "./lib/black-box.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");
const rustDir = path.join(root, "rust-server");

function jsonRequest(method, body) {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function normalizeId(result, id) {
  return JSON.parse(JSON.stringify(result.body).replaceAll(id, "<created-id>"));
}

async function main() {
  const pair = await startServerPair({ root, rustDir });

  try {
    const nodeLogin = await loginAs(pair.nodeBase, "admin", "secret");
    const rustLogin = await loginAs(pair.rustBase, "admin", "secret");
    const node = (pathname, options = {}) =>
      pair.nodeRequest(pathname, {
        ...options,
        headers: { cookie: nodeLogin.cookie, ...(options.headers ?? {}) },
      });
    const rust = (pathname, options = {}) =>
      pair.rustRequest(pathname, {
        ...options,
        headers: { cookie: rustLogin.cookie, ...(options.headers ?? {}) },
      });

    async function compareBoth(label, pathname, options) {
      await compare(label, await node(pathname, options), await rust(pathname, options), {
        maskKeys: ["updatedAt"],
      });
    }

    await compareBoth("model-configs-seeded", "/api/model-configs");
    await compareBoth("model-services-seeded", "/api/model-services");
    await compareBoth("conversation-models-seeded", "/api/models");

    const invalidPayloads = [
      ["create-missing-model-id", { provider: "openai" }],
      ["create-auto-model-id", { modelId: "auto", provider: "openai" }],
      [
        "create-unknown-provider",
        { modelId: "gpt-x", provider: "openai", providerId: "missing" },
      ],
      [
        "create-credential-leak",
        {
          modelId: "gpt-x",
          provider: "openai",
          configJson: { nested: { password: "secret" } },
        },
      ],
    ];
    for (const [label, body] of invalidPayloads) {
      await compareBoth(label, "/api/model-configs", jsonRequest("POST", body));
    }

    await compareBoth(
      "update-missing-model",
      "/api/model-configs/model-missing",
      jsonRequest("PATCH", { displayName: "Nope" }),
    );
    await compareBoth(
      "delete-seeded-model-guard",
      "/api/model-configs/model-seed-codex-gpt-5-5",
      { method: "DELETE" },
    );
    await compareBoth(
      "service-default-not-member",
      "/api/model-services/conversation",
      jsonRequest("PUT", {
        modelIds: ["model-seed-codex-gpt-5-5"],
        defaultModelId: "model-seed-codex-gpt-5-6",
      }),
    );
    await compareBoth(
      "service-requires-provider",
      "/api/model-services/transcription",
      jsonRequest("PUT", {
        modelIds: ["model-seed-codex-gpt-5-5"],
        defaultModelId: "model-seed-codex-gpt-5-5",
      }),
    );
    await compareBoth(
      "service-invalid-service",
      "/api/model-services/unknown",
      jsonRequest("PUT", { modelIds: [], defaultModelId: null }),
    );

    await compareBoth(
      "service-conversation-save",
      "/api/model-services/conversation",
      jsonRequest("PUT", {
        modelIds: ["model-seed-codex-gpt-5-5"],
        defaultModelId: "model-seed-codex-gpt-5-5",
      }),
    );
    await compareBoth("conversation-models-after-save", "/api/models");

    const createBody = {
      modelId: "gpt-conformance",
      displayName: "Conformance Model",
      provider: "openai",
      isDefault: true,
      configJson: {
        max_input_tokens: "4096",
        max_output_tokens: 8192,
        reasoningEfforts: ["HIGH", "bogus", "low"],
        defaultReasoningEffort: "low",
      },
    };
    const nodeCreated = await node("/api/model-configs", jsonRequest("POST", createBody));
    const rustCreated = await rust("/api/model-configs", jsonRequest("POST", createBody));
    await compare("model-config-create", nodeCreated, rustCreated, {
      maskKeys: ["updatedAt"],
      masks: ["id"],
    });
    const nodeId = nodeCreated.body.id;
    const rustId = rustCreated.body.id;
    assert(nodeId.startsWith("model-"), "unexpected node model id");
    assert(rustId.startsWith("model-"), "unexpected rust model id");

    const nodePatched = await node(
      `/api/model-configs/${nodeId}`,
      jsonRequest("PATCH", { displayName: "Renamed", isEnabled: false }),
    );
    const rustPatched = await rust(
      `/api/model-configs/${rustId}`,
      jsonRequest("PATCH", { displayName: "Renamed", isEnabled: false }),
    );
    await compare(
      "model-config-update",
      { status: nodePatched.status, body: normalizeId(nodePatched, nodeId) },
      { status: rustPatched.status, body: normalizeId(rustPatched, rustId) },
      { maskKeys: ["updatedAt"] },
    );

    const nodeList = await node("/api/model-configs");
    const rustList = await rust("/api/model-configs");
    const seededIds = (result) =>
      result.body
        .filter((model) => model.id.startsWith("model-seed-"))
        .map((model) => model.id);
    assertJson(seededIds(rustList), seededIds(nodeList), "seeded models after create");

    const nodeDelete = await node(`/api/model-configs/${nodeId}`, { method: "DELETE" });
    const rustDelete = await rust(`/api/model-configs/${rustId}`, { method: "DELETE" });
    await compare("model-config-delete", nodeDelete, rustDelete);

    console.log("[conformance] model contract matched");
  } finally {
    await pair.stop();
  }
}

await main();
