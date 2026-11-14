#!/usr/bin/env node
/**
 * Black-box provider and upstream-discovery conformance.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assert,
  compare,
  getFreePort,
  loginAs,
  startServerPair,
} from "./lib/black-box.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");
const rustDir = path.join(root, "rust");

function jsonRequest(method, body) {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function normalizeIds(result, replacements) {
  let text = JSON.stringify(result.body);
  for (const [id, replacement] of replacements) text = text.replaceAll(id, replacement);
  return JSON.parse(text);
}

async function startFakeUpstream(apiKey = "upstream-secret") {
  const server = http.createServer((req, res) => {
    if (req.url !== "/v1/models" || req.headers.authorization !== `Bearer ${apiKey}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: [
        { id: "model-b" },
        { id: "model-a" },
        { id: "model-b" },
        { id: "  " },
        { nope: true },
      ],
    }));
  });
  const port = await getFreePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  const upstream = await startFakeUpstream();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "ads-codex-home-"));
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    `model_provider = "conformance"\n\n[model_providers.conformance]\nbase_url = "${upstream.baseUrl}"\napi_key = "upstream-secret"\n`,
  );
  const pair = await startServerPair({
    root,
    rustDir,
    env: {
      ADS_WEB_SESSION_PEPPER: "provider-conformance-pepper",
      CODEX_HOME: codexHome,
    },
  });

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
    const compareProviders = async (label, pathname, options) => {
      const nodeResult = await node(pathname, options);
      const rustResult = await rust(pathname, options);
      const nodeProviderId = Array.isArray(nodeResult.body)
        ? nodeResult.body[0]?.id
        : nodeResult.body?.id;
      const rustProviderId = Array.isArray(rustResult.body)
        ? rustResult.body[0]?.id
        : rustResult.body?.id;
      const replacements = [
        [nodeProviderId, "<provider-id>"],
        [rustProviderId, "<provider-id>"],
      ].filter(([id]) => typeof id === "string");
      await compare(
        label,
        { status: nodeResult.status, body: normalizeIds(nodeResult, replacements) },
        { status: rustResult.status, body: normalizeIds(rustResult, replacements) },
        { maskKeys: ["updatedAt"] },
      );
    };

    await compareProviders("providers-seeded", "/api/model-providers");
    await compareProviders("upstream-config-from-codex-home", "/api/models/upstream/config");
    await compareProviders("upstream-discover-from-codex-home", "/api/models/upstream/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });

    for (const [label, body] of [
      ["provider-missing-name", { baseUrl: upstream.baseUrl }],
      ["provider-unknown-field", { name: "x", baseUrl: upstream.baseUrl, nope: true }],
      ["provider-null-key", { name: "x", baseUrl: upstream.baseUrl, apiKey: null }],
      ["provider-empty-key", { name: "x", baseUrl: upstream.baseUrl, apiKey: "  " }],
      ["provider-bad-url", { name: "x", baseUrl: "ftp://example.com" }],
    ]) {
      await compareProviders(label, "/api/model-providers", jsonRequest("POST", body));
    }

    const createBody = {
      name: "Conformance Provider",
      baseUrl: upstream.baseUrl,
      wireApi: null,
      isEnabled: true,
      apiKey: "upstream-secret",
    };
    const nodeCreated = await node("/api/model-providers", jsonRequest("POST", createBody));
    const rustCreated = await rust("/api/model-providers", jsonRequest("POST", createBody));
    const nodeProviderId = nodeCreated.body.id;
    const rustProviderId = rustCreated.body.id;
    assert(nodeProviderId.startsWith("provider-"), "node provider id");
    assert(rustProviderId.startsWith("provider-"), "rust provider id");
    const replacements = [
      [nodeProviderId, "<provider-id>"],
      [rustProviderId, "<provider-id>"],
    ];
    await compare(
      "provider-create",
      { status: nodeCreated.status, body: normalizeIds(nodeCreated, replacements) },
      { status: rustCreated.status, body: normalizeIds(rustCreated, replacements) },
      { maskKeys: ["updatedAt"] },
    );

    await compareProviders("providers-after-create", "/api/model-providers");

    const compareProviderRequest = async (label, nodePath, rustPath, options) => {
      const nodeResult = await node(nodePath, options);
      const rustResult = await rust(rustPath, options);
      await compare(
        label,
        { status: nodeResult.status, body: normalizeIds(nodeResult, replacements) },
        { status: rustResult.status, body: normalizeIds(rustResult, replacements) },
        { maskKeys: ["updatedAt"] },
      );
    };

    await compareProviderRequest(
      "provider-endpoint-change-guard",
      `/api/model-providers/${nodeProviderId}`,
      `/api/model-providers/${rustProviderId}`,
      jsonRequest("PATCH", { baseUrl: `${upstream.baseUrl}/changed` }),
    );

    const patchBody = { name: "Renamed Provider", wireApi: "responses", isEnabled: false };
    const nodePatched = await node(`/api/model-providers/${nodeProviderId}`, jsonRequest("PATCH", patchBody));
    const rustPatched = await rust(`/api/model-providers/${rustProviderId}`, jsonRequest("PATCH", patchBody));
    await compare(
      "provider-update",
      { status: nodePatched.status, body: normalizeIds(nodePatched, replacements) },
      { status: rustPatched.status, body: normalizeIds(rustPatched, replacements) },
      { maskKeys: ["updatedAt"] },
    );

    await compareProviderRequest(
      "provider-sync-disabled",
      `/api/model-providers/${nodeProviderId}/models/sync`,
      `/api/model-providers/${rustProviderId}/models/sync`,
      { method: "POST" },
    );

    await compareProviderRequest(
      "provider-reenable",
      `/api/model-providers/${nodeProviderId}`,
      `/api/model-providers/${rustProviderId}`,
      jsonRequest("PATCH", { isEnabled: true }),
    );

    const nodeSync = await node(`/api/model-providers/${nodeProviderId}/models/sync`, { method: "POST" });
    const rustSync = await rust(`/api/model-providers/${rustProviderId}/models/sync`, { method: "POST" });
    assert(nodeSync.status === 200, `node sync failed: ${JSON.stringify(nodeSync.body)}`);
    assert(rustSync.status === 200, `rust sync failed: ${JSON.stringify(rustSync.body)}`);
    assert(nodeSync.body.models.length === 2, "node sync model count");
    assert(rustSync.body.models.length === 2, "rust sync model count");
    const nodeModelId = nodeSync.body.models.find((model) => model.modelId === "model-a").id;
    const rustModelId = rustSync.body.models.find((model) => model.modelId === "model-a").id;
    const normalizeSync = (result) => {
      const body = JSON.parse(JSON.stringify(result.body));
      body.models.sort((left, right) => left.modelId.localeCompare(right.modelId));
      for (const model of body.models) {
        model.id = "<model-id>";
        model.providerId = "<provider-id>";
        model.updatedAt = "<masked>";
      }
      return { status: result.status, body };
    };
    await compare("provider-sync", normalizeSync(nodeSync), normalizeSync(rustSync));

    const nodeSyncAgain = await node(`/api/model-providers/${nodeProviderId}/models/sync`, { method: "POST" });
    const rustSyncAgain = await rust(`/api/model-providers/${rustProviderId}/models/sync`, { method: "POST" });
    assert(nodeSyncAgain.body.models.length === 2, "node sync deduplicated");
    assert(rustSyncAgain.body.models.length === 2, "rust sync deduplicated");

    const serviceBody = (id) => jsonRequest("PUT", { modelIds: [id], defaultModelId: id });
    const nodeService = await node("/api/model-services/conversation", serviceBody(nodeModelId));
    const rustService = await rust("/api/model-services/conversation", serviceBody(rustModelId));
    assert(nodeService.status === 200, `node service: ${JSON.stringify(nodeService.body)}`);
    assert(rustService.status === 200, `rust service: ${JSON.stringify(rustService.body)}`);

    await compareProviderRequest(
      "provider-delete-guard",
      `/api/model-providers/${nodeProviderId}`,
      `/api/model-providers/${rustProviderId}`,
      { method: "DELETE" },
    );

    await compareProviderRequest(
      "provider-delete",
      `/api/model-providers/${nodeProviderId}?removeReferences=true`,
      `/api/model-providers/${rustProviderId}?removeReferences=true`,
      { method: "DELETE" },
    );
    await compareProviders("providers-after-delete", "/api/model-providers");

    const discoveryBody = {
      baseUrl: upstream.baseUrl,
      apiKey: "upstream-secret",
      provider: "discovery-provider",
    };
    await compareProviders(
      "upstream-discover-invalid-field",
      "/api/models/upstream/discover",
      jsonRequest("POST", { ...discoveryBody, unknown: true }),
    );
    await compareProviders(
      "upstream-discover-invalid-json",
      "/api/models/upstream/discover",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
    );
    await compareProviders(
      "upstream-discover",
      "/api/models/upstream/discover",
      jsonRequest("POST", discoveryBody),
    );
    await compareProviders("upstream-discover-empty-body", "/api/models/upstream/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    await compareProviders("upstream-discover-null-body", "/api/models/upstream/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    });
    await compareProviders("upstream-saved-get", "/api/models/upstream");
    await compareProviders("upstream-config-saved", "/api/models/upstream/config");
    await compareProviders(
      "upstream-saved-endpoint-change",
      "/api/models/upstream/discover",
      jsonRequest("POST", { baseUrl: `${upstream.baseUrl}/other` }),
    );

    console.log("[conformance] provider contract matched");
  } finally {
    await pair.stop();
    await upstream.close();
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
}

await main();
