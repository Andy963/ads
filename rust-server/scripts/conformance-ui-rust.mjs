/**
 * Browser conformance for the Rust server: load the production client, log in,
 * send a prompt over the real HTTP/WebSocket APIs, and verify the rendered reply.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assert, startServerPair } from "./lib/black-box.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rustDir = path.resolve(scriptDir, "..");
const root = path.resolve(rustDir, "..");
const gitCommonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const primaryRoot = path.dirname(path.resolve(root, gitCommonDir));
const clientDir = [root, primaryRoot]
  .map((candidate) => path.join(candidate, "client", "dist"))
  .find((candidate) => fs.existsSync(path.join(candidate, "index.html")))
  ?? path.join(root, "client", "dist");
const playwrightEntry = [root, primaryRoot]
  .map((candidate) => path.join(candidate, "client", "node_modules", "playwright", "index.mjs"))
  .find((candidate) => fs.existsSync(candidate))
  ?? path.join(root, "client", "node_modules", "playwright", "index.mjs");

function startUpstream() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += String(chunk); });
    request.on("end", () => {
      requests.push({ url: request.url, body });
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      response.write('data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"from Rust UI"},"finish_reason":"stop"}]}\n\n');
      response.write('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":3,"total_tokens":6}}\n\n');
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resolve({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      requests,
      close: () => new Promise((done) => server.close(done)),
    });
  }));
}

async function main() {
  assert(fs.existsSync(path.join(clientDir, "index.html")), `missing client build: ${clientDir}`);
  assert(fs.existsSync(playwrightEntry), `missing Playwright: ${playwrightEntry}`);
  const { chromium } = await import(pathToFileURL(playwrightEntry).href);
  const upstream = await startUpstream();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ads-rust-ui-workspace-"));
  const screenshot = path.join(rustDir, "target", "ui-rust-conformance.png");
  const pair = await startServerPair({
    root,
    rustDir,
    nodeCwd: root,
    rustCwd: workspace,
    env: {
      ALLOWED_DIRS: workspace,
      ADS_AGENT_RUNTIME: "native",
      ADS_SCHEDULER_ENABLED: "0",
      CODEX_API_KEY: "",
      CODEX_BASE_URL: "",
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      OPENAI_API_BASE: "",
      CCHAT_OPENAI_API_KEY: "",
    },
    rustEnv: { ADS_WEB_CLIENT_DIR: clientDir },
  });
  let browser;
  try {
    const login = await pair.rustRequest("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: pair.username, password: pair.password }),
    });
    assert(login.status === 200, `login failed: ${JSON.stringify(login)}`);
    const cookie = String(login.headers.get("set-cookie") ?? "").split(";")[0];
    const provider = await pair.rustRequest("/api/model-providers", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        name: "UI Fixture",
        baseUrl: upstream.baseUrl,
        wireApi: "chat",
        apiKey: "ui-fixture-key",
      }),
    });
    assert(provider.status === 200, `provider failed: ${JSON.stringify(provider)}`);
    const model = await pair.rustRequest("/api/model-configs", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        modelId: "ui-fixture-model",
        displayName: "UI Fixture Model",
        provider: provider.body.id,
        providerId: provider.body.id,
        isEnabled: true,
        isDefault: true,
        configJson: { max_output_tokens: 1024 },
      }),
    });
    assert(model.status === 200, `model failed: ${JSON.stringify(model)}`);
    const service = await pair.rustRequest("/api/model-services/conversation", {
      method: "PUT",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ modelIds: [model.body.id], defaultModelId: model.body.id }),
    });
    assert(service.status === 200, `service failed: ${JSON.stringify(service)}`);

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(20_000);
    await page.goto(pair.rustBase, { waitUntil: "domcontentloaded" });
    await page.getByTestId("login-username").fill(pair.username);
    await page.getByTestId("login-password").fill(pair.password);
    await page.getByTestId("login-submit").click();
    const composer = page.locator('.lanePanel:not([aria-hidden]) textarea.composer-input').first();
    await composer.waitFor({ state: "visible" });
    await composer.fill("say hello from rust");
    await page.locator('.lanePanel:not([aria-hidden]) button.sendIcon').first().click();
    await page.waitForFunction(() => document.body.textContent?.includes("Hello from Rust UI"));
    const reloaded = await page.locator("body").innerText();
    assert(reloaded.includes("say hello from rust"), "user message was lost after reload");
    assert(reloaded.includes("Hello from Rust UI"), "assistant message was lost after reload");
    const body = await page.locator("body").innerText();
    assert(body.includes("say hello from rust"));
    assert(body.includes("Hello from Rust UI"));
    assert(errors.length === 0, `browser errors: ${JSON.stringify(errors)}`);
    assert(upstream.requests.length > 0, "Rust UI prompt never reached the fake upstream");
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.textContent?.includes("Hello from Rust UI"));
    console.log(`ui rust conformance: ok (${screenshot})`);
  } finally {
    await browser?.close();
    await pair.stop();
    await upstream.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
