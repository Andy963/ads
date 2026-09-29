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
const artifacts = await mkdtemp(path.join(tmpdir(), "ads-lane-control-"));
const report = {
  environment: "Production app served by the chat fixture server; simulated viewports, not physical phone validation",
  assetPaths: [...html.matchAll(/(?:src|href)="([^"\s]*\/assets\/[^"\s]+)"/g)].map((match) => match[1]),
  cases: [],
};

// The capsule label is a user-editable alias, so exercise the cap with a long
// one; its modelId must match the fixture session's initial "browser-model".
const LONG_ALIAS = "Extremely Long User-Renamed Model Alias For Balance Checks";
const MOBILE_WIDTHS = [320, 375, 390, 430];

async function routeModels(page) {
  await page.route("**/api/models", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        { id: "m1", modelId: "browser-model", displayName: LONG_ALIAS, provider: "openai", isEnabled: true, isDefault: true },
      ]),
    }),
  );
}

async function openChat(page, origin) {
  await routeModels(page);
  await page.goto(origin);
  await page.locator('[data-testid="chat-control-surface"]').waitFor();
  await page.waitForFunction(
    (alias) => document.querySelector('[data-testid="chat-capsule-text"]')?.textContent?.includes(alias),
    LONG_ALIAS,
  );
  await page.waitForSelector("textarea.composer-input:not(:disabled)");
}

function readSurface(page) {
  return page.evaluate(() => {
    const box = (el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, width: rect.width, right: rect.right };
    };
    const tabs = [...document.querySelectorAll(".laneTab")].map((tab) => {
      const style = getComputedStyle(tab);
      const label = tab.querySelector(".laneTabLabel");
      return {
        id: tab.getAttribute("data-testid"),
        ...box(tab),
        paddingLeft: Number.parseFloat(style.paddingLeft),
        active: tab.classList.contains("active"),
        labelClipped: label.scrollWidth > label.clientWidth + 0.5,
      };
    });
    const capsule = document.querySelector(".modelCapsule");
    const capsuleText = document.querySelector('[data-testid="chat-capsule-text"]');
    const group = document.querySelector(".laneTabGroup");
    const pillStyle = getComputedStyle(group, "::before");
    const groupRect = group.getBoundingClientRect();
    const pillMatrix = new DOMMatrixReadOnly(pillStyle.transform);
    const pill = pillStyle.content === "none"
      ? null
      : { left: groupRect.left + pillMatrix.m41, width: Number.parseFloat(pillStyle.width) };
    return {
      viewport: window.innerWidth,
      surface: box(document.querySelector('[data-testid="chat-control-surface"]')),
      tabs,
      capsule: {
        ...box(capsule),
        maxWidth: getComputedStyle(capsule).maxWidth,
        textTruncated: capsuleText.scrollWidth > capsuleText.clientWidth + 0.5,
      },
      pill,
    };
  });
}

function readDots(page) {
  return page.evaluate(() => {
    const read = (testid) => {
      const dot = document.querySelector(`[data-testid="${testid}"]`);
      const style = getComputedStyle(dot);
      const matrix = new DOMMatrixReadOnly(style.transform);
      const ring = /rgba\([\d.]+,\s*[\d.]+,\s*[\d.]+,\s*([\d.]+)\)\s+[\d.-]+px\s+[\d.-]+px\s+[\d.-]+px\s+([\d.-]+)px/.exec(style.boxShadow);
      return {
        animation: style.animationName,
        scale: style.transform === "none" ? 1 : matrix.a,
        ringAlpha: ring ? Number(ring[1]) : null,
        ringSpread: ring ? Number(ring[2]) : null,
        background: style.backgroundColor,
      };
    };
    return { busy: read("lane-tab-status-acopilot"), idle: read("lane-tab-status-actions") };
  });
}

async function sampleDots(page, { durationMs = 1900, intervalMs = 90 } = {}) {
  const samples = [];
  const start = Date.now();
  while (Date.now() - start < durationMs) {
    samples.push(await readDots(page));
    await page.waitForTimeout(intervalMs);
  }
  return samples;
}

async function sendHeldAdvisorPrompt(page, fixture, marker) {
  const release = fixture.holdReply(marker);
  const panel = page.locator('.lanePanel:not([aria-hidden])');
  await panel.locator("textarea.composer-input").fill(marker);
  await panel.locator(".sendIcon").click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="lane-tab-status-acopilot"]')?.classList.contains("laneTabStatusDot--busy-acopilot"));
  return release;
}

