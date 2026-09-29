import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

import { startChatBrowserServer } from "./lib/chat-browser-server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = path.resolve(process.env.ADS_CHAT_BUILD_DIR || path.join(repoRoot, "dist/client"));
const html = await readFile(path.join(buildRoot, "index.html"), "utf8");
const artifacts = await mkdtemp(path.join(tmpdir(), "ads-login-keyboard-"));
const report = {
  environment: "Production app with synthetic visualViewport keyboard resize; not physical phone validation",
  assetPaths: [...html.matchAll(/(?:src|href)="([^"\s]*\/assets\/[^"\s]+)"/g)].map((match) => match[1]),
  cases: [],
};

function readLoginLayout(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, height: box.height };
    };
    const gate = document.querySelector(".gate");
    return {
      gateHeight: getComputedStyle(gate).height,
      gateScrollHeight: gate.scrollHeight,
      gateScrollTop: gate.scrollTop,
      card: rect(".card"),
      password: rect('[data-testid="login-password"]'),
      submit: rect('[data-testid="login-submit"]'),
    };
  });
}

function assertInsideViewport(box, height, label) {
  assert.ok(box, `${label} must exist`);
  assert.ok(box.top >= 0, `${label} top ${box.top} must be >= 0`);
  assert.ok(box.bottom <= height, `${label} bottom ${box.bottom} must be <= ${height}`);
}

async function waitForViewportVar(page, px) {
  await page.waitForFunction(
    (value) => document.documentElement.style.getPropertyValue("--ads-visual-viewport-height") === `${value}px`,
    px,
  );
}

async function installSyntheticViewport(page) {
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), {
      height: window.innerHeight, width: window.innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1,
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    window.setKeyboardViewport = (height, offsetTop = 0, scale = 1) => {
      viewport.height = height;
      viewport.offsetTop = offsetTop;
      viewport.scale = scale;
      viewport.dispatchEvent(new Event("resize"));
    };
  });
}

async function routeAuth(page, { initialized }) {
  await page.route("**/api/auth/*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/status") {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ initialized }) });
    }
    if (url.pathname === "/api/auth/me") {
      return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "unauthorized" }) });
    }
    return route.continue();
  });
}

