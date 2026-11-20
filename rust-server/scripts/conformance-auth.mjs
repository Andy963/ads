#!/usr/bin/env node
/**
 * Black-box auth conformance: run the TypeScript and Rust servers side by side
 * with isolated state directories and compare their observable HTTP behavior.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assert,
  assertJson,
  compare,
  cookieAttributes,
  cookiePair,
  startServerPair,
} from "./lib/black-box.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "../..");
const rustDir = path.join(root, "rust-server");

function loginRequest(password) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  };
}

async function main() {
  const pair = await startServerPair({ root, rustDir });
  try {
    await pair.compareBoth("status", "/api/auth/status");

    await pair.compareBoth("invalid-login", "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    await pair.compareBoth("wrong-password", "/api/auth/login", loginRequest("wrong"));

    const nodeLogin = await pair.nodeRequest("/api/auth/login", loginRequest("secret"));
    const rustLogin = await pair.rustRequest("/api/auth/login", loginRequest("secret"));
    await compare("login", nodeLogin, rustLogin);
    assert(nodeLogin.headers.has("set-cookie"), "node login did not set a cookie");
    assert(rustLogin.headers.has("set-cookie"), "rust login did not set a cookie");

    const nodeCookie = nodeLogin.headers.get("set-cookie");
    const rustCookie = rustLogin.headers.get("set-cookie");
    assert(cookiePair(nodeCookie).startsWith("ads_session="), "unexpected node cookie name");
    assert(cookiePair(rustCookie).startsWith("ads_session="), "unexpected rust cookie name");
    assertJson(cookieAttributes(rustCookie), cookieAttributes(nodeCookie), "login cookie attributes");

    const nodeCookiePair = cookiePair(nodeCookie);
    const rustCookiePair = cookiePair(rustCookie);
    await compare(
      "me",
      await pair.nodeRequest("/api/auth/me", { headers: { cookie: nodeCookiePair } }),
      await pair.rustRequest("/api/auth/me", { headers: { cookie: rustCookiePair } }),
      { masks: ["id"] },
    );

    const nodeLogout = await pair.nodeRequest("/api/auth/logout", {
      method: "POST",
      headers: { cookie: nodeCookiePair },
    });
    const rustLogout = await pair.rustRequest("/api/auth/logout", {
      method: "POST",
      headers: { cookie: rustCookiePair },
    });
    await compare("logout", nodeLogout, rustLogout);
    assertJson(
      cookieAttributes(rustLogout.headers.get("set-cookie")),
      cookieAttributes(nodeLogout.headers.get("set-cookie")),
      "clear cookie attributes",
    );

    await pair.compareBoth("me-after-logout", "/api/auth/me", {
      headers: { cookie: nodeCookiePair },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await pair.compareBoth(
        `lockout-failure-${attempt + 1}`,
        "/api/auth/login",
        loginRequest("wrong"),
      );
    }
    const nodeLocked = await pair.nodeRequest("/api/auth/login", loginRequest("wrong"));
    const rustLocked = await pair.rustRequest("/api/auth/login", loginRequest("wrong"));
    await compare("lockout", nodeLocked, rustLocked);
    assert(nodeLocked.headers.has("retry-after"), "node lockout omitted Retry-After");
    assert(rustLocked.headers.has("retry-after"), "rust lockout omitted Retry-After");

    console.log("[conformance] auth contract matched");
  } finally {
    await pair.stop();
  }
}

await main();