async function activateLane(page, lane, mobile) {
  const tab = page.locator(`[data-testid="lane-tab-${lane}"]`);
  if (mobile) await tab.tap();
  else await tab.click();
  await page.waitForFunction((expected) =>
    document.querySelector(`[data-testid="lane-tab-${expected}"]`)?.classList.contains("active"), lane);
}

function assertPulseSamples(samples, label) {
  const busyScales = samples.map((sample) => sample.busy.scale);
  const peakScale = Math.max(...busyScales);
  const troughScale = Math.min(...busyScales);
  assert.ok(
    samples.every((sample) => sample.busy.animation.startsWith("laneDotPulse")),
    `${label}: busy dot must keep the pulse animation, got ${JSON.stringify(samples.map((sample) => sample.busy.animation))}`,
  );
  assert.ok(peakScale >= 1.4, `${label}: pulse peak scale ${peakScale} must reach >= 1.4`);
  assert.ok(peakScale - troughScale >= 0.35, `${label}: pulse amplitude ${peakScale - troughScale} must exceed 0.35`);
  assert.ok(
    samples.some((sample) => sample.busy.ringAlpha >= 0.4 && sample.busy.ringSpread >= 5),
    `${label}: pulse ring must reach alpha >= 0.4 at >= 5px spread, peaks ${JSON.stringify(samples.map((sample) => [sample.busy.ringAlpha, sample.busy.ringSpread]))}`,
  );
  assert.ok(
    samples.every((sample) => sample.idle.animation === "none" && sample.idle.scale === 1),
    `${label}: the idle lane dot must not animate`,
  );
  return { peakScale, troughScale };
}

