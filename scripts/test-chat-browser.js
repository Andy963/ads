import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, webkit } from "playwright";
import { startChatBrowserServer } from "./lib/chat-browser-server.js";
import { verifyPostSendInteractions } from "./lib/chat-browser-post-send.js";
import { verifyMonotonicHistory } from "./lib/chat-browser-history.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = path.resolve(process.env.ADS_CHAT_BUILD_DIR || path.join(repoRoot, "dist/client"));
const html = await readFile(path.join(buildRoot, "index.html"), "utf8");
const artifacts = await mkdtemp(path.join(tmpdir(), "ads-chat-browser-check-"));
const report = {
  environment: "Linux/macOS browser engines; simulated mobile viewport and composition, not a physical installed iOS PWA",
  assetPaths: [...html.matchAll(/(?:src|href)="([^"\s]*\/assets\/[^"\s]+)"/g)].map((match) => match[1]),
  cases: [],
};
const selected = process.env.ADS_CHAT_BROWSER;
assert.ok(!selected || ["webkit", "chromium"].includes(selected), "Unsupported browser engine");

for (const engine of selected ? [selected] : ["webkit", "chromium"]) {
  const fixture = await startChatBrowserServer(buildRoot, { legacyWorker: true, projects: true });
  let context;
  let page;
  const profile = path.join(artifacts, `${engine}-profile`);
  const result = { engine, checks: [], received: fixture.received, requests: fixture.requests };
  report.cases.push(result);
  try {
    const mobile = engine === "webkit";
    context = await (mobile ? webkit : chromium).launchPersistentContext(profile, {
      ...(mobile && process.env.ADS_WEBKIT_EXECUTABLE ? { executablePath: process.env.ADS_WEBKIT_EXECUTABLE } : {}),
      ...(!mobile && process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
      deviceScaleFactor: 1,
    });
    result.version = context.browser()?.version();
    await context.addInitScript(({ mobile }) => {
      if (!mobile) return;
      const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 });
      window.__chatViewport = viewport;
      Object.defineProperty(window, "visualViewport", { value: viewport });
      Object.defineProperty(navigator, "standalone", { value: true });
    }, { mobile });
    page = await context.newPage();
    const errors = [];
    const browserWarnings = [];
    result.browserErrors = browserWarnings;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (mobile && /\/sw\.js due to access control checks\.$/.test(text)) {
        browserWarnings.push(text);
        return;
      }
      errors.push(text);
    });
    const frames = [];
    result.frames = frames;
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        frames.push({ type: frame.type, historySize: Array.isArray(frame.items) ? frame.items.length : undefined });
      });
    });
    page.setDefaultTimeout(15000);
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const input = () => page.locator("textarea.composer-input:visible");
    const activate = async (selector) => {
      if (mobile) await page.locator(selector).tap();
      else await page.locator(selector).click();
      await settle();
    };
    const chooseLane = async (lane) => {
      await activate(`[data-testid="lane-tab-${lane}"]`);
      assert.equal(await page.locator(`[data-testid="lane-tab-${lane}"]`).getAttribute("aria-selected"), "true");
      assert.equal(await page.locator(".lanePanel:visible").count(), 1);
    };
    const chooseProject = async (projectName, projectId) => {
      if (mobile) await activate('[data-testid="mobile-drawer-toggle"]');
      const row = page.locator("button.projectRow").filter({ hasText: projectName });
      await row.waitFor({ state: "visible" });
      if (mobile) await row.tap();
      else await row.click();
      await settle();
      await page.waitForFunction((expected) => document.querySelector(".app")?.getAttribute("data-project-id") === expected, projectId);
      assert.equal(await page.locator(".app").getAttribute("data-project-id"), projectId);
    };
    const waitForReply = (text) => page.waitForFunction((expected) => [...document.querySelectorAll(".chat")].find((el) => el.offsetParent !== null)?.textContent.includes(expected), text);
    const send = async (text) => {
      await input().fill(text);
      await activate(".sendIcon:visible");
      assert.equal(await input().inputValue(), "", "Accepted prompts must immediately clear the physical textarea");
    };
    await page.goto(`${fixture.origin}/legacy.html`);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    fixture.useCurrentServiceWorker();
    await page.evaluate(async () => {
      window.__previousChatWorker = navigator.serviceWorker.controller;
      const registration = await navigator.serviceWorker.getRegistration();
      await registration.update();
      const waiting = registration.waiting || (await new Promise((resolve) => {
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed") resolve(worker);
          });
        });
      }));
      waiting?.postMessage({ type: "SKIP_WAITING" });
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller !== window.__previousChatWorker);
    result.checks.push("New service worker activates without an updated registration script in the old page");
    await page.goto(fixture.origin);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller && document.querySelector("textarea:not(:disabled)"));
    result.postSend = await verifyPostSendInteractions({ page, fixture, mobile });
    if (mobile) {
      assert.equal(result.postSend.firstSend.focused, true, "The first touch send must preserve keyboard focus");
      assert.equal(result.postSend.secondSend.focused, true, "Subsequent touch sends must preserve keyboard focus");
    }
    result.checks.push("Repeated sends in the same focused editor, five rows while busy, and post-send lane switching without reload");
    await chooseLane("advisor");
    await send("browser-advisor-first");
    await waitForReply("Advisor reply: browser-advisor-first");
    await input().fill("Advisor draft");
    await chooseLane("worker");
    assert.equal(await input().inputValue(), "", "Worker must not inherit the Advisor draft");
    assert.ok(!(await page.locator(".chat:visible").innerText()).includes("Advisor reply"));
    await send("browser-worker-first");
    await chooseLane("advisor");
    assert.equal(await input().inputValue(), "Advisor draft");
    assert.ok(!(await page.locator(".chat:visible").innerText()).includes("Worker reply"));
    await chooseLane("worker");
    await waitForReply("Worker reply: browser-worker-first");
    for (const lane of ["advisor", "worker", "advisor", "worker"]) await chooseLane(lane);
    assert.ok((await page.locator(".chat:visible").innerText()).includes("Worker reply"));
    assert.ok(!(await page.locator(".chat:visible").innerText()).includes("Advisor reply"));
    result.checks.push("Real WebSocket prompt delivery, lane isolation, rapid switching, and draft restoration");

    await page.reload();
    await page.waitForSelector("textarea:not(:disabled):visible");
    await chooseLane("advisor");
    await waitForReply("Advisor reply: browser-advisor-first");
    await chooseLane("worker");
    await waitForReply("Worker reply: browser-worker-first");
    assert.ok(!(await page.locator(".chat:visible").innerText()).includes("Advisor reply"));
    assert.ok(frames.some((frame) => frame.type === "history" && frame.historySize > 0), "Reload must replay persisted nonempty history through the real server");
    result.checks.push("Persisted history replay and lane isolation after page reload");

    await chooseProject("Project B", "browser-project-b");
    await chooseLane("worker");
    const projectBSnapshot = await page.evaluate(() => ({
      app: document.querySelector(".app")?.outerHTML.slice(0, 1200) ?? "",
      chat: [...document.querySelectorAll(".chat")].find((el) => el.offsetParent !== null)?.textContent ?? "",
      diagnostics: window.__ADS_RUNTIME_DIAGNOSTICS__ ?? [],
    }));
    result.projectBSnapshot = projectBSnapshot;
    assert.ok(!projectBSnapshot.chat.includes("Worker reply: browser-worker-first"));
    await send("browser-worker-project-b");
    await waitForReply("Worker reply: browser-worker-project-b");
    assert.ok(!(await page.locator(".chat:visible").innerText()).includes("Worker reply: browser-worker-first"));
    await chooseProject("Project A", "browser-project-a");
    await chooseLane("worker");
    await waitForReply("Worker reply: browser-worker-first");
    assert.ok(!(await page.locator(".chat:visible").innerText()).includes("Worker reply: browser-worker-project-b"));
    result.checks.push("Project switching replaces the visible runtime and restores project-local history");

    if (mobile) {
      await chooseLane("advisor");
      await input().evaluate((element) => {
        element.focus();
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        element.value = "browser-advisor-composition";
        element.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, inputType: "insertCompositionText" }));
      });
      await settle();
      assert.equal(await page.locator(".sendIcon:visible").isEnabled(), true, "Composition text must enable sending before compositionend");
      const sentCount = fixture.received.length;
      await activate(".sendIcon:visible");
      await input().dispatchEvent("compositionend");
      assert.equal(await input().inputValue(), "");
      await waitForReply("Advisor reply: browser-advisor-composition");
      assert.equal(fixture.received.length, sentCount + 1, "One touch must dispatch exactly one prompt");
      result.checks.push("Composition-aware touch submission and empty draft after compositionend");

    }

    result.history = {};
    await verifyMonotonicHistory({ page, send, waitForReply, chooseLane, settle, report: result.history });
    result.checks.push("Bounded initial history, native prepend anchoring, zero scroll writes, and stable DOM rows across direction changes");

    const rowMetrics = [];
    for (const height of mobile ? [844, 430, 300] : [900]) {
      if (mobile) {
        await page.evaluate((height) => {
          window.__chatViewport.height = height;
          window.__chatViewport.dispatchEvent(new Event("resize"));
        }, height);
        await settle();
      }
      for (let rows = 1; rows <= 5; rows += 1) {
        await input().fill(Array.from({ length: rows }, (_, index) => `Line ${index + 1}`).join("\n"));
        await settle();
        const metrics = await input().evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            height: element.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(style.lineHeight),
            padding: Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
            overflow: style.overflowY,
          };
        });
        assert.ok(Math.abs(metrics.height - (metrics.lineHeight * rows + metrics.padding)) <= 1, `Viewport ${height} must display ${rows} full rows, got ${metrics.height}px`);
        assert.equal(metrics.overflow, "hidden");
        rowMetrics.push({ viewport: height, rows, height: metrics.height });
      }
      await input().fill("Long line\n".repeat(12));
      await settle();
      const capped = await input().evaluate((element) => ({ height: element.getBoundingClientRect().height, overflow: getComputedStyle(element).overflowY }));
      assert.equal(capped.height, rowMetrics.at(-1).height, "The input must stop at five rows");
      assert.equal(capped.overflow, "auto");
      if (mobile) {
        const transientHeight = await input().evaluate((element) => {
          const previous = window.__chatViewport.height;
          window.__chatViewport.height = 210;
          window.__chatViewport.dispatchEvent(new Event("resize"));
          const measured = element.getBoundingClientRect().height;
          window.__chatViewport.height = previous;
          window.__chatViewport.dispatchEvent(new Event("resize"));
          return measured;
        });
        assert.equal(transientHeight, capped.height, "Transient viewport events must not apply a second height cap before root layout updates");
      }
    }
    result.rowMetrics = rowMetrics;
    result.checks.push("One-to-five row growth, internal scrolling, and keyboard viewport transitions");
    await page.screenshot({ path: path.join(artifacts, `${engine}-five-rows.png`) });
    await input().fill("Short");
    await settle();
    assert.equal(await input().evaluate((element) => element.getBoundingClientRect().height), rowMetrics[0].height);
    const runtimeDiagnostics = await page.evaluate(() => {
      const diagnostics = window.__ADS_RUNTIME_DIAGNOSTICS__;
      return Array.isArray(diagnostics) ? diagnostics : [];
    });
    result.runtimeDiagnostics = runtimeDiagnostics;
    assert.deepEqual(errors, [], "The browser must not report runtime errors");
    assert.deepEqual(runtimeDiagnostics, [], "The app must not record runtime diagnostics during the switching flow");
    result.serviceWorkerControlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
    assert.equal(result.serviceWorkerControlled, true, "The tested page must remain controlled by the new service worker");
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = String(error.stack ?? error);
    if (page) result.dom = await page.evaluate(() => ({
      controlled: Boolean(navigator.serviceWorker.controller),
      inputDisabled: document.querySelector("textarea")?.disabled,
      inputLength: document.querySelector("textarea")?.value.length,
      selectedLane: document.querySelector('[role="tab"][aria-selected="true"]')?.id,
      app: document.querySelector(".app")?.outerHTML.slice(0, 1600),
      chat: [...document.querySelectorAll(".chat")].find((el) => el.offsetParent !== null)?.textContent,
      diagnostics: window.__ADS_RUNTIME_DIAGNOSTICS__ ?? [],
    })).catch(() => null);
    if (page) await page.screenshot({ path: path.join(artifacts, `${engine}-failure.png`) }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await context?.close();
    await fixture.close();
    await rm(profile, { recursive: true, force: true });
    await writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
  }
}
console.log(JSON.stringify({ artifacts, ...report }, null, 2));
