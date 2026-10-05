import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, webkit } from "playwright";
import { startChatBrowserServer } from "./lib/chat-browser-server.js";

const artifacts = await mkdtemp(path.join(tmpdir(), "ads-task-notice-"));
const report = {
  environment: "Production App UI; task API fixture; simulated viewports, safe-area padding and reduced-height keyboard layout, not physical iPhone validation",
  cases: [],
};
const longError = "Task cancellation could not be completed. " + "Please inspect the project permissions and try again. ".repeat(8) + "UnbrokenIdentifier".repeat(20);
const intersects = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;

async function geometry(page) {
  return page.evaluate(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width };
    };
    const notice = document.querySelector(".noticeToast");
    const style = getComputedStyle(notice);
    return {
      notice: box(".noticeToast"), topbar: box(".topbar"), lanes: box(".laneTabs"),
      task: box('[data-testid="actions-queue-front"]'), composer: box('[data-testid="lane-panel-actions"] .composer'),
      drawer: box(".left.mobileDrawer"), layout: box(".layout"),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      overflow: notice.scrollWidth > notice.clientWidth + 1,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      position: style.position, opacity: Number(style.opacity), background: style.backgroundColor,
      textOverflow: getComputedStyle(notice.querySelector(".noticeToastText")).textOverflow,
      scrollHeight: notice.scrollHeight, clientHeight: notice.clientHeight, overflowY: style.overflowY,
    };
  });
}

