#!/usr/bin/env node
/**
 * Black-box conformance for connector bearer authentication on protected HTTP routes.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assert, compare, loginAs, startServerPair } from "./lib/black-box.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");
const rustDir = path.join(root, "rust-server");
const connectorToken = "connector-test-token";

async function main() {
  const pair = await startServerPair({
    root,
    rustDir,
    env: {
      ADS_CONNECTOR_TOKEN: connectorToken,
      ADS_CONNECTOR_USER_ID: "connector-user",
    },
  });
  try {
    const nodeBearer = { authorization: `Bearer ${connectorToken}` };
    const rustBearer = { authorization: `Bearer ${connectorToken}` };

    await compare(
      "connector-project-list",
      await pair.nodeRequest("/api/projects", { headers: nodeBearer }),
      await pair.rustRequest("/api/projects", { headers: rustBearer }),
    );

    await compare(
      "connector-active-project",
      await pair.nodeRequest("/api/projects/active", {
        method: "PATCH",
        headers: { ...nodeBearer, "content-type": "application/json" },
        body: JSON.stringify({ projectId: null }),
      }),
      await pair.rustRequest("/api/projects/active", {
        method: "PATCH",
        headers: { ...rustBearer, "content-type": "application/json" },
        body: JSON.stringify({ projectId: null }),
      }),
    );

    for (const label of ["connector-wrong-token", "connector-missing-token"]) {
      const headers =
        label === "connector-wrong-token"
          ? { authorization: "Bearer wrong-token" }
          : {};
      await compare(
        label,
        await pair.nodeRequest("/api/projects", { headers }),
        await pair.rustRequest("/api/projects", { headers }),
      );
    }

    const nodeLogin = await loginAs(pair.nodeBase, pair.username, pair.password);
    const rustLogin = await loginAs(pair.rustBase, pair.username, pair.password);
    await compare(
      "connector-falls-back-to-session",
      await pair.nodeRequest("/api/projects", {
        headers: { cookie: nodeLogin.cookie, authorization: "Bearer wrong-token" },
      }),
      await pair.rustRequest("/api/projects", {
        headers: { cookie: rustLogin.cookie, authorization: "Bearer wrong-token" },
      }),
    );

    await compare(
      "connector-ignored-on-auth-me",
      await pair.nodeRequest("/api/auth/me", { headers: nodeBearer }),
      await pair.rustRequest("/api/auth/me", { headers: rustBearer }),
    );

    const unauthorized = await pair.rustRequest("/api/projects", {});
    assert(unauthorized.status === 401, `expected 401, got ${unauthorized.status}`);
    console.log("connector conformance: ok");
  } finally {
    await pair.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
