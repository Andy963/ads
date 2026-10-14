// Run after building and installing WebKit:
// node --test tests/scripts/chatServiceWorkerLifecycle.browser.js
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { webkit } from "playwright";
import {
  observeChatServiceWorkerLifecycle,
  waitForChatServiceWorkerLifecycle,
} from "../../scripts/lib/chat-service-worker-lifecycle.js";
import { startChatBrowserServer } from "../../scripts/lib/chat-browser-server.js";

const buildRoot = fileURLToPath(new URL("../../dist/client", import.meta.url));

async function waitUntil(predicate) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for the service worker request");
    await delay(10);
  }
}

for (const synchronized of [false, true]) {
  test(synchronized
    ? "registration barrier prevents cancellation with a held service worker response"
    : "DOMContentLoaded followed by reload cancels a held service worker registration", { timeout: 30_000 }, async (t) => {
    t.diagnostic("Starting fixture");
    const fixture = await startChatBrowserServer(path.resolve(process.env.ADS_CHAT_BUILD_DIR || buildRoot), { legacyWorker: true });
    let browser;
    let gate;
    t.after(async () => { gate?.release(); await browser?.close(); await fixture.close(); });
    browser = await webkit.launch({
      ...(process.env.ADS_WEBKIT_EXECUTABLE ? { executablePath: process.env.ADS_WEBKIT_EXECUTABLE } : {}),
    });
    t.diagnostic("Browser launched");
    const page = await browser.newPage({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(10_000);
    await page.addInitScript(observeChatServiceWorkerLifecycle);
    const failures = [];
    const errors = [];
    const lifecycle = [];
    page.on("requestfailed", (request) => {
      if (new URL(request.url()).pathname === "/sw.js") failures.push(request.failure());
    });
    page.on("pageerror", (error) => errors.push({ message: error.message, stack: error.stack }));
    page.on("console", (message) => {
      const prefix = "CHAT_SW_LIFECYCLE ";
      if (message.text().startsWith(prefix)) lifecycle.push(JSON.parse(message.text().slice(prefix.length)));
    });

    await page.goto(`${fixture.origin}/legacy.html`);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    t.diagnostic("Legacy worker controls the page");
    fixture.useCurrentServiceWorker();
    await page.evaluate(async () => {
      window.__previousWorker = navigator.serviceWorker.controller;
      const registration = await navigator.serviceWorker.getRegistration();
      const installed = new Promise((resolve) => {
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed") resolve(worker);
          });
        }, { once: true });
      });
      await registration.update();
      (registration.waiting || await installed).postMessage({ type: "SKIP_WAITING" });
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== window.__previousWorker);
    t.diagnostic("Current worker controls the page");

    gate = fixture.holdServiceWorker();
    await page.goto(fixture.origin, { waitUntil: "domcontentloaded" });
    await waitUntil(() => gate.received() > 0);
    await page.waitForLoadState("load");
    await page.waitForFunction(() => window.__chatServiceWorkerLifecycle.pending > 0);
    t.diagnostic("Registration response held");
    if (!synchronized) {
      // The original navigation order has no registration completion barrier.
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitUntil(() => gate.cancelled() > 0 && failures.length > 0);
      assert.ok(failures.some((failure) => /cancelled/i.test(failure.errorText)));
      gate.release();
      await waitForChatServiceWorkerLifecycle(page);
      t.diagnostic(JSON.stringify({ cancelled: gate.cancelled(), failures, errors, lifecycle }));
      return;
    }

    let settled = false;
    const barrier = waitForChatServiceWorkerLifecycle(page).then((state) => { settled = true; return state; });
    try {
      // A real load event is insufficient: the response remains under test control.
      await delay(100);
      assert.equal(settled, false, "Must not navigate while registration is held");
    } finally { gate.release(); }
    assert.deepEqual(await barrier, { pending: 0, registered: 1, updated: 1, failures: [] });
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForChatServiceWorkerLifecycle(page);
    assert.equal(gate.cancelled(), 0);
    assert.deepEqual(failures, [], "The fixed sequence must not cancel any SW request");
    assert.deepEqual(errors, [], "The fixed sequence must not suppress any pageerror");
    assert.equal(lifecycle.some((event) => event.status === "rejected"), false);
    t.diagnostic(JSON.stringify({ cancelled: gate.cancelled(), failures, errors }));
  });
}