function verify(g, label) {
  assert.ok(g.notice && g.notice.height > 0, `${label}: visible notice`);
  for (const key of ["topbar", "lanes", "task", "composer", "drawer"]) {
    if (g[key]) assert.equal(intersects(g.notice, g[key]), false, `${label}: notice overlaps ${key}: ${JSON.stringify(g)}`);
  }
  assert.ok(g.composer, `${label}: composer geometry must be measured`);
  assert.notEqual(g.position, "fixed", `${label}: notice must reserve layout space`);
  assert.notEqual(g.position, "absolute", `${label}: notice must reserve layout space`);
  assert.ok(g.notice.top >= g.topbar.bottom - 0.5, `${label}: safe-area/header clearance`);
  assert.ok(g.notice.bottom <= g.layout.top + 0.5, `${label}: main layout must start below notice`);
  assert.ok(g.notice.left >= 0 && g.notice.right <= g.viewport.width + 0.5, `${label}: horizontal bounds`);
  assert.ok(g.notice.bottom <= g.viewport.height, `${label}: vertical bounds`);
  assert.equal(g.overflow, false, `${label}: notice horizontal overflow`);
  assert.equal(g.pageOverflow, false, `${label}: page horizontal overflow`);
  assert.equal(g.opacity, 1, `${label}: notice must be fully visible`);
  assert.notEqual(g.textOverflow, "ellipsis", `${label}: long text must not be truncated`);
  assert.match(g.background, /^rgb\(/, `${label}: opaque background`);
  if (g.composer) assert.ok(g.composer.top >= g.notice.bottom && g.composer.bottom <= g.viewport.height + 1, `${label}: composer remains in viewport`);
}

for (const [engine, browserType] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await browserType.launch();
  try {
    for (const width of [1280, 320, 375, 390, 430]) {
      const fixture = await startChatBrowserServer(path.resolve("dist/client"), { settingsApi: true });
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width < 900, hasTouch: width < 900, serviceWorkers: "block" });
      page.setDefaultTimeout(15000);
      const result = { engine, width, measurements: [] };
      report.cases.push(result);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let jobs = [
        { id: "notice-blocked", issue_title: "Review the task and required environment", status: "blocked", issue_id: 522 },
        { id: "notice-queued", issue_title: "Follow-up task remains available", status: "queued", issue_id: 522 },
      ];
      const activate = (locator) => width < 900 ? locator.tap() : locator.click();
      try {
        await page.route("**/api/actions/jobs?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(jobs) }));
        await page.route("**/api/actions/jobs/notice-blocked/resolve", (route) => {
          jobs = jobs.filter((job) => job.id !== "notice-blocked");
          return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "cancelled" }) });
        });
        await page.route("**/api/actions/jobs/notice-queued/cancel", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: longError }) }));
        await page.goto(fixture.origin);
        await activate(page.locator('[data-testid="lane-tab-actions"]'));
        await activate(page.locator('[data-testid="btn-action-resolve-dismiss"]'));
        const notice = page.locator('.noticeToast[role="status"]');
        await notice.waitFor();
        await notice.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
        await page.locator('[data-testid="actions-queue-front"][data-job-id="notice-queued"]').waitFor();
        assert.equal(await notice.getAttribute("aria-live"), "polite");
        const short = await geometry(page);
        verify(short, `${engine}-${width}-dismiss`);
        result.measurements.push({ scenario: "dismiss", ...short });
        await notice.waitFor({ state: "hidden", timeout: 6000 });

        if (width < 900) {
          // Only header safe-area padding and viewport height are simulated;
          // notice DOM and styling are always the production implementation.
          await page.locator(".topbar").evaluate((element) => {
            element.style.height = "calc(var(--topbar-height) + 34px)";
            element.style.paddingTop = "34px";
          });
          await page.setViewportSize({ width, height: 480 });
          await page.locator('[data-testid="lane-panel-actions"] textarea.composer-input').focus();
        }
        await activate(page.locator('[data-testid="btn-action-cancel"]'));
        await notice.filter({ hasText: longError }).waitFor();
        await notice.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
        assert.ok((await notice.textContent()).includes(longError), "Full notice text is retained");
        const long = await geometry(page);
        verify(long, `${engine}-${width}-long`);
        if (width < 900) assert.ok(long.topbar.height >= 70, "Simulated top safe area must actually affect the layout");
        if (long.scrollHeight > long.clientHeight + 1) {
          assert.match(long.overflowY, /auto|scroll/);
          assert.ok(await notice.evaluate((element) => { element.scrollTop = element.scrollHeight; return element.scrollTop > 0; }), "Long text is scrollable rather than clipped");
        }
        result.measurements.push({ scenario: "long-reduced-height", ...long });
        await page.screenshot({ path: path.join(artifacts, `${engine}-${width}-notice.png`) });
        if (width < 900) {
          await activate(page.locator('.mobileMenuBtn'));
          await page.waitForFunction(() => {
            const drawer = document.querySelector(".left.mobileDrawer");
            return drawer && Math.abs(drawer.getBoundingClientRect().left) < 0.5;
          });
          const drawer = await geometry(page);
          verify(drawer, `${engine}-${width}-drawer`);
          assert.ok(drawer.drawer.right > 0 && drawer.drawer.left >= -0.5, "Measure the fully opened drawer, not its offscreen transition");
          result.measurements.push({ scenario: "drawer", ...drawer });
          await activate(page.locator('[data-testid="mobile-drawer-section-models"]'));
          await page.locator(".mobileMainPanel").waitFor();
          const settingsNotice = await notice.boundingBox();
          const settingsPanel = await page.locator(".mobileMainPanel").boundingBox();
          assert.ok(settingsNotice && settingsPanel && settingsNotice.y + settingsNotice.height <= settingsPanel.y + 0.5, "Global notice remains readable above mobile settings");
        }
        if (width === 320) {
          // Keep WebSockets disconnected while HTTP task fixtures remain
          // available, so the real connection-status row occupies space.
          await page.routeWebSocket("**/ws*", (socket) => socket.close());
          await page.goto(fixture.origin);
          await activate(page.locator('[data-testid="lane-tab-actions"]'));
          await page.locator(".topbar").evaluate((element) => {
            element.style.height = "calc(var(--topbar-height) + 34px)";
            element.style.paddingTop = "34px";
          });
          await page.locator('[data-testid="lane-panel-actions"] [data-testid="lane-connection-status"]').waitFor();
          for (const height of [360, 320]) {
            await page.setViewportSize({ width, height });
            const composer = page.locator('[data-testid="lane-panel-actions"] .composer');
            await page.waitForFunction(() => {
              const element = document.querySelector('[data-testid="lane-panel-actions"] .composer');
              return element && element.getBoundingClientRect().bottom <= window.innerHeight + 1;
            });
            const before = await composer.boundingBox();
            assert.ok(before.y + before.height <= height + 1, "Composer fits before the notice");
            await activate(page.locator('[data-testid="btn-action-cancel"]'));
            await notice.filter({ hasText: longError }).waitFor();
            await notice.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
            const compact = await geometry(page);
            verify(compact, `${engine}-${width}x${height}-disconnected`);
            const lineHeight = await notice.evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));
            assert.ok(compact.clientHeight >= lineHeight, "The compact scroll area retains a readable text line");
            result.measurements.push({ scenario: `disconnected-${height}`, ...compact });
            await page.screenshot({ path: path.join(artifacts, `${engine}-${width}x${height}-disconnected.png`) });
            await notice.waitFor({ state: "hidden", timeout: 6000 });
          }
        }
        assert.deepEqual(errors, []);
        result.status = "passed";
      } catch (error) {
        result.status = "failed";
        result.error = String(error.stack ?? error);
        console.error(JSON.stringify({ artifacts, engine, width, status: "failed" }));
        await page.screenshot({ path: path.join(artifacts, `${engine}-${width}-failure.png`) }).catch(() => {});
        throw error;
      } finally {
        await page.close();
        await fixture.close();
        await writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
      }
    }
  } finally { await browser.close(); }
}
console.log(JSON.stringify({ artifacts, cases: report.cases.length, status: "passed" }));
