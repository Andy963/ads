#!/usr/bin/env node
/**
 * Black-box HTTP boundary conformance: origin checks, JSON content-type
 * tolerance, and the 1,000,000 byte request body limit.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compare,
  loginAs,
  startServerPair,
} from "./lib/black-box.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");
const rustDir = path.join(root, "rust-server");

function paddedLoginBody(length) {
  const prefix = '{"username":"admin","password":"secret","padding":"';
  const suffix = '"}';
  const body = prefix + "a".repeat(length - prefix.length - suffix.length) + suffix;
  if (Buffer.byteLength(body) !== length) {
    throw new Error(`unexpected body length: ${Buffer.byteLength(body)}`);
  }
  return body;
}

function oversizedBody() {
  const prefix = '{"x":"';
  const suffix = '"}';
  return prefix + "a".repeat(1_000_001 - prefix.length - suffix.length) + suffix;
}

async function main() {
  const pair = await startServerPair({ root, rustDir });
  try {
    await pair.compareBoth("json-without-content-type", "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "admin", password: "secret" }),
    });
    await pair.compareBoth("json-at-exact-limit", "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: paddedLoginBody(1_000_000),
    });

    const body = oversizedBody();
    for (const [label, pathname, method] of [
      ["projects-auth-before-body", "/api/projects", "POST"],
      ["model-config-auth-before-body", "/api/model-configs", "POST"],
      ["discovery-auth-before-body", "/api/models/upstream/discover", "POST"],
      ["model-service-auth-before-body", "/api/model-services/conversation", "PUT"],
    ]) {
      await pair.compareBoth(label, pathname, {
        method,
        headers: { "content-type": "application/json" },
        body,
      });
    }

    const nodeLogin = await loginAs(pair.nodeBase, "admin", "secret");
    const rustLogin = await loginAs(pair.rustBase, "admin", "secret");
    await compare(
      "unknown-api-authenticated",
      await pair.nodeRequest("/api/not-a-route", {
        headers: { cookie: nodeLogin.cookie },
      }),
      await pair.rustRequest("/api/not-a-route", {
        headers: { cookie: rustLogin.cookie },
      }),
    );
    const cases = [
      ["login-over-limit", "/api/auth/login", "POST", null],
      ["projects-over-limit", "/api/projects", "POST", "cookie"],
      ["model-config-over-limit", "/api/model-configs", "POST", "cookie"],
      ["provider-over-limit", "/api/model-providers", "POST", "cookie"],
      ["role-profile-over-limit", "/api/role-profiles/worker", "PUT", "cookie"],
      ["discovery-over-limit", "/api/models/upstream/discover", "POST", "cookie"],
      ["model-service-over-limit", "/api/model-services/conversation", "PUT", "cookie"],
    ];
    for (const [label, pathname, method, auth] of cases) {
      const nodeHeaders = { "content-type": "application/json" };
      const rustHeaders = { "content-type": "application/json" };
      if (auth) {
        nodeHeaders.cookie = nodeLogin.cookie;
        rustHeaders.cookie = rustLogin.cookie;
      }
      await compare(
        label,
        await pair.nodeRequest(pathname, { method, headers: nodeHeaders, body }),
        await pair.rustRequest(pathname, { method, headers: rustHeaders, body }),
      );
    }

    await pair.compareBoth("origin-untrusted", "/api/auth/logout", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    await pair.compareBoth("origin-loopback", "/api/auth/logout", {
      method: "POST",
      headers: { origin: "http://localhost:5173" },
    });
    await pair.compareBoth("origin-missing", "/api/auth/logout", {
      method: "POST",
    });

    await pair.compareBoth("healthz", "/healthz");
    await pair.compareBoth("spa-without-build", "/dashboard");
    await pair.compareBoth("non-get-ui", "/", { method: "POST" });
    await pair.compareBoth("unknown-api", "/api/not-a-route");
    await pair.compareBoth("unknown-api-origin", "/api/not-a-route", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });

    console.log("[conformance] HTTP boundaries matched");
  } finally {
    await pair.stop();
  }
}

await main();