for (const [engine, browserType] of [["chromium", chromium], ["webkit", webkit]]) {
  const fixture = await startChatBrowserServer(buildRoot);
  let browser;
  try {
    browser = await browserType.launch();

    // Desktop: the capsule cap binds and the model segment stays in line with
    // a single lane tab even with a maximally long user alias.
    {
      const result = { engine, scenario: "desktop-1280" };
      report.cases.push(result);
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
      page.setDefaultTimeout(15000);
      try {
        await openChat(page, fixture.origin);
        await activateLane(page, "acopilot", false);
        const surface = await readSurface(page);
        result.surface = surface;
        assert.equal(surface.viewport, 1280);
        assert.ok(surface.capsule.width <= 141, `capsule width ${surface.capsule.width} must not exceed ~140px`);
        assert.ok(surface.capsule.textTruncated, "the long alias must be ellipsized inside the capped capsule");
        const widestTab = Math.max(...surface.tabs.map((tab) => tab.width));
        assert.ok(
          surface.capsule.width <= widestTab * 1.5,
          `capsule ${surface.capsule.width} must not be markedly wider than a tab ${widestTab}`,
        );
        assert.ok(
          surface.tabs.every((tab) => tab.paddingLeft === 18),
          `desktop tabs must use 18px horizontal padding, got ${JSON.stringify(surface.tabs.map((tab) => tab.paddingLeft))}`,
        );
        assert.ok(surface.surface.right <= 1280, "the control surface must fit the viewport");
        await page.screenshot({ path: path.join(artifacts, `${engine}-desktop-1280.png`) });
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

    // Phones: wider tabs with no label truncation, the sliding pill lands on
    // the active tab, and the busy pulse is clearly perceivable.
    for (const width of MOBILE_WIDTHS) {
      const result = { engine, scenario: `mobile-${width}` };
      report.cases.push(result);
      const page = await browser.newPage({
        viewport: { width, height: 740 },
        isMobile: true,
        hasTouch: true,
        serviceWorkers: "block",
      });
      page.setDefaultTimeout(15000);
      try {
        await openChat(page, fixture.origin);
        await activateLane(page, "acopilot", true);
        const surface = await readSurface(page);
        result.surface = surface;
        assert.equal(surface.viewport, width);
        assert.ok(
          surface.tabs.every((tab) => tab.paddingLeft === 14),
          `mobile tabs must use 14px horizontal padding, got ${JSON.stringify(surface.tabs.map((tab) => tab.paddingLeft))}`,
        );
        assert.ok(
          surface.tabs.every((tab) => !tab.labelClipped),
          `tab labels must not truncate at ${width}px`,
        );
        assert.ok(surface.surface.right <= width + 1, "the control surface must fit the viewport");

        const assertPillOnActiveTab = (reading, label) => {
          const activeTab = reading.tabs.find((tab) => tab.active);
          assert.ok(activeTab, `${label}: an active tab must exist`);
          assert.ok(reading.pill, `${label}: the sliding pill must render on mobile`);
          assert.ok(
            Math.abs(reading.pill.left - activeTab.left) <= 1 && Math.abs(reading.pill.width - activeTab.width) <= 1,
            `${label}: pill {left ${reading.pill.left}, width ${reading.pill.width}} must cover the active tab {left ${activeTab.left}, width ${activeTab.width}}`,
          );
        };
        assertPillOnActiveTab(surface, `mobile-${width} acopilot`);
        await activateLane(page, "actions", true);
        await page.waitForFunction(() => {
          const group = document.querySelector(".laneTabGroup");
          const active = document.querySelector(".laneTab.active");
          if (!group || !active) return false;
          const matrix = new DOMMatrixReadOnly(getComputedStyle(group, "::before").transform);
          return Math.abs(group.getBoundingClientRect().left + matrix.m41 - active.getBoundingClientRect().left) <= 1;
        });
        assertPillOnActiveTab(await readSurface(page), `mobile-${width} actions`);
        await activateLane(page, "acopilot", true);

        const release = await sendHeldAdvisorPrompt(page, fixture, `browser-advisor-pulse-${width}`);
        try {
          const samples = await sampleDots(page);
          result.pulse = { samples: samples.length, ...assertPulseSamples(samples, `mobile-${width}`) };
        } finally {
          release();
        }
        await page.waitForFunction((marker) =>
          document.querySelector('.lanePanel:not([aria-hidden]) .chat')?.textContent.includes(`Advisor reply: ${marker}`),
        `browser-advisor-pulse-${width}`);
        await page.screenshot({ path: path.join(artifacts, `${engine}-mobile-${width}.png`) });
        result.status = "passed";
      } catch (error) {
        result.status = "failed";
        result.error = String(error.stack ?? error);
        await page.screenshot({ path: path.join(artifacts, `${engine}-mobile-${width}-failure.png`) }).catch(() => {});
        process.exitCode = 1;
      } finally {
        await page.close();
      }
    }

    // OS reduce-motion: the busy dot degrades to a steady, clearly visible
    // indicator instead of losing its animation to the global suppression.
    {
      const result = { engine, scenario: "reduced-motion-375" };
      report.cases.push(result);
      const context = await browser.newContext({
        viewport: { width: 375, height: 740 },
        isMobile: true,
        hasTouch: true,
        reducedMotion: "reduce",
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      try {
        await openChat(page, fixture.origin);
        await activateLane(page, "acopilot", true);
        const release = await sendHeldAdvisorPrompt(page, fixture, "browser-advisor-pulse-reduced");
        try {
          const samples = await sampleDots(page, { durationMs: 1000 });
          result.reducedMotion = samples.at(-1);
          assert.ok(
            samples.every((sample) => sample.busy.animation === "none"),
            "reduce-motion must disable the pulse animation outright",
          );
          const scales = samples.map((sample) => sample.busy.scale);
          assert.ok(
            scales.every((scale) => Math.abs(scale - 1.3) <= 0.05),
            `reduce-motion busy dot must stay a steady enlarged indicator, got scales ${JSON.stringify(scales)}`,
          );
          assert.ok(
            samples.every((sample) => sample.busy.ringAlpha >= 0.5 && sample.busy.ringSpread >= 3),
            `reduce-motion busy dot must keep a strong ring, got ${JSON.stringify(samples.map((sample) => [sample.busy.ringAlpha, sample.busy.ringSpread]))}`,
          );
          assert.equal(samples.at(-1).busy.background, "rgb(168, 85, 247)", "the busy lane color must survive reduce-motion");
          assert.ok(
            samples.every((sample) => sample.idle.animation === "none"),
            "the idle lane dot must stay static under reduce-motion",
          );
        } finally {
          release();
        }
        await page.screenshot({ path: path.join(artifacts, `${engine}-reduced-motion-375.png`) });
        result.status = "passed";
      } catch (error) {
        result.status = "failed";
        result.error = String(error.stack ?? error);
        await page.screenshot({ path: path.join(artifacts, `${engine}-reduced-motion-failure.png`) }).catch(() => {});
        process.exitCode = 1;
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
await writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ artifacts, ...report }, null, 2));
