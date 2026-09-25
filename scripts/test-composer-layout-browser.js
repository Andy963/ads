import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, webkit } from "playwright";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = path.resolve(process.env.ADS_COMPOSER_BUILD_DIR || path.join(repoRoot, "dist/client"));
const html = await readFile(path.join(buildRoot, "index.html"), "utf8");
const assetPaths = [...html.matchAll(/(?:src|href)="([^"\s]*\/assets\/[^"\s]+)"/g)].map((match) => match[1]);
const artifacts = await mkdtemp(path.join(tmpdir(), "ads-composer-layout-"));
const report = {
  environment: "Production bundle in Linux browser engines with synthetic layout faults; not physical iOS PWA validation",
  assetPaths,
  assetHashes: Object.fromEntries(await Promise.all(assetPaths.map(async (asset) => [
    asset, createHash("sha256").update(await readFile(path.join(buildRoot, asset))).digest("hex"),
  ]))),
  cases: [],
};
const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    const asset = path.resolve(buildRoot, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!asset.startsWith(`${buildRoot}${path.sep}`)) throw new Error("Invalid asset path");
    const body = await readFile(asset);
    response.writeHead(200, { "Content-Type": mime[path.extname(asset)] || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;

try {
  for (const [engine, browserType] of [["webkit", webkit], ["chromium", chromium]]) {
    const browser = await browserType.launch({ headless: true });
    const result = { engine, browserVersion: browser.version(), checks: [], errors: [], dialogs: [] };
    report.cases.push(result);
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.fulfill({
          contentType: route.request().resourceType() === "stylesheet" ? "text/css" : "text/plain",
          body: "",
        });
        if (!url.pathname.startsWith("/api/")) return route.continue();
        const fixtures = {
          "/api/auth/status": { initialized: true },
          "/api/auth/me": { id: "layout-fixture", username: "Fixture" },
          "/api/models": [],
          "/api/projects": { projects: [], activeProjectId: null },
        };
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(fixtures[url.pathname] ?? {}) });
      });
      await context.addInitScript(() => {
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
              this.onmessage?.({ data: JSON.stringify({ type: "agents", activeAgentId: "codex", agents: [{ id: "codex", name: "Fixture", ready: true }] }) });
              this.onmessage?.({ data: JSON.stringify({ type: "history", items: [] }) });
            }, 0);
          }
          send() {}
          close() { this.readyState = 3; }
        };
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.on("pageerror", (error) => result.errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") result.errors.push(message.text()); });
      page.on("dialog", async (dialog) => { result.dialogs.push(dialog.message()); await dialog.dismiss(); });
      await page.goto(origin);
      // Both lane panels stay in the DOM on mobile, so scope to the active one.
      const input = page.locator(".lanePanel:not(.lanePanel--inactive) textarea.composer-input:visible");
      await input.waitFor();
      const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

      for (const width of [320, 390, 414]) {
        await page.setViewportSize({ width, height: 430 });
        await input.fill("");
        await input.pressSequentially("A continuously growing draft crosses the soft wrap boundary. ".repeat(3), { delay: 1 });
        await settle();
        assert.equal(await page.locator(".composerMainRow--expanded:visible").count(), 1);
        await input.fill("Short");
        await settle();
        assert.equal(await page.locator(".composerMainRow--expanded:visible").count(), 0);
        result.checks.push({ kind: "incremental-wrap-and-collapse", width });
      }

      await input.fill("");
      for (const width of [320, 390, 414]) {
        await page.setViewportSize({ width, height: 430 });
        await settle();
        const laneSurface = await page.evaluate(() => {
          const rect = (selector) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const box = element.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom, height: box.height, width: box.width };
          };
          const style = (selector) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const computed = getComputedStyle(element);
            return {
              background: computed.backgroundColor,
              borderTopWidth: computed.borderTopWidth,
              borderLeftWidth: computed.borderLeftWidth,
            };
          };
          return {
            surface: rect(".laneTabs"),
            group: rect(".laneTabGroup"),
            tab: rect(".laneTab"),
            divider: rect(".laneControlDivider"),
            controls: rect(".laneModelControls"),
            capsule: rect(".modelCapsule"),
            groupStyle: style(".laneTabGroup"),
            controlsStyle: style(".laneModelControls"),
          };
        });

        for (const key of ["surface", "group", "tab", "divider", "controls", "capsule"]) {
          assert.ok(laneSurface[key], `Lane control surface must render ${key}`);
        }
        const tolerance = 0.6;
        assert.ok(
          Math.abs(laneSurface.tab.height - laneSurface.capsule.height) <= tolerance,
          `Lane tab and model capsule must share one height; got ${laneSurface.tab.height} vs ${laneSurface.capsule.height}`,
        );
        assert.ok(
          Math.abs(laneSurface.tab.top - laneSurface.capsule.top) <= tolerance,
          `Lane tab and model capsule must sit flush; got ${laneSurface.tab.top} vs ${laneSurface.capsule.top}`,
        );
        assert.ok(
          laneSurface.divider.height < laneSurface.surface.height,
          `Lane divider must be a hairline inside the surface; got ${laneSurface.divider.height} in ${laneSurface.surface.height}`,
        );
        assert.equal(laneSurface.groupStyle.background, "rgba(0, 0, 0, 0)", "Lane group must not paint a second surface");
        assert.equal(laneSurface.groupStyle.borderTopWidth, "0px", "Lane group must not paint a second border");
        assert.equal(laneSurface.controlsStyle.background, "rgba(0, 0, 0, 0)", "Model controls must not paint a second surface");
        assert.equal(laneSurface.controlsStyle.borderLeftWidth, "0px", "Model controls must not carry a full-height rule");
        result.checks.push({
          kind: "lane-control-single-surface",
          width,
          tabHeight: laneSurface.tab.height,
          capsuleHeight: laneSurface.capsule.height,
          surfaceHeight: laneSurface.surface.height,
          dividerHeight: laneSurface.divider.height,
        });
      }

      await page.setViewportSize({ width: 390, height: 430 });
      await input.fill("");
      await settle();

      await input.evaluate((element) => {
        window.__layoutLiveReads = 0;
        Object.defineProperty(element, "scrollHeight", {
          configurable: true,
          get() {
            window.__layoutLiveReads += 1;
            // The old implementation loops here. Bound the fault so the test
            // can report failure instead of hanging the browser indefinitely.
            if (window.__layoutLiveReads > 60) return 58;
            return element.closest(".composerMainRow--expanded") ? 34 : 58;
          },
        });
      });
      try {
        await input.fill("A layout-independent measurement must keep this wrapped draft expanded. ".repeat(3));
        await settle();
        const liveReads = await page.evaluate(() => window.__layoutLiveReads);
        assert.ok(liveReads < 20, `Live geometry must not trigger recursive layout updates; read count: ${liveReads}`);
        assert.equal(await page.locator(".composerMainRow--expanded:visible").count(), 1);
        result.checks.push({ kind: "layout-dependent-scroll-height-fault", liveReads });
      } finally {
        await input.evaluate((element) => { delete element.scrollHeight; });
      }

      await input.evaluate((element) => {
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        element.value = "\u4e2d\u6587\u8f93\u5165".repeat(12);
        element.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, inputType: "insertCompositionText" }));
        element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      });
      await settle();
      assert.equal(await page.locator(".composerMainRow--expanded:visible").count(), 1);
      await input.fill("Line\n".repeat(8));
      await settle();
      const geometry = await input.evaluate((element) => {
        const style = getComputedStyle(element);
        const lineHeight = parseFloat(style.lineHeight);
        const verticalPadding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
        const fiveRows = lineHeight * 5 + verticalPadding;

        // Mirror the viewport budget the composer reserves for its own chrome, so
        // the expectation follows the live padding and viewport instead of a
        // frozen pixel count that silently rots on the next styling change.
        const row = element.closest(".composerMainRow");
        const composer = element.closest(".composer");
        const container = element.closest(".detail");
        const bounds = container?.getBoundingClientRect() ?? null;
        let viewportCap = Number.POSITIVE_INFINITY;
        if (row && composer && container && bounds && bounds.height > 0) {
          const chat = container.querySelector(".chat");
          const chatStyle = chat ? getComputedStyle(chat) : null;
          const insets = chatStyle
            ? [chatStyle.paddingTop, chatStyle.paddingBottom, chatStyle.borderTopWidth, chatStyle.borderBottomWidth]
                .reduce((total, value) => total + (parseFloat(value) || 0), 0)
            : 0;
          const chatTop = chat ? chat.getBoundingClientRect().top : bounds.top;
          const available = bounds.bottom - Math.max(bounds.top, chatTop) - insets;
          const rowStyle = getComputedStyle(row);
          const rowPadding = (parseFloat(rowStyle.paddingTop) || 0) + (parseFloat(rowStyle.paddingBottom) || 0);
          const tools = Math.max(
            row.querySelector(".composerMainRowLeft")?.offsetHeight ?? 0,
            row.querySelector(".composerMainRowRight")?.offsetHeight ?? 0,
          );
          const chrome = composer.offsetHeight - row.offsetHeight + rowPadding + tools + (parseFloat(rowStyle.rowGap) || 0);
          viewportCap = Math.max(0, available - chrome);
        }
        return {
          height: element.getBoundingClientRect().height,
          fiveRows,
          expected: Math.ceil(Math.min(fiveRows, viewportCap)),
        };
      });
      // The invariant is "five rows stay available"; the exact pixel count is
      // whatever the current padding and viewport budget allow.
      assert.ok(
        geometry.height + 0.5 >= geometry.fiveRows,
        `Five rows must remain available; box ${geometry.height} cannot show ${geometry.fiveRows}`,
      );
      assert.equal(geometry.height, geometry.expected, "Composer height must equal the viewport-aware five-row cap");
      await input.fill("");
      await settle();
      assert.equal(await page.locator("[data-composer-measure]").count(), 0, "Clearing the draft must release the measurement node");
      result.checks.push({
        kind: "composition-five-rows-and-clear",
        height: geometry.height,
        fiveRows: geometry.fiveRows,
        expected: geometry.expected,
      });
      result.runtimeDiagnostics = await page.evaluate(() => window.__ADS_RUNTIME_DIAGNOSTICS__ ?? []);
      assert.deepEqual(result.errors, []);
      assert.deepEqual(result.runtimeDiagnostics, []);
      result.status = "passed";
      await context.close();
    } finally {
      await browser.close();
    }
  }
  report.status = "passed";
} finally {
  await writeFile(path.join(artifacts, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status ?? "failed", report: path.join(artifacts, "report.json"), cases: report.cases.map(({ engine, status, checks }) => ({ engine, status, checks })) }, null, 2));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
