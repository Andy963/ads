import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, webkit } from "playwright";
import { startChatBrowserServer } from "./lib/chat-browser-server.js";
import { verifyPostSendInteractions } from "./lib/chat-browser-post-send.js";
import { verifyMonotonicHistory } from "./lib/chat-browser-history.js";
import { verifyLocalFirstTranscript } from "./lib/chat-browser-local-first.js";
import { verifyChatNavigation } from "./lib/chat-browser-navigation.js";

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
    result.errorDetails = [];
    result.failedRequests = [];
    page.on("requestfailed", (request) => result.failedRequests.push({
      url: request.url(), failure: request.failure(), offline: result.localFirst?.offline,
    }));
    const browserWarnings = [];
    const isExpectedOutageError = (text) => mobile && result.localFirst?.offlineMode?.startsWith("origin-unreachable") && (
      [...fixture.refusedRequests].some((requestPath) =>
        text.endsWith(`${new URL(fixture.origin).host}${requestPath} due to access control checks.`)) ||
      /\/(?:sw\.js|api\/[^ ]+) due to access control checks\.$/.test(text) ||
      /Failed to load resource: the server responded with a status of 503 \(Service Unavailable\)/.test(text)
    );
    const isWebKitApiCorsNoise = (text) => mobile &&
      /^\/(?:127\.0\.0\.1|localhost):\d+\/api\/[^ ]+ due to access control checks\.$/.test(text);
    result.browserErrors = browserWarnings;
    result.dialogs = [];
    page.on("dialog", async (dialog) => {
      result.dialogs.push({ type: dialog.type(), message: dialog.message() });
      await dialog.dismiss();
    });
    page.on("pageerror", (error) => {
      if (isWebKitApiCorsNoise(error.message)) {
        // Linux WebKit can emit a pageerror for successful same-origin API
        // responses while a service worker replaces the legacy worker. Keep
        // the event visible in the report; request and functional assertions
        // still determine whether the browser run actually failed.
        browserWarnings.push(error.message);
        return;
      }
      if (isExpectedOutageError(error.message)) {
        browserWarnings.push(error.message);
        return;
      }
      if (mobile && result.localFirst?.offlineMode?.startsWith("origin-unreachable") && /\/sw\.js due to access control checks\.$/.test(error.message)) {
        // WebKit may surface the deliberately refused worker update as a page
        // error instead of a console network error. Keep it in the report; the
        // cached reload and continuing SW control are still asserted below.
        browserWarnings.push(error.message);
        return;
      }
      errors.push(error.message);
      result.errorDetails.push({ source: "pageerror", text: error.message, offline: result.localFirst?.offline, refused: [...fixture.refusedRequests] });
    });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (isWebKitApiCorsNoise(text)) {
        browserWarnings.push(text);
        return;
      }
      if (isExpectedOutageError(text)) {
        browserWarnings.push(text);
        return;
      }
      if (result.localFirst?.offline && /load failed|failed to load resource|network|WebSocket connection/i.test(text)) {
        browserWarnings.push(text);
        return;
      }
      if (mobile && /\/sw\.js due to access control checks\.$/.test(text)) {
        browserWarnings.push(text);
        return;
      }
      errors.push(text);
      result.errorDetails.push({ source: "console", text, offline: result.localFirst?.offline, refused: [...fixture.refusedRequests] });
    });
    const frames = [];
    result.frames = frames;
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        frames.push({ type: frame.type, historyMode: frame.historyMode, chatSessionId: frame.chatSessionId,
          latestSeq: frame.latestSeq, historySize: Array.isArray(frame.items) ? frame.items.length : undefined });
      });
    });
    page.setDefaultTimeout(15000);
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // Both lane panels stay mounted; the active panel is the one without aria-hidden.
    const activePanel = () => page.locator('.lanePanel:not([aria-hidden])');
    const input = () => activePanel().locator("textarea.composer-input");
    const sendButton = () => activePanel().locator(".sendIcon");
    const visibleChat = () => activePanel().locator(".chat");
    const activate = async (target) => {
      const locator = typeof target === "string" ? page.locator(target) : target;
      if (mobile) await locator.tap();
      else await locator.click();
      await settle();
    };
    const chooseLane = async (lane) => {
      await activate(`[data-testid="lane-tab-${lane}"]`);
      await page.locator(`[data-testid="lane-panel-${lane}"]`).waitFor({ state: "visible" });
      await page.waitForFunction((expectedLane) => {
        const panel = document.querySelector(`[data-testid="lane-panel-${expectedLane}"]`);
        if (!panel || panel.hasAttribute("aria-hidden")) return false;
        const track = document.querySelector(".lanePanelsTrack");
        if (track && getComputedStyle(track).display !== "contents") {
          const tx = new DOMMatrixReadOnly(getComputedStyle(track).transform).m41;
          const expected = expectedLane === "worker" ? -track.clientWidth / 2 : 0;
          if (Math.abs(tx - expected) > 2) return false;
        }
        return true;
      }, lane);
      assert.equal(await page.locator(`[data-testid="lane-tab-${lane}"]`).getAttribute("aria-selected"), "true");
      assert.equal(await activePanel().count(), 1);
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
    const waitForReply = (text) => page.waitForFunction((expected) => document.querySelector('.lanePanel:not([aria-hidden]) .chat')?.textContent.includes(expected), text);
    const send = async (text) => {
      await input().fill(text);
      await activate(sendButton());
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
    await page.goto(fixture.origin, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => navigator.serviceWorker.controller && document.querySelector("textarea:not(:disabled)"));
    result.postSend = await verifyPostSendInteractions({ page, fixture, mobile });
    if (mobile) {
      assert.equal(result.postSend.firstSend.focused, true, "The first touch send must preserve keyboard focus");
      assert.equal(result.postSend.secondSend.focused, true, "Subsequent touch sends must preserve keyboard focus");
    }
    result.checks.push("Repeated sends in the same focused editor, five rows while busy, and post-send lane switching without reload");
    await chooseLane("advisor");
    if (mobile) {
      const releaseThinkingReply = fixture.holdReply("browser-advisor-thinking-dots");
      try {
        await send("browser-advisor-thinking-dots");
        const dots = page.locator(".thinkingDots:visible");
        await dots.waitFor();
        assert.equal(await dots.locator(".thinkingDot").count(), 3);
        const initialDot = await dots.locator(".thinkingDot").first().evaluate((dot) => ({
          opacity: Number(getComputedStyle(dot).opacity),
          top: dot.getBoundingClientRect().top,
        }));
        await page.waitForFunction((initial) => {
          const dot = document.querySelector(".chat .thinkingDot");
          return dot && Math.abs(Number(getComputedStyle(dot).opacity) - initial.opacity) > 0.3
            && Math.abs(dot.getBoundingClientRect().top - initial.top) > 0.8;
        }, initialDot);

        const initialPixels = await dots.screenshot();
        let pixelsChanged = false;
        for (let sample = 0; sample < 6 && !pixelsChanged; sample += 1) {
          await page.waitForTimeout(180);
          pixelsChanged = !initialPixels.equals(await dots.screenshot());
        }
        assert.ok(pixelsChanged, "Thinking dots must produce different painted pixels, not only different classes");
      } finally {
        releaseThinkingReply();
      }
      await waitForReply("Advisor reply: browser-advisor-thinking-dots");
      assert.equal(await page.locator(".thinkingDots:visible").count(), 0);
      result.checks.push("Thinking dots change opacity, position, and painted pixels in mobile WebKit, then disappear on reply");
    }
    await send("browser-advisor-first");
    await waitForReply("Advisor reply: browser-advisor-first");
    await input().fill("Advisor draft");
    await chooseLane("worker");
    assert.equal(await input().inputValue(), "", "Worker must not inherit the Advisor draft");
    assert.ok(!(await visibleChat().innerText()).includes("Advisor reply"));
    await send("browser-worker-first");
    await chooseLane("advisor");
    assert.equal(await input().inputValue(), "Advisor draft");
    assert.ok(!(await visibleChat().innerText()).includes("Worker reply"));
    await chooseLane("worker");
    await waitForReply("Worker reply: browser-worker-first");
    for (const lane of ["advisor", "worker", "advisor", "worker"]) await chooseLane(lane);
    assert.ok((await visibleChat().innerText()).includes("Worker reply"));
    assert.ok(!(await visibleChat().innerText()).includes("Advisor reply"));
    result.checks.push("Real WebSocket prompt delivery, lane isolation, rapid switching, and draft restoration");

    // Two-phase reading viewport: while interim notes and a command stream in,
    // the viewport follows the tail; once the final answer can fill the
    // viewport, one alignment pins the answer top (12px offset) and locks;
    // burst growth must not move the reading position; the floating button
    // hands bottom-following back.
   await send("browser-worker-burst");
   const visibleChatMetrics = () => page.evaluate(() => {
      const chat = document.querySelector(".lanePanel:not([aria-hidden]) .chat");
      if (!chat) return null;
      const answerRow = [...chat.querySelectorAll(".msg[data-id]")]
        .find((el) => el.textContent.includes("burst answer anchor line"));
      return {
        scrollTop: chat.scrollTop,
        bottomGap: chat.scrollHeight - chat.clientHeight - chat.scrollTop,
        overflowAnchor: chat.style.overflowAnchor,
        answerTopDelta: answerRow ? answerRow.getBoundingClientRect().top - chat.getBoundingClientRect().top : null,
        fabVisible: Boolean(chat.parentElement?.querySelector(".scrollToBottom")),
      };
    });
   const visibleChatState = (extra) => page.waitForFunction((check) => {
      const chat = document.querySelector(".lanePanel:not([aria-hidden]) .chat");
      if (!chat) return false;
      const state = {
        tall: chat.scrollHeight > chat.clientHeight + 150,
        midCommands: chat.textContent.includes("fixture burst command"),
        answerText: chat.textContent.includes("burst answer anchor line"),
        tailText: chat.textContent.includes("burst tail line 50"),
        bottomGap: chat.scrollHeight - chat.clientHeight - chat.scrollTop,
      };
      if (check === "command-tail") return state.tall && state.midCommands && !state.answerText && state.bottomGap <= 8;
      if (check === "burst-grown") return state.tailText;
      if (check === "released-bottom") return state.tailText && state.bottomGap <= 8;
      return false;
    }, extra);
    await visibleChatState("command-tail");
    const executionPhase = await visibleChatMetrics();
    assert.ok(executionPhase, "The visible chat must be measurable during the command phase");
    assert.ok(executionPhase.bottomGap <= 8, `Command output must stay pinned to the tail, got bottom gap ${executionPhase.bottomGap}`);
    assert.notEqual(executionPhase.overflowAnchor, "none", "Native scroll anchoring must stay untouched during tail-following");
   assert.equal(executionPhase.fabVisible, false, "No floating button while following the tail");
   await page.waitForFunction(() => {
      const chat = document.querySelector(".lanePanel:not([aria-hidden]) .chat");
      if (!chat) return false;
      const answerRow = [...chat.querySelectorAll(".msg[data-id]")]
        .find((el) => el.textContent.includes("burst answer anchor line"));
      if (!answerRow) return false;
      const delta = answerRow.getBoundingClientRect().top - chat.getBoundingClientRect().top;
      if (Math.abs(delta - 12) > 24) {
        window.__readingAnchorLastTop = -1;
        return false;
      }
      // Resolve only once the smooth alignment has settled: two consecutive
      // polls at the same scroll position.
      const top = chat.scrollTop;
      if (window.__readingAnchorLastTop === top) return true;
      window.__readingAnchorLastTop = top;
      return false;
    });
    const anchored = await visibleChatMetrics();
    assert.ok(anchored && anchored.answerTopDelta !== null, "The answer row must exist once its first delta lands");
    assert.ok(Math.abs(anchored.answerTopDelta - 12) <= 24, `The answer top must sit ~12px below the viewport top, got ${anchored.answerTopDelta}`);
    assert.equal(anchored.overflowAnchor, "none", "The reading lock must disable native scroll anchoring");
    assert.equal(anchored.fabVisible, true, "The floating button must appear once bottom-following pauses");
    await page.screenshot({ path: path.join("/tmp", `reading-viewport-anchor-${engine}.png`) });
    await visibleChatState("burst-grown");
    await settle();
    const afterBurst = await visibleChatMetrics();
    assert.ok(afterBurst, "The visible chat must be measurable after the burst");
    assert.ok(Math.abs(afterBurst.scrollTop - anchored.scrollTop) <= 2, `Burst growth must not move the reading position (${anchored.scrollTop} -> ${afterBurst.scrollTop})`);
    await page.screenshot({ path: path.join("/tmp", `reading-viewport-burst-${engine}.png`) });
    await activate(".scrollToBottom:visible");
    await visibleChatState("released-bottom");
    const released = await visibleChatMetrics();
    assert.equal(released?.overflowAnchor, "auto", "Releasing the lock must restore native scroll anchoring");
    await waitForReply("burst tail line 50");
    result.checks.push("Two-phase reading viewport: tail-followed commands, one-shot answer anchor, stable burst growth, and button release");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("textarea:not(:disabled):visible");
    await chooseLane("advisor");
    await waitForReply("Advisor reply: browser-advisor-first");
    await chooseLane("worker");
    await waitForReply("Worker reply: browser-worker-first");
    assert.ok(!(await visibleChat().innerText()).includes("Advisor reply"));
    assert.ok(frames.some((frame) => frame.type === "welcome" && frame.historyMode === "resume"), "Reload must validate the cached baseline through the real server");
    result.checks.push("Cached transcript resume and lane isolation after page reload");

    // A client without a cache must still receive the authoritative snapshot.
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) if (key.startsWith("ads.transcript.v1.")) localStorage.removeItem(key);
    });
    const uncachedStart = frames.length;
    // Clear after pagehide persistence as well, using a one-shot startup script.
    await page.evaluate(() => sessionStorage.setItem("browser-clear-transcript-cache", "1"));
    await page.addInitScript(() => {
      if (sessionStorage.getItem("browser-clear-transcript-cache") !== "1") return;
      sessionStorage.removeItem("browser-clear-transcript-cache");
      for (const key of Object.keys(localStorage)) if (key.startsWith("ads.transcript.v1.")) localStorage.removeItem(key);
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("textarea:not(:disabled):visible");
    await chooseLane("worker");
    await waitForReply("Worker reply: browser-worker-first");
    assert.ok(frames.slice(uncachedStart).some((frame) => frame.type === "history" && frame.historySize > 0), "An uncached client must receive real persisted history");
    result.checks.push("Uncached authoritative bootstrap remains available");

    await chooseProject("Project B", fixture.projects[1].id);
    await chooseLane("worker");
    const projectBSnapshot = await page.evaluate(() => ({
      app: document.querySelector(".app")?.outerHTML.slice(0, 1200) ?? "",
      chat: document.querySelector('.lanePanel:not([aria-hidden]) .chat')?.textContent ?? "",
      diagnostics: window.__ADS_RUNTIME_DIAGNOSTICS__ ?? [],
    }));
    result.projectBSnapshot = projectBSnapshot;
    assert.ok(!projectBSnapshot.chat.includes("Worker reply: browser-worker-first"));
    await send("browser-worker-project-b");
    await waitForReply("Worker reply: browser-worker-project-b");
    assert.ok(!(await visibleChat().innerText()).includes("Worker reply: browser-worker-first"));
    await chooseProject("Project A", fixture.projects[0].id);
    await chooseLane("worker");
    await waitForReply("Worker reply: browser-worker-first");
    assert.ok(!(await visibleChat().innerText()).includes("Worker reply: browser-worker-project-b"));
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
      assert.equal(await sendButton().isEnabled(), true, "Composition text must enable sending before compositionend");
      const sentCount = fixture.received.length;
      await activate(sendButton());
      await input().dispatchEvent("compositionend");
      assert.equal(await input().inputValue(), "");
      await waitForReply("Advisor reply: browser-advisor-composition");
      assert.equal(fixture.received.length, sentCount + 1, "One touch must dispatch exactly one prompt");
      result.checks.push("Composition-aware touch submission and empty draft after compositionend");

    }

    result.history = {};
    await verifyMonotonicHistory({ page, send, waitForReply, chooseLane, settle, report: result.history });
    result.checks.push("Bounded initial history, native prepend anchoring, zero scroll writes, and stable DOM rows across direction changes");
    result.navigation = await verifyChatNavigation({ page, mobile, settle });
    result.checks.push("Repeated left-edge menu taps, reachable 44px bottom control, and complete bottom navigation");
    result.localFirst = {};
    await verifyLocalFirstTranscript({ page, context, fixture, frames, send, waitForReply, chooseLane, settle, report: result.localFirst, engine });
    result.checks.push("Cached first frame, retained scroll anchor, offline reload, unchanged reconnect and real HTTP delta catch-up");

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
    assert.deepEqual(result.dialogs, [], "Cache and lane navigation must not open unexpected diagnostic dialogs");
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
      chat: document.querySelector('.lanePanel:not([aria-hidden]) .chat')?.textContent,
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
