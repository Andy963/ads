import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { webkit } from "playwright";
import { startChatBrowserServer } from "./lib/chat-browser-server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = path.join(repoRoot, "dist/client");
const profile = await mkdtemp(path.join(tmpdir(), "ads-repro-wrap-"));

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
const dialogs = [];
page.on("pageerror", (error) => errors.push({ kind: "pageerror", text: String(error.message ?? error), stack: String(error.stack ?? "").slice(0, 1200) }));
page.on("console", (message) => {
  if (message.type() === "error") errors.push({ kind: "console", text: message.text().slice(0, 600) });
});
page.on("dialog", async (dialog) => {
  dialogs.push(dialog.message());
  await dialog.dismiss();
});
page.setDefaultTimeout(20000);
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const input = () => page.locator("textarea.composer-input:visible");
const activate = async (selector) => { await page.locator(selector).tap(); await settle(); };
const chooseLane = async (lane) => { await activate(`[data-testid="lane-tab-${lane}"]`); };

await page.goto(fixture.origin);
await page.waitForSelector("textarea:not(:disabled):visible");

// Seed some history so the message list participates in patches.
await chooseLane("worker");
for (let i = 0; i < 6; i += 1) {
  await input().fill(`wrap-seed-${i}`);
  await activate(".sendIcon:visible");
  await page.waitForFunction((marker) => [...document.querySelectorAll(".chat")].find((el) => el.offsetParent !== null)?.textContent.includes(`Worker reply: ${marker}`), `wrap-seed-${i}`);
}
console.log("seeded");

const dumpDialogs = (tag) => {
  const crash = dialogs.filter((d) => /错误\/|CYCLE|SHARED/.test(d));
  if (crash.length) {
    console.log(`!!! ${tag}: ${crash.length} diag dialogs`);
    for (const d of crash.slice(0, 3)) console.log(d.slice(0, 2000), "\n---");
  }
  return crash.length > 0;
};

// Type a long single line character by character, crossing the wrap boundary,
// then keep going to 3+ lines, delete back below the boundary, repeat.
const wrapHammer = async (tag, rounds) => {
  for (let round = 0; round < rounds; round += 1) {
    await input().click();
    await input().fill("");
    const text = `第${round}轮 这是一段会持续变长直到软换行的输入 abcdefghijklmnopqrstuvwxyz0123456789 继续加长到第二行第三行`;
    for (const ch of text) {
      await page.keyboard.type(ch, { delay: 5 });
    }
    await settle();
    for (let i = 0; i < text.length; i += 6) {
      await page.keyboard.press("Backspace", { delay: 2 });
    }
    await settle();
    if (dumpDialogs(`${tag} round ${round}`)) return true;
    if (errors.length) return true;
  }
  return false;
};

let crashed = false;

// Phase A: idle typing across wrap boundary.
crashed ||= await wrapHammer("idle", 8);

// Phase B: typing across wrap while a turn is streaming (busy, stop/send swap, badge toggles).
if (!crashed) {
  const release = fixture.holdReply("browser-worker-wrap-hold");
  await input().fill("browser-worker-wrap-hold");
  await activate(".sendIcon:visible");
  await page.locator(".stopIcon:visible").waitFor();
  crashed ||= await wrapHammer("busy", 8);
  release();
}

// Phase C: wrap typing immediately after lane switches (remount fresh composer).
if (!crashed) {
  for (let i = 0; i < 6 && !crashed; i += 1) {
    await chooseLane("planner");
    await chooseLane("worker");
    crashed ||= await wrapHammer(`lane-${i}`, 3);
  }
}

crashed ||= dumpDialogs("final");
console.log(crashed ? "REPRODUCED" : "no crash reproduced");
console.log("total pageerrors:", errors.length, "dialogs:", dialogs.length);
for (const error of errors.slice(0, 6)) console.log("-", error.kind, error.text.slice(0, 300), error.stack ? `\n  ${error.stack.split("\n").slice(0, 8).join("\n  ")}` : "");

await context.close();
await fixture.close();
process.exit(crashed || errors.length ? 2 : 0);
