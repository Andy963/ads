import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = path.resolve(process.env.ADS_COMPOSER_BUILD_DIR || path.join(repoRoot, "dist/client"));
const artifacts = await mkdtemp(path.join(tmpdir(), "ads-composer-check-"));
const profile = path.join(artifacts, "profile");
const html = await readFile(path.join(buildRoot, "index.html"), "utf8");
const assetPaths = [...html.matchAll(/(?:src|href)="([^"\s]*\/assets\/[^"\s]+)"/g)].map((match) => match[1]);
assert.ok(assetPaths.length >= 2, "The browser check requires a built client artifact");
const heightFilter = process.env.ADS_COMPOSER_VIEWPORT_HEIGHT ? Number(process.env.ADS_COMPOSER_VIEWPORT_HEIGHT) : null;
assert.ok(heightFilter === null || [844, 430, 360, 300].includes(heightFilter), "Unsupported visual viewport height");
const stateFilter = process.env.ADS_COMPOSER_DRAFT_STATE || null;
assert.ok(stateFilter === null || ["empty", "short", "wrapped", "newlines", "capped"].includes(stateFilter), "Unsupported draft state");
const contentTypes = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = path.resolve(buildRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${buildRoot}${path.sep}`)) throw new Error("Invalid asset path");
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": contentTypes[path.extname(file)] || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const browser = spawn(process.env.CHROME_BIN || "/usr/bin/google-chrome", [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
  "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

let socket;
let captureScreenshot;
let captureState;
const report = { environment: "Desktop Chrome with touch and simulated visual viewport; not installed iOS", buildRoot, assetPaths, cases: [] };
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Browser startup timed out")), 15000);
    browser.stderr.on("data", (chunk) => {
      const match = String(chunk).match(/DevTools listening on (ws:\/\/\S+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
    browser.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  socket = new WebSocket(endpoint);
  await once(socket, "open");
  let sequence = 0;
  let sessionId;
  let fileChoosers = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Page.fileChooserOpened") fileChoosers++;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
  await send("Page.enable");
  await send("Page.setInterceptFileChooserDialog", { enabled: true });
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.setBlockedURLs", { urls: ["https://fonts.googleapis.com/*", "https://fonts.gstatic.com/*"] });
  report.browser = (await send("Browser.getVersion")).product;
  captureScreenshot = async (name) => writeFile(path.join(artifacts, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__composerErrors = [];
    window.__composerEvents = [];
    localStorage.clear();
    sessionStorage.clear();
    window.addEventListener("error", event => window.__composerErrors.push(event.error?.name || "Error"));
    window.__composerViewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, offsetLeft: 0, scale: 1 });
    Object.defineProperty(window.__composerViewport, "width", { get: () => innerWidth });
    Object.defineProperty(window, "visualViewport", { value: window.__composerViewport });
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      const pathname = new URL(typeof input === "string" ? input : input.url, location.href).pathname;
      if (!pathname.startsWith("/api/")) return originalFetch(input, options);
      let result = {};
      if (pathname === "/api/auth/status") result = { initialized: true };
      if (pathname === "/api/auth/me") result = { id: "composer-fixture", username: "Fixture" };
      if (pathname === "/api/models") result = [];
      if (pathname === "/api/projects") result = { projects: [], activeProjectId: null };
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
    };
    window.WebSocket = class extends EventTarget {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSED = 3;
      readyState = 0;
      constructor() {
        super();
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.(new Event("open"));
          this.onmessage?.({ data: JSON.stringify({ type: "agents", activeAgentId: "codex", agents: [{ id: "codex", name: "Codex", ready: true }] }) });
          this.onmessage?.({ data: JSON.stringify({ type: "history", messages: [] }) });
        }, 0);
      }
      send() {}
      close() { this.readyState = 3; }
    };
    window.__visibleComposerElement = selector => [...document.querySelectorAll(selector)].find(element => element.getBoundingClientRect().height > 0);
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
      document.addEventListener(type, event => {
        const target = event.target.closest?.("[data-testid]");
        if (target?.dataset.testid !== "composer-actions-toggle") return;
        window.__composerEvents.push({ type, trusted: event.isTrusted, prevented: event.defaultPrevented });
      }, true);
    }
  ` });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const settle = () => evaluate("new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 60))");
  const metrics = () => evaluate(`(() => {
    const visible = window.__visibleComposerElement;
    const rect = element => {
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, height: bounds.height, width: bounds.width };
    };
    const hit = element => {
      const bounds = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
    };
    const input = visible(".composer-input");
    const menu = visible(".actionSheet");
    const toggle = visible('[data-testid="composer-actions-toggle"]');
    return {
      viewport: { height: visualViewport.height, top: visualViewport.offsetTop },
      root: rect(document.querySelector("#app")), app: rect(document.querySelector(".app")),
      detail: rect(visible(".detail")), wrap: rect(visible(".inputWrap")),
      row: rect(visible(".composerMainRow")), input: rect(input),
      expanded: input.parentElement.classList.contains("composerMainRow--expanded"),
      inputDisabled: input.disabled,
      selection: { start: input.selectionStart, end: input.selectionEnd, focused: document.activeElement === input },
      overflow: getComputedStyle(input).overflowY, scrollHeight: input.scrollHeight,
      toggle: { ...rect(toggle), hit: hit(toggle), open: toggle.getAttribute("aria-expanded") },
      tools: [...visible(".composerMainRowRight").querySelectorAll("button")].map(element => ({ ...rect(element), hit: hit(element) })),
      menu: menu ? { ...rect(menu), items: [...menu.querySelectorAll("button")].map(element => ({ ...rect(element), hit: hit(element), disabled: element.disabled })) } : null,
      errors: window.__composerErrors,
    };
  })()`);
  captureState = metrics;
  const tap = async (selector, touch) => {
    const point = await evaluate(`(() => {
      const element = window.__visibleComposerElement(${JSON.stringify(selector)});
      const bounds = element.getBoundingClientRect();
      const pointX = bounds.left + bounds.width / 2, pointY = bounds.top + bounds.height / 2;
      if (!element.contains(document.elementFromPoint(pointX, pointY))) throw new Error("Target is not hit-testable");
      return { x: pointX, y: pointY };
    })()`);
    if (touch) {
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...point, id: 1, radiusX: 1, radiusY: 1, force: 1 }] });
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    }
    await settle();
  };
  const fill = async (text) => {
    await evaluate('(() => { const input = window.__visibleComposerElement(".composer-input"); input.focus(); input.select(); })()');
    if (text) await send("Input.insertText", { text });
    else {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    }
    await settle();
  };
  const toggleSelector = '[data-testid="composer-actions-toggle"]';
  for (const width of [320, 390, 1440]) {
    const touch = width < 900;
    await send("Emulation.setDeviceMetricsOverride", { width, height: 844, mobile: touch, deviceScaleFactor: 1 });
    await send("Emulation.setTouchEmulationEnabled", { enabled: touch });
    await send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, left: 0, right: 0, bottom: touch ? 34 : 0 } });
    await send("Page.navigate", { url: origin });
    await evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const check = () => {
        const input = window.__visibleComposerElement?.(".composer-input");
        if (input && !input.disabled) return resolve(true);
        if (Date.now() > deadline) return reject(new Error("Composer did not become ready"));
        setTimeout(check, 40);
      };
      check();
    })`);
    await settle();
    const initial = await metrics();
    for (const height of touch ? [844, 430, 360, 300] : [844]) {
      if (heightFilter !== null && height !== heightFilter) continue;
      await evaluate(`Object.assign(window.__composerViewport, { height: ${height}, offsetTop: 0 }); window.__composerViewport.dispatchEvent(new Event("resize"));`);
      await settle();
      for (const [state, text] of [
        ["empty", ""], ["short", "Short draft"],
        ["wrapped", "\u6d4b\u8bd5\u8f93\u5165".repeat(Math.ceil(width / 32))],
        ["newlines", "First line\nSecond line\nThird line"],
        ["capped", "Long line of editable text\n".repeat(30)],
      ]) {
        if (stateFilter !== null && state !== stateFilter) continue;
        await fill(text);
        const before = await metrics();
        const record = { width, height, state, before };
        report.cases.push(record);
        assert.equal(before.errors.length, 0, "No browser runtime errors");
        assert.equal(before.toggle.hit, true, "The action trigger must remain hit-testable");
        assert.ok(before.toggle.bottom <= height && before.tools.every(tool => tool.bottom <= height && tool.hit), "All tools must fit the visual viewport");
        const requiredSafeArea = touch && height === 844 ? 34 : 0;
        const gap = height - before.wrap.bottom;
        assert.ok(gap >= requiredSafeArea - 1 && gap <= requiredSafeArea + 8, "The visible border must have only required safe area and <=8px ordinary spacing");
        if (state === "empty" || state === "short") {
          assert.equal(before.expanded, false);
          assert.equal(before.input.height, initial.input.height);
        } else {
          assert.equal(before.expanded, true);
          assert.ok(Math.abs(before.input.width - (before.row.width - 16)) <= 1, "Multiline text must fill the inner row");
          assert.ok(before.input.bottom <= before.toggle.top, "Tools must not cover text");
        }
        if (state === "capped") assert.equal(before.overflow, "auto");
        if (width === 390 && (height === 844 && ["empty", "newlines"].includes(state) || height === 430 && state === "empty")) {
          await captureScreenshot(`${state}-${height}.png`);
        }
        await tap(toggleSelector, touch);
        const opened = await metrics();
        record.opened = opened;
        assert.equal(opened.toggle.open, "true", "One real activation must open the menu");
        assert.ok(opened.menu && opened.menu.top >= opened.detail.top && opened.menu.bottom <= height, "The menu must stay within the usable viewport");
        assert.ok(opened.menu.items.every(item => item.hit && item.top >= opened.menu.top && item.bottom <= opened.menu.bottom), "Every menu item must be hit-testable");
        if (width === 390 && height === 300 && state === "capped") {
          await captureScreenshot("reduced-viewport-menu.png");
        }
        await tap(toggleSelector, touch);
        assert.equal((await metrics()).toggle.open, "false", "The next tap must close, not double-toggle");
      }
    }
    await fill("");
    assert.equal((await metrics()).input.height, initial.input.height, "Delete-all must restore initial height");
    if (heightFilter === null && stateFilter === null) {
      await evaluate('Object.assign(window.__composerViewport, { height: 360, offsetTop: 120 }); window.__composerViewport.dispatchEvent(new Event("scroll"));');
      await settle();
      await fill("Panned draft\n".repeat(20));
      const panned = await metrics();
      assert.equal(panned.root.top, 120);
      assert.equal(panned.root.bottom, 480);
      assert.ok(panned.tools.every(tool => tool.bottom <= 480));
      await tap(toggleSelector, touch);
      assert.ok((await metrics()).menu.items.every(item => item.hit));
      await evaluate('Object.assign(window.__composerViewport, { height: 844, offsetTop: 0 }); window.__composerViewport.dispatchEvent(new Event("resize")); window.dispatchEvent(new Event("pageshow"));');
      await settle();
      assert.equal((await metrics()).root.bottom, 844);
      await tap(toggleSelector, touch);

      await fill("alpha beta");
      for (let index = 0; index < 4; index++) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowLeft", code: "ArrowLeft", modifiers: 8, windowsVirtualKeyCode: 37 });
      }
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft", modifiers: 0, windowsVirtualKeyCode: 37 });
      await settle();
      const selectionBeforeMenu = (await metrics()).selection;
      assert.equal(selectionBeforeMenu.start, 6, "Keyboard selection must begin at the last word");
      assert.equal(selectionBeforeMenu.end, 10);
      await tap(toggleSelector, touch);
      report.cases.push({ width, state: "quote-selection", selectionBeforeMenu, opened: await metrics() });
      await tap('[data-testid="wrap-triple-quotes"]', touch);
      assert.equal(await evaluate('window.__visibleComposerElement(".composer-input").value'), 'alpha """beta"""');
      await tap(toggleSelector, touch);
      const previousChoosers = fileChoosers;
      await tap('[data-testid="action-attach-image"]', touch);
      assert.equal(fileChoosers, previousChoosers + 1, "The menu must preserve native file-picker activation");
      assert.equal((await metrics()).toggle.open, "false");

      await tap(toggleSelector, touch);
      await tap(".chat", touch);
      assert.equal((await metrics()).toggle.open, "false", "Outside pointerdown must dismiss the menu");
      await tap(toggleSelector, touch);
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
      await settle();
      assert.equal((await metrics()).toggle.open, "false");
      await tap(".laneTab:not(.active)", touch);
      await tap(".laneTab:not(.active)", touch);
      assert.equal(await evaluate('window.__visibleComposerElement(".composer-input").value'), 'alpha """beta"""', "Lane switches must preserve the draft");
      await tap(".sendIcon", touch);
      assert.equal(await evaluate('window.__visibleComposerElement(".composer-input").value'), "", "Sending must clear the draft");
      assert.equal((await metrics()).input.height, initial.input.height);
      await tap(toggleSelector, touch);
      await tap('[data-testid="restore-latest-prompt"]', touch);
      assert.equal(await evaluate('window.__visibleComposerElement(".composer-input").value'), 'alpha """beta"""');
      report.cases.push({ width, state: "interaction-and-resume", panned, filePickerOpened: fileChoosers > previousChoosers });
    }
    report.cases.push({ width, events: await evaluate("window.__composerEvents") });
  }
  console.log(JSON.stringify({ status: "passed", cases: report.cases.length, artifacts, environment: report.environment }));
} catch (error) {
  if (captureState) report.failure = await captureState().catch(() => ({ unavailable: true }));
  if (captureScreenshot) await captureScreenshot("failure.png").catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
  socket?.close();
  browser.kill("SIGTERM");
  if (browser.exitCode === null) await once(browser, "exit");
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(error => {
    console.warn(`Temporary browser profile cleanup: ${error.code}`);
  });
  console.log(`Composer browser evidence: ${artifacts}`);
}
