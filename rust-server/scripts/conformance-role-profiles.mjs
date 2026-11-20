#!/usr/bin/env node
/**
 * Black-box role-profile conformance: compare the TypeScript and Rust APIs.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compare, loginAs, startServerPair } from "./lib/black-box.mjs";

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
    const compareRole = async (label, pathname, options) =>
      compare(label, await node(pathname, options), await rust(pathname, options), {
        maskKeys: ["updated_at"],
      });

    await compareRole("role-profiles-seeded", "/api/role-profiles");

    const invalid = [
      ["role-profile-invalid-effort", { reasoning_effort: "extreme" }],
      ["role-profile-empty-prompt", { system_prompt: "   " }],
      ["role-profile-null-enabled", { is_enabled: null }],
      ["role-profile-invalid-model", { model_id: "missing-model" }],
    ];
    for (const [label, body] of invalid) {
      await compareRole(
        label,
        "/api/role-profiles/profile-default-acopilot",
        jsonRequest("PUT", body),
      );
    }
    await compareRole(
      "role-profile-missing",
      "/api/role-profiles/profile-missing",
      jsonRequest("PUT", { name: "Nope" }),
    );

    await compareRole(
      "role-profile-update",
      "/api/role-profiles/profile-default-acopilot",
      jsonRequest("PUT", {
        name: "Updated Acopilot",
        model_id: "model-seed-codex-gpt-5-5",
        reasoning_effort: "low",
        system_prompt: "  Updated system prompt.  ",
        is_enabled: false,
        is_default: true,
      }),
    );
    await compareRole("role-profiles-after-update", "/api/role-profiles");

    console.log("[conformance] role profile contract matched");
  } finally {
    await pair.stop();
  }
}

await main();