for (const [engine, browserType] of [["webkit", webkit], ["chromium", chromium]]) {
  const fixture = await startChatBrowserServer(buildRoot);
  let browser;
  try {
    browser = await browserType.launch();

    // Portrait phone: focusing the password field raises the keyboard.
    {
      const result = { engine, scenario: "mobile-keyboard" };
      report.cases.push(result);
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
        isMobile: true, hasTouch: true, serviceWorkers: "block",
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(10000);
      try {
        await routeAuth(page, { initialized: true });
        await installSyntheticViewport(page);
        await page.goto(fixture.origin);
        await page.locator('[data-testid="login-password"]').waitFor();
        // The init script runs before the viewport meta tag applies (980px
        // fallback layout), so sync the synthetic viewport to the real
        // inner height once the page has settled.
        await page.evaluate(() => window.setKeyboardViewport(window.innerHeight));
        await waitForViewportVar(page, 844);

        const baseline = await readLoginLayout(page);
        assertInsideViewport(baseline.password, 844, "baseline password");
        assertInsideViewport(baseline.submit, 844, "baseline submit");

        await page.locator('[data-testid="login-password"]').focus();
        await page.evaluate(() => window.setKeyboardViewport(422));
        await waitForViewportVar(page, 422);
        const keyboard = await readLoginLayout(page);
        result.keyboard = keyboard;
        assert.equal(keyboard.gateHeight, "422px", ".gate must track the visual viewport height");
        assertInsideViewport(keyboard.password, 422, "keyboard password");
        assertInsideViewport(keyboard.submit, 422, "keyboard submit");
        assert.ok(
          keyboard.gateScrollHeight <= 422,
          `card must fit above the keyboard without scrolling (scrollHeight ${keyboard.gateScrollHeight})`,
        );
        await page.screenshot({ path: path.join(artifacts, `${engine}-keyboard-open.png`) });

        await page.evaluate(() => window.setKeyboardViewport(844));
        await waitForViewportVar(page, 844);
        const restored = await readLoginLayout(page);
        result.restored = restored;
        assert.equal(restored.gateHeight, "844px");
        assert.ok(Math.abs(restored.card.top - baseline.card.top) <= 1, "card top must return to the baseline");
        assert.ok(Math.abs(restored.card.bottom - baseline.card.bottom) <= 1, "card bottom must return to the baseline");
        assert.deepEqual(errors, []);
        result.status = "passed";
      } catch (error) {
        result.status = "failed";
        result.error = String(error.stack ?? error);
        await page.screenshot({ path: path.join(artifacts, `${engine}-mobile-failure.png`) }).catch(() => {});
        process.exitCode = 1;
      } finally {
        await page.close();
      }
    }

    // Landscape phone: the compact card must fit the short viewport without scrolling.
    {
      const result = { engine, scenario: "landscape-short-viewport" };
      report.cases.push(result);
      const page = await browser.newPage({
        viewport: { width: 844, height: 390 },
        isMobile: true, hasTouch: true, serviceWorkers: "block",
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(10000);
      try {
        await routeAuth(page, { initialized: true });
        await installSyntheticViewport(page);
        await page.goto(fixture.origin);
        await page.locator('[data-testid="login-password"]').waitFor();
        await page.evaluate(() => window.setKeyboardViewport(window.innerHeight));
        await waitForViewportVar(page, 390);

        const landscape = await readLoginLayout(page);
        result.landscape = landscape;
        assert.equal(landscape.gateHeight, "390px");
        assert.equal(landscape.gateScrollTop, 0);
        assertInsideViewport(landscape.password, 390, "landscape password");
        assertInsideViewport(landscape.submit, 390, "landscape submit");

        // With the landscape keyboard open almost nothing fits; the card must
        // stay reachable through the gate's own scrolling in both directions.
        await page.locator('[data-testid="login-password"]').focus();
        await page.evaluate(() => window.setKeyboardViewport(180));
        await waitForViewportVar(page, 180);
        const reachability = await page.evaluate(() => {
          const gate = document.querySelector(".gate");
          const box = (selector) => {
            const rect = document.querySelector(selector).getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          };
          // Start-aligned when overflowing: nothing is clipped above the
          // scrollport at scrollTop 0 (the old margin: auto centering pushed
          // the card top into unreachable negative space).
          gate.scrollTop = 0;
          const cardAtTop = box(".card");
          document.querySelector('[data-testid="login-username"]').scrollIntoView({ block: "center" });
          const username = box('[data-testid="login-username"]');
          gate.scrollTop = gate.scrollHeight;
          const submitAtBottom = box('[data-testid="login-submit"]');
          return { cardAtTop, username, submitAtBottom, maxScroll: gate.scrollHeight - gate.clientHeight };
        });
        result.reachability = reachability;
        assert.ok(reachability.maxScroll > 0, "gate must scroll when the card overflows");
        assert.ok(reachability.cardAtTop.top >= 0, `card top ${reachability.cardAtTop.top} must not be clipped above the scrollport`);
        assertInsideViewport(reachability.username, 180, "scrolled-into-view username");
        assertInsideViewport(reachability.submitAtBottom, 180, "scrolled-to-bottom submit");

        await page.evaluate(() => window.setKeyboardViewport(390));
        await waitForViewportVar(page, 390);
        const restored = await readLoginLayout(page);
        assertInsideViewport(restored.submit, 390, "restored landscape submit");
        assert.deepEqual(errors, []);
        result.status = "passed";
      } catch (error) {
        result.status = "failed";
        result.error = String(error.stack ?? error);
        await page.screenshot({ path: path.join(artifacts, `${engine}-landscape-failure.png`) }).catch(() => {});
        process.exitCode = 1;
      } finally {
        await page.close();
      }
    }

    // Desktop: layout unchanged, including the not-initialized hint.
    {
      const result = { engine, scenario: "desktop-not-initialized" };
      report.cases.push(result);
      const page = await browser.newPage({ viewport: { width: 1280, height: 844 }, serviceWorkers: "block" });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(10000);
      try {
        await routeAuth(page, { initialized: false });
        await installSyntheticViewport(page);
        await page.goto(fixture.origin);
        const hint = page.locator(".gate .desc code");
        await hint.waitFor();
        assert.ok((await hint.textContent()).includes("npm run web:init-admin"));
        const card = await page.locator(".card").boundingBox();
        assert.ok(card, "card must render");
        assert.ok(Math.abs(card.x + card.width / 2 - 640) <= 1, "card stays horizontally centered");
        assert.ok(Math.abs(card.y + card.height / 2 - 422) <= 1, "card stays vertically centered");
        assert.equal(await page.locator('[data-testid="login-password"]').count(), 0, "no form before initialization");
        assert.deepEqual(errors, []);
        result.status = "passed";
      } catch (error) {
        result.status = "failed";
        result.error = String(error.stack ?? error);
        await page.screenshot({ path: path.join(artifacts, `${engine}-desktop-failure.png`) }).catch(() => {});
        process.exitCode = 1;
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser?.close();
    await fixture.close();
    await writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
  }
}
console.log(JSON.stringify({ artifacts, ...report }, null, 2));
