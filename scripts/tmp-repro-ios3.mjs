import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { webkit } from "playwright";
import { startChatBrowserServer } from "./lib/chat-browser-server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = path.join(repoRoot, "dist/client");
const profile = await mkdtemp(path.join(tmpdir(), "ads-repro-"));

const fixture = await startChatBrowserServer(buildRoot, { legacyWorker: true, projects: true });
const context = await webkit.launchPersistentContext(profile, {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1,
});
await context.addInitScript(() => {
  const viewport = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, scale: 1 });
  window.__chatViewport = viewport;
  Object.defineProperty(window, "visualViewport", { value: viewport });
  Object.defineProperty(navigator, "standalone", { value: true });
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push({ kind: "pageerror", text: String(error.message ?? error), stack: String(error.stack ?? "").slice(0, 600) }));
page.on("console", (message) => {
  if (message.type() === "error") errors.push({ kind: "console", text: message.text().slice(0, 400) });
});
page.setDefaultTimeout(20000);
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const input = () => page.locator("textarea.composer-input:visible");
const activate = async (selector) => { await page.locator(selector).tap(); await settle(); };
const chooseLane = async (lane) => { await activate(`[data-testid="lane-tab-${lane}"]`); };
const chooseProject = async (name) => {
  await activate('[data-testid="mobile-drawer-toggle"]');
  const row = page.locator("button.projectRow").filter({ hasText: name });
  await row.waitFor({ state: "visible" });
  await row.tap();
  await settle();
};
const typeLikeIme = async (text) => {
  await input().evaluate((element, value) => {
    element.focus();
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    element.value = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, inputType: "insertCompositionText" }));
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  }, text);
  await settle();
};
const send = async (text) => {
  await page.waitForSelector("textarea:not(:disabled):visible");
  await input().fill(text);
  for (let attempt = 0; ; attempt += 1) {
    await activate(".sendIcon:visible");
    await page.waitForTimeout(250);
    if (await input().inputValue() === "") return;
    if (attempt > 40) throw new Error(`send failed for: ${text}`);
  }
};
const dumpErrors = (tag) => {
  const hits = errors.filter((error) => /call stack|is not an Object|not an object|Maximum/i.test(error.text));
  if (hits.length) {
    console.log(`!!! ${tag}: ${hits.length} crash-like errors`);
    for (const hit of hits.slice(0, 4)) console.log(JSON.stringify(hit, null, 2));
    return true;
  }
  return false;
};

