import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

import { startChatBrowserServer } from "./lib/chat-browser-server.js";
import { verifyExecuteMarquee } from "./lib/chat-browser-marquee.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = path.resolve(process.env.ADS_CHAT_BUILD_DIR || path.join(repoRoot, "dist/client"));
const html = await readFile(path.join(buildRoot, "index.html"), "utf8");
const artifacts = await mkdtemp(path.join(tmpdir(), "ads-execute-marquee-check-"));
const selected = process.env.ADS_CHAT_BROWSER;
assert.ok(!selected || ["webkit", "chromium"].includes(selected), "Unsupported browser engine");
const report = {
  environment: "Isolated full chat with a mock provider and 390px mobile browser viewports; not a physical iOS PWA",
  assetPaths: [...html.matchAll(/(?:src|href)="([^"\s]*\/assets\/[^"\s]+)"/g)].map((match) => match[1]),
  cases: [],
};

for (const engine of selected ? [selected] : ["webkit", "chromium"]) {
  const fixture = await startChatBrowserServer(buildRoot, { projects: true });
  const result = { engine };
  report.cases.push(result);
  let browser;
  let page;
  try {
    browser = await ({ webkit, chromium })[engine].launch();
    const touch = engine === "webkit";
    page = await browser.newPage({
      viewport: { width: 390, height: 844 }, isMobile: touch, hasTouch: touch, serviceWorkers: "block",
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(15000);
    await page.goto(fixture.origin);
    const activate = (locator) => touch ? locator.tap() : locator.click();
    await activate(page.locator('[data-testid="lane-tab-actions"]'));
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-testid="lane-panel-actions"]');
      const track = document.querySelector(".lanePanelsTrack");
      if (!panel || panel.hasAttribute("aria-hidden")) return false;
      return !track || getComputedStyle(track).display === "contents"
        || Math.abs(new DOMMatrixReadOnly(getComputedStyle(track).transform).m41 + track.clientWidth / 2) < 2;
    });
    const panel = page.locator('.lanePanel:not([aria-hidden])');
    const send = async (text) => {
      await panel.locator("textarea.composer-input").fill(text);
      await activate(panel.locator(".sendIcon"));
    };
    const waitForReply = (text) => page.waitForFunction((expected) =>
      document.querySelector('.lanePanel:not([aria-hidden]) .chat')?.textContent.includes(expected), text);
    result.marquee = await verifyExecuteMarquee({ page, fixture, send, waitForReply, artifacts, engine });
    assert.deepEqual(errors, [], "The chat must not report browser runtime errors");
    result.status = "passed";
  } catch (error) {
    result.status = "failed";
    result.error = String(error.stack ?? error);
    result.received = fixture.received;
    if (page) await page.screenshot({ path: path.join(artifacts, `${engine}-failure.png`) }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser?.close();
    await fixture.close();
    await writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
  }
}
console.log(JSON.stringify({ artifacts, ...report }, null, 2));
