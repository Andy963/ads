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
        // Fake the microphone so the composer can enter its recording layout
        // without real audio hardware. AudioContext rejects the fake stream and
        // the composer swallows that path on its own. The stub must live on the
        // prototype: WebKit recreates the mediaDevices JS wrapper, so own
        // properties assigned to the instance silently revert to native code.
        class FakeMediaStream {
          getTracks() { return [{ kind: "audio", stop() {} }]; }
          getAudioTracks() { return this.getTracks(); }
        }
        class FakeMediaRecorder extends EventTarget {
          static isTypeSupported() { return true; }
          constructor(stream, options) {
            super();
            this.stream = stream;
            this.mimeType = options?.mimeType ?? "audio/webm";
            this.state = "inactive";
          }
          start() { this.state = "recording"; }
          stop() {
            if (this.state === "inactive") return;
            this.state = "inactive";
            this.onstop?.(new Event("stop"));
          }
        }
        window.MediaRecorder = FakeMediaRecorder;
        const fakeGetUserMedia = () => Promise.resolve(new FakeMediaStream());
        if (navigator.mediaDevices) {
          Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices), "getUserMedia", {
            configurable: true,
            writable: true,
            value: fakeGetUserMedia,
          });
        } else {
          Object.defineProperty(Navigator.prototype, "mediaDevices", {
            configurable: true,
            get: () => ({ getUserMedia: fakeGetUserMedia }),
          });
        }
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

      const idleClusterGap = await page.evaluate(() => {
        const panel = document.querySelector(".lanePanel:not(.lanePanel--inactive)");
        const cluster = panel?.querySelector(".composerMainRowRight");
        return cluster ? getComputedStyle(cluster).gap : null;
      });
      assert.equal(idleClusterGap, "6px", "Idle composer action cluster gap must stay 6px");

      await page.locator(".lanePanel:not(.lanePanel--inactive) [data-testid='composer-mic-btn']:visible").click();
      await page.locator(".lanePanel:not(.lanePanel--inactive) .composerMainRow--recording").waitFor();
      // The capsule eases its border-radius over 0.2s when entering the
      // recording state; wait until the arc reaches the container inner radius.
      await page.waitForFunction(() => {
        const panel = document.querySelector(".lanePanel:not(.lanePanel--inactive)");
        const wrap = panel?.querySelector(".inputWrap");
        const row = panel?.querySelector(".composerMainRow--recording");
        if (!wrap || !row) return false;
        const wrapStyle = getComputedStyle(wrap);
        const target = parseFloat(wrapStyle.borderTopLeftRadius) - parseFloat(wrapStyle.borderTopWidth);
        return Math.abs(parseFloat(getComputedStyle(row).borderTopLeftRadius) - target) <= 0.6;
      });

      for (const width of [320, 390, 414]) {
        await page.setViewportSize({ width, height: 430 });
        await settle();
        const recordingLayout = await page.evaluate(() => {
          const panel = document.querySelector(".lanePanel:not(.lanePanel--inactive)");
          const wrap = panel?.querySelector(".inputWrap");
          const row = panel?.querySelector(".composerMainRow--recording");
          const cluster = panel?.querySelector(".composerMainRowRight");
          const stop = cluster?.querySelector(".voiceStopBtn");
          const adjacent = cluster?.querySelector(".stopIcon") ?? cluster?.querySelector(".sendIcon");
          if (!wrap || !row || !cluster || !stop || !adjacent) return null;
          const wrapStyle = getComputedStyle(wrap);
          const rowStyle = getComputedStyle(row);
          const wrapRect = wrap.getBoundingClientRect();
          const rowRect = row.getBoundingClientRect();
          const stopRect = stop.getBoundingClientRect();
          const adjacentRect = adjacent.getBoundingClientRect();
          return {
            wrapRadius: parseFloat(wrapStyle.borderTopLeftRadius),
            wrapBorder: parseFloat(wrapStyle.borderTopWidth),
            rowRadius: parseFloat(rowStyle.borderTopLeftRadius),
            innerLeft: wrapRect.left + parseFloat(wrapStyle.borderLeftWidth),
            innerRight: wrapRect.right - parseFloat(wrapStyle.borderRightWidth),
            innerTop: wrapRect.top + parseFloat(wrapStyle.borderTopWidth),
            innerBottom: wrapRect.bottom - parseFloat(wrapStyle.borderBottomWidth),
            rowLeft: rowRect.left,
            rowRight: rowRect.right,
            rowTop: rowRect.top,
            rowBottom: rowRect.bottom,
            stopWidth: stopRect.width,
            stopHeight: stopRect.height,
            adjacentWidth: adjacentRect.width,
            adjacentHeight: adjacentRect.height,
            centerDistance: Math.abs(
              adjacentRect.left + adjacentRect.width / 2 - (stopRect.left + stopRect.width / 2),
            ),
          };
        });
        assert.ok(recordingLayout, "Recording capsule layout probes must resolve");
        const tolerance = 0.6;
        assert.ok(
          Math.abs(recordingLayout.rowRadius - (recordingLayout.wrapRadius - recordingLayout.wrapBorder)) <= tolerance,
          `Recording capsule radius must track the container inner radius; got ${recordingLayout.rowRadius} vs ${recordingLayout.wrapRadius - recordingLayout.wrapBorder}`,
        );
        for (const [edge, actual, limit, direction] of [
          ["left", recordingLayout.rowLeft, recordingLayout.innerLeft, -1],
          ["right", recordingLayout.rowRight, recordingLayout.innerRight, 1],
          ["top", recordingLayout.rowTop, recordingLayout.innerTop, -1],
          ["bottom", recordingLayout.rowBottom, recordingLayout.innerBottom, 1],
        ]) {
          assert.ok(
            direction * (limit - actual) >= -tolerance,
            `Recording capsule ${edge} edge must stay inside the container border; got ${actual} vs inner ${limit}`,
          );
        }
        for (const [label, size] of [["stop", recordingLayout.stopWidth], ["stop", recordingLayout.stopHeight], ["adjacent", recordingLayout.adjacentWidth], ["adjacent", recordingLayout.adjacentHeight]]) {
          assert.ok(Math.abs(size - 34) <= tolerance, `Recording ${label} button must stay 34px; got ${size}`);
        }
        assert.ok(
          recordingLayout.centerDistance >= 48 - tolerance,
          `Recording actions must sit at least 48px center-to-center; got ${recordingLayout.centerDistance}`,
        );
        result.checks.push({
          kind: "recording-capsule-tangency",
          width,
          rowRadius: recordingLayout.rowRadius,
          centerDistance: recordingLayout.centerDistance,
        });
      }

      await page.locator(".lanePanel:not(.lanePanel--inactive) [data-testid='voice-cancel-btn']:visible").click();
      await settle();
      assert.equal(await page.locator(".composerMainRow--recording:visible").count(), 0, "Cancelling must leave the recording layout");

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
      // --- Queued prompt card first-line flow (issue-455) -------------------
      // A WebSocket stub that never opens keeps the client offline, so every
      // submitted prompt stays in the local queue and renders as a queue card.
      const queueContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
      await queueContext.route("**/*", async (route) => {
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
      await queueContext.addInitScript(() => {
        window.WebSocket = class extends EventTarget {
          static OPEN = 1;
          static CONNECTING = 0;
          static CLOSED = 3;
          readyState = 0;
          send() {}
          close() { this.readyState = 3; }
        };
      });
      const queuePage = await queueContext.newPage();
      queuePage.setDefaultTimeout(15000);
      queuePage.on("pageerror", (error) => result.errors.push(`queue: ${error.message}`));
      queuePage.on("console", (message) => { if (message.type() === "error") result.errors.push(`queue: ${message.text()}`); });
      await queuePage.goto(origin);
      const queueInput = queuePage.locator(".lanePanel:not(.lanePanel--inactive) textarea.composer-input:visible");
      await queueInput.waitFor();
      const queueSend = queuePage.locator(".lanePanel:not(.lanePanel--inactive) [data-testid='composer-send-btn']:visible");
      const queueItems = queuePage.locator(".lanePanel:not(.lanePanel--inactive) .queue-item");
      const queueSettle = () => queuePage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const enqueue = async (text) => {
        await queueInput.fill(text);
        await queueSend.click();
      };
      const queueFixtures = [
        {
          key: "explicit-newlines",
          text: [
            "First line flows between the ordinal badge and the close control without reserved side columns",
            // Short filler words keep the wrap gap small, so a full line ends
            // within ~13px of the right inset at every viewport width.
            `Second line reclaims the full card width below the close control ${"an ".repeat(60).trim()}`,
            "Third line does exactly the same",
            "Fourth line stays reachable by scrolling inside the card",
          ].join("\n"),
        },
        // No hyphens: anywhere-breaking fills each line to within ~7px of the
        // right inset instead of breaking early at a hyphen opportunity.
        { key: "natural-wrap-url", text: `Wrapped prompt with a long unbroken URL https://example.com/${"a".repeat(220)} and some trailing words` },
        { key: "cjk-mixed", text: "排队消息混排 CJK 与 Latin 字符，验证换行几何在两种文字下都成立。".repeat(6) },
        { key: "one-line", text: "Short queued prompt" },
      ];
      for (const fixture of queueFixtures) await enqueue(fixture.text);
      // Wider ordinal badges: pad the queue up to #10, then to #100.
      for (let index = queueFixtures.length + 1; index <= 10; index += 1) await enqueue(`Filler queued prompt ${index}`);
      const badgeTen = 9;
      for (let index = 11; index <= 100; index += 1) await enqueue(`Filler queued prompt ${index}`);
      await queueSettle();
      assert.equal(await queueItems.count(), 100, "All queued prompts must render as cards");

      const measureQueues = () => queuePage.evaluate(() => {
        const panel = document.querySelector(".lanePanel:not(.lanePanel--inactive)");
        return [...panel.querySelectorAll(".queue-item")].map((item, index) => {
          const itemStyle = getComputedStyle(item);
          const itemRect = item.getBoundingClientRect();
          const badgeRect = item.querySelector(".queue-badge").getBoundingClientRect();
          // Pre-fix cards have no controls cluster; fall back to the remove
          // button so the geometry assertions report a clean failure.
          const controlsRect = (item.querySelector(".queue-controls") ?? item.querySelector(".queue-action--remove")).getBoundingClientRect();
          const textElement = item.querySelector(".queue-text");
          const range = document.createRange();
          range.selectNodeContents(textElement);
          // getClientRects splits one visual line into a main rect plus tiny
          // trailing fragments (whitespace/newline runs); merge fragments that
          // share a line band into one geometry per rendered line.
          const fragments = [...range.getClientRects()].filter((rect) => rect.height > 0.5 && rect.width > 0.5);
          const bands = [];
          for (const fragment of fragments) {
            const band = bands.find((entry) => entry.top < fragment.bottom - 0.5 && entry.bottom > fragment.top + 0.5);
            if (band) {
              band.left = Math.min(band.left, fragment.left);
              band.right = Math.max(band.right, fragment.right);
              band.top = Math.min(band.top, fragment.top);
              band.bottom = Math.max(band.bottom, fragment.bottom);
            } else {
              bands.push({ left: fragment.left, right: fragment.right, top: fragment.top, bottom: fragment.bottom });
            }
          }
          const lines = bands.sort((a, b) => a.top - b.top);
          const pick = (rect) => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
          return {
            index,
            badgeText: item.querySelector(".queue-badge").textContent,
            contentLeft: itemRect.left + parseFloat(itemStyle.borderLeftWidth) + parseFloat(itemStyle.paddingLeft),
            contentRight: itemRect.right - parseFloat(itemStyle.borderRightWidth) - parseFloat(itemStyle.paddingRight),
            lineHeight: parseFloat(getComputedStyle(textElement).lineHeight),
            badge: pick(badgeRect),
            controls: pick(controlsRect),
            lines,
            clientHeight: item.clientHeight,
            scrollHeight: item.scrollHeight,
          };
        });
      });
      const intersects = (a, b, tolerance = 0.5) =>
        a.left < b.right - tolerance && a.right > b.left + tolerance && a.top < b.bottom - tolerance && a.bottom > b.top + tolerance;

      for (const width of [320, 375, 390, 430, 1280]) {
        await queuePage.setViewportSize({ width, height: 844 });
        await queueSettle();
        const measured = await measureQueues();
        assert.equal(measured.length, 100);
        const tolerance = 1.5;
        for (const card of measured) {
          const label = `card #${card.index + 1} @${width}px`;
          assert.ok(card.lines.length >= 1, `${label} must render at least one text line`);
          const [first] = card.lines;
          // The ordinal badge excludes text only on the first line.
          assert.ok(
            first.left >= card.badge.right - tolerance,
            `${label} first line must start after the badge; got left ${first.left} vs badge right ${card.badge.right}`,
          );
          // The close control shares the first line; text must not cross it.
          const controlsOnFirstLine = card.controls.top < first.bottom - tolerance;
          if (controlsOnFirstLine) {
            assert.ok(
              first.right <= card.controls.left + tolerance,
              `${label} first line must stop before the controls; got right ${first.right} vs controls left ${card.controls.left}`,
            );
          }
          for (const line of card.lines) {
            assert.ok(!intersects(line, card.badge), `${label} text must not intersect the badge hit area`);
            assert.ok(!intersects(line, card.controls), `${label} text must not intersect the control hit area`);
          }
          // Later lines reclaim the left inset: no permanent side column below
          // the badge. (A line can still END early — explicit newlines and
          // unbroken tokens prefer the last normal break opportunity — so the
          // right-edge reclaim is asserted per fixture below with texts whose
          // wrap gap is smaller than the control strip.)
          for (const line of card.lines.slice(1)) {
            assert.ok(
              line.left <= card.contentLeft + tolerance,
              `${label} later lines must start at the card left inset; got ${line.left} vs ${card.contentLeft}`,
            );
          }
        }
        // Multi-line fixtures keep a three-line viewport, scroll the rest, and
        // run at least one later line through the horizontal space below the
        // controls — impossible while a full-height side column reserves it.
        for (const fixtureIndex of [0, 1, 2]) {
          const card = measured[fixtureIndex];
          const label = `fixture ${queueFixtures[fixtureIndex].key} @${width}px`;
          const laterLines = card.lines.slice(1);
          assert.ok(laterLines.length >= 2, `${label} must wrap to at least three lines; got ${card.lines.length}`);
          assert.ok(
            laterLines.some((line) => line.right > card.controls.left + tolerance),
            `${label} later lines must extend through the space below the controls; rights ${laterLines.map((line) => line.right.toFixed(1)).join(",")} vs controls left ${card.controls.left}`,
          );
          const viewportCap = Math.ceil(card.lineHeight * 3 + 16) + 2;
          assert.ok(
            card.clientHeight <= viewportCap,
            `${label} must clip to the three-line viewport; got ${card.clientHeight} > ${viewportCap}`,
          );
          assert.ok(
            card.scrollHeight > card.clientHeight + 1,
            `${label} must keep longer content scrollable inside the card`,
          );
        }
        assert.equal(measured[3].lines.length, 1, `one-line fixture @${width}px must stay on a single line`);
        assert.equal(measured[badgeTen].badgeText, "#10", `tenth card @${width}px must carry the #10 badge`);
        assert.equal(measured[99].badgeText, "#100", `hundredth card @${width}px must carry the #100 badge`);
        result.checks.push({ kind: "queue-first-line-flow", width });
      }

      // Cards scroll their own overflow without moving the composer.
      const scrollProbe = await queuePage.evaluate(() => {
        const item = document.querySelector(".lanePanel:not(.lanePanel--inactive) .queue-item");
        const composer = item.closest(".composer");
        const before = composer.getBoundingClientRect().top;
        item.scrollTop = 40;
        return { scrolled: item.scrollTop > 0, composerShift: Math.abs(composer.getBoundingClientRect().top - before) };
      });
      assert.ok(scrollProbe.scrolled, "Queue card must scroll its overflow internally");
      assert.equal(scrollProbe.composerShift, 0, "Scrolling a queue card must not move the composer");
      result.checks.push({ kind: "queue-card-internal-scroll" });
      await queueContext.close();

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