await page.goto(`${fixture.origin}/legacy.html`);
await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
fixture.useCurrentServiceWorker();
for (let attempt = 0; ; attempt += 1) {
  try {
    await page.evaluate(async () => {
      window.__previousChatWorker = navigator.serviceWorker.controller;
      await (await navigator.serviceWorker.getRegistration()).update();
    });
    break;
  } catch (error) {
    const probe = await page.evaluate(async () => {
      const res = await fetch("/sw.js", { cache: "no-store" });
      const text = await res.text();
      return { status: res.status, length: text.length, head: text.slice(0, 80) };
    }).catch((fetchError) => ({ fetchError: String(fetchError) }));
    console.log("sw probe:", JSON.stringify(probe));
    if (attempt >= 3) throw error;
    console.log("sw update attempt failed, retrying:", String(error).slice(0, 120));
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
await page.waitForFunction(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller !== window.__previousChatWorker);
await page.goto(fixture.origin);
await page.reload();
await page.waitForSelector("textarea:not(:disabled):visible");

// Seed a long history in BOTH lanes so message windowing (>30) is active.
await chooseLane("advisor");
for (let i = 0; i < 18; i += 1) {
  await send(`browser-advisor-seed-${i}`);
  await page.waitForFunction((marker) => [...document.querySelectorAll(".chat")].find((el) => el.offsetParent !== null)?.textContent.includes(`Advisor reply: ${marker}`), `browser-advisor-seed-${i}`);
}
await chooseLane("worker");
for (let i = 0; i < 18; i += 1) {
  await send(`browser-worker-seed-${i}`);
  await page.waitForFunction((marker) => [...document.querySelectorAll(".chat")].find((el) => el.offsetParent !== null)?.textContent.includes(`Worker reply: ${marker}`), `browser-worker-seed-${i}`);
}
console.log("seeded history");
let crashed = false;

// Phase 1: type with IME simulation while busy (held reply), then switch lanes mid-stream.
await chooseLane("advisor");
const release = fixture.holdReply("browser-advisor-hold-a");
await send("browser-advisor-hold-a");
await page.locator(".stopIcon:visible").waitFor();
await typeLikeIme("打字测试一");
await chooseLane("worker");
await typeLikeIme("worker typing");
await chooseLane("advisor");
await typeLikeIme("继续输入更多中文内容");
crashed ||= dumpErrors("phase1: type during stream + lane switches");
release();

// Phase 2: rapid double lane taps during streaming.
const release2 = fixture.holdReply("browser-advisor-hold-b");
await send("browser-advisor-hold-b");
await page.locator(".stopIcon:visible").waitFor();
await chooseLane("worker");
await chooseLane("advisor");
await chooseLane("worker");
await chooseLane("advisor");
await typeLikeIme("流式期间快速切换后输入");
crashed ||= dumpErrors("phase2: rapid lane taps during stream");
release2();

// Phase 3: project switch mid-stream, type immediately after.
const release3 = fixture.holdReply("browser-advisor-hold-c");
await send("browser-advisor-hold-c");
await page.locator(".stopIcon:visible").waitFor();
await chooseProject("Project B");
await typeLikeIme("项目切换后立即输入");
await chooseLane("worker");
await typeLikeIme("worker lane after project switch");
await chooseProject("Project A");
await typeLikeIme("切回项目后立即输入");
crashed ||= dumpErrors("phase3: project switch during stream + immediate typing");
release3();

// Phase 4: send in worker after all the churn.
try {
  await chooseLane("worker");
  await send("browser-worker-final");
  await page.waitForFunction(() => [...document.querySelectorAll(".chat")].find((el) => el.offsetParent !== null)?.textContent.includes("Worker reply: browser-worker-final"), null, { timeout: 40000 });
} catch (phaseError) {
  console.log("phase4 did not complete:", String(phaseError).split("\n")[0]);
  console.log("visible chat tail:", await page.evaluate(() => [...document.querySelectorAll(".chat")].find((el) => el.offsetParent !== null)?.textContent.slice(-300)));
}

crashed ||= dumpErrors("phase4");
console.log(crashed ? "REPRODUCED" : "no crash reproduced");

// Phase 5: new chat session rotates chatSessionId -> worker panel remounts -> type immediately.
try {
  await chooseLane("worker");
  await activate('[data-testid="mobile-context-menu-toggle"]');
  await activate('[data-testid="mobile-context-action-new-session"]');
  await settle();
  const release5 = fixture.holdReply("browser-worker-hold-e");
  await send("browser-worker-hold-e");
  await page.locator(".stopIcon:visible").waitFor();
  await typeLikeIme("新会话后立即输入中文");
  await chooseLane("advisor");
  await chooseLane("worker");
  await typeLikeIme("继续输入更多内容");
  release5();
  await page.waitForFunction(() => [...document.querySelectorAll(".chat")].find((el) => el.offsetParent !== null)?.textContent.includes("Worker reply: browser-worker-hold-e"), null, { timeout: 40000 });
  crashed ||= dumpErrors("phase5: new session rotation + immediate typing");
} catch (phaseError) {
  console.log("phase5 did not complete:", String(phaseError).split("\n")[0]);
  crashed ||= dumpErrors("phase5(partial)");
}
console.log(crashed ? "REPRODUCED" : "no crash reproduced");
console.log("total errors collected:", errors.length);
for (const error of errors.slice(0, 10)) console.log("-", error.kind, error.text.slice(0, 200));

await context.close();
await fixture.close();
process.exit(crashed ? 2 : 0);
