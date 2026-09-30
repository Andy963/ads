import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, webkit } from "playwright";
import { startChatBrowserServer } from "./lib/chat-browser-server.js";

const artifacts = await mkdtemp(path.join(tmpdir(), "ads-model-settings-"));
const report = [];

async function assertInsideScrollport(scroller, target) {
  const bounds = await scroller.boundingBox();
  const rect = await target.boundingBox();
  assert.ok(bounds && rect);
  assert.ok(rect.y >= bounds.y - 1 && rect.y + rect.height <= bounds.y + bounds.height + 1,
    "The target must be visible inside the scrollport, not just present in the DOM");
  const viewport = scroller.page().viewportSize();
  assert.ok(rect.y >= 0 && rect.y + rect.height <= viewport.height + 1, "Content must not be clipped by the viewport");
}

async function assertScrollable(scroller, lastControl, desktop) {
  const metrics = await scroller.evaluate(element => {
    const style = getComputedStyle(element);
    return { height: element.clientHeight, content: element.scrollHeight,
      gutter: element.offsetWidth - element.clientWidth, overflow: style.overflowY,
      overscroll: style.overscrollBehaviorY, width: style.scrollbarWidth,
      color: style.scrollbarColor, stable: style.scrollbarGutter,
      fallbackWidth: getComputedStyle(element, "::-webkit-scrollbar").width,
      thumb: getComputedStyle(element, "::-webkit-scrollbar-thumb").backgroundColor,
      track: getComputedStyle(element, "::-webkit-scrollbar-track").backgroundColor };
  });
  assert.ok(metrics.height > 0 && metrics.content > metrics.height, "Fixture must overflow a bounded scrollport");
  assert.equal(metrics.overflow, "auto");
  assert.equal(metrics.overscroll, "contain");
  if (desktop) {
    assert.equal(metrics.width, "thin");
    assert.equal(metrics.stable, "stable");
    assert.equal(metrics.color, "rgba(148, 163, 184, 0.75) rgba(148, 163, 184, 0.12)");
    assert.equal(metrics.fallbackWidth, "8px");
    assert.equal(metrics.thumb, "rgba(148, 163, 184, 0.75)");
    assert.equal(metrics.track, "rgba(148, 163, 184, 0.12)");
    // Headless WebKit uses overlay scrollbars even with a stable gutter.
    if (scroller.page().context().browser().browserType().name() === "chromium") {
      assert.ok(metrics.gutter > 0, "Classic desktop scrollbars must reserve visible space");
    }
    await scroller.evaluate(element => { element.scrollTop = 0; });
    const bounds = await scroller.boundingBox();
    await scroller.page().mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await scroller.page().mouse.wheel(0, 180);
    await scroller.page().waitForFunction(element => element.scrollTop > 0, await scroller.elementHandle());
  } else {
    assert.equal(metrics.width, "auto", "Mobile must retain native scrollbar styling");
    assert.equal(metrics.stable, "auto");
  }
  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const remaining = await scroller.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
  assert.ok(Math.abs(remaining) <= 1, "The scrollport must reach its real bottom");
  await assertInsideScrollport(scroller, lastControl);
  return metrics;
}

for (const [engine, type] of [["chromium", chromium], ["webkit", webkit]]) {
  const fixture = await startChatBrowserServer(path.resolve("dist/client"));
  // Chromium otherwise hides scrollbar painting in headless screenshots.
  const browser = await type.launch(engine === "chromium" ? { ignoreDefaultArgs: ["--hide-scrollbars"] } : {});
  try {
    for (const [width, height] of [[320, 844], [390, 844], [1280, 844], [1280, 560]]) {
      const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 900, hasTouch: width < 900, serviceWorkers: "block" });
      page.setDefaultTimeout(10000);
      const provider = { id: "p1", name: "Fixture Provider", baseUrl: "https://fixture.invalid/v1", isEnabled: true, hasCredential: true };
      const models = Array.from({ length: 32 }, (_, i) => i + 1).map(index => ({ id: "m" + index, modelId: "browser-model" + index, providerId: "p1", provider: provider.name,
        displayName: "Fixture model " + index, isEnabled: true, isDefault: index === 1 }));
      models.push({ id: "legacy-model", modelId: "legacy-upstream", providerId: null, provider: "openai", displayName: "Legacy model", isEnabled: true, isDefault: false });
      const selections = ["conversation", "transcription", "correction"].map(service => ({ service, modelIds: ["m1", "m2"], defaultModelId: "m1" }));
      const calls = [];
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(() => {
        const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, width: window.innerWidth, offsetTop: 0, offsetLeft: 0, scale: 1 });
        Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
        window.setKeyboardViewport = (height, offsetTop = 0) => { viewport.height = height; viewport.offsetTop = offsetTop; viewport.dispatchEvent(new Event("resize")); };
      });
      await page.route("**/api/**", async route => {
        const url = new URL(route.request().url());
        const method = route.request().method();
        const reply = body => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
        if (method !== "GET") calls.push({ path: url.pathname, query: url.search, method, body: route.request().postDataJSON() });
        if (url.pathname === "/api/model-providers") return reply([provider]);
        if (url.pathname === "/api/model-configs" || url.pathname === "/api/models") return reply(models);
        if (url.pathname === "/api/model-services") return reply(selections);
        if (url.pathname === "/api/role-profiles") return reply([]);
        if (url.pathname === "/api/model-providers/p1" && method === "PATCH") { Object.assign(provider, route.request().postDataJSON()); return reply(provider); }
        if (url.pathname === "/api/model-providers/p1/models/sync") return reply({ ok: true, models });
        if (url.pathname === "/api/model-configs/legacy-model" && method === "DELETE") { models.splice(models.findIndex(model => model.id === "legacy-model"), 1); return reply({ success: true }); }
        if (url.pathname.startsWith("/api/model-services/") && method === "PUT") {
          const selection = selections.find(item => url.pathname.endsWith("/" + item.service));
          Object.assign(selection, route.request().postDataJSON());
          return reply(selection);
        }
        if (url.pathname === "/api/voice/settings") return reply({ configured: true, hasApiKey: true, correctionHasApiKey: true, source: "saved", config: {
          enabled: true, transcription: { provider: provider.name, providerId: "p1", baseUrl: provider.baseUrl, model: "asr", language: "en", prompt: "", timeoutMs: 120000 },
          correction: { enabled: false, provider: provider.name, providerId: "p1", baseUrl: provider.baseUrl, model: "correct", systemPrompt: "Fix spelling.", reasoningEffort: "high", timeoutMs: 15000 }, totalTimeoutMs: 135000,
        } });
        return route.continue();
      });
      const result = { engine, width, height };
      const screenshotPrefix = engine + "-" + width + "x" + height;
      report.push(result);
      try {
        await page.goto(fixture.origin);
        // Account initialization closes transient navigation; wait for it before opening settings.
        await page.locator('[data-testid="chat-model-capsule"]:not(:disabled)').waitFor();
        await page.evaluate(() => window.setKeyboardViewport(window.innerHeight));
        if (width < 900) {
          await page.locator('[data-testid="mobile-drawer-toggle"]').tap();
          await page.waitForFunction(() => {
            const drawer = document.querySelector('[data-testid="mobile-drawer"]');
            return drawer && Math.abs(drawer.getBoundingClientRect().left) < 1;
          });
          await page.locator('[data-testid="mobile-drawer-section-models"]').tap();
        } else {
          await page.locator('[data-testid="settings-open"]').click();
          await page.locator('[data-testid="settings-tab-models"]').click();
        }
        const edit = page.locator('[data-testid="provider-edit-p1"]');
        await edit.waitFor();
        result.managerScroll = await assertScrollable(page.locator(".settingsBody"), page.locator('[data-testid="model-row-legacy-model"]'), width > 900);
        if (width < 900) {
          result.density = await page.locator(".settingsBody").evaluate(element => ({
            titleSize: parseFloat(getComputedStyle(element.querySelector("h1")).fontSize),
            paddingTop: parseFloat(getComputedStyle(element).paddingTop),
            paddingLeft: parseFloat(getComputedStyle(element).paddingLeft),
            sectionMargin: parseFloat(getComputedStyle(element.querySelector(".settingsBlock")).marginTop),
          }));
          assert.ok(result.density.titleSize <= 22);
          assert.ok(result.density.paddingTop <= 8 && result.density.paddingLeft <= 12);
          assert.ok(result.density.sectionMargin <= 12);
        }
        assert.equal(await edit.isVisible(), true);
        await edit.click();
        const sheet = page.locator('[data-testid="provider-dialog"]');
        if (height === 560) {
          result.providerScroll = await assertScrollable(sheet.locator(".sheetBody"), sheet.getByRole("button", { name: "Delete provider", exact: true }), true);
        }
        assert.equal(await sheet.evaluate(element => element.matches(":modal")), true, "Editor must be a modal dialog, not a div under the app toolbar");
        assert.equal(await page.locator('[data-testid="provider-base-url"]').inputValue(), provider.baseUrl);
        assert.equal(await page.locator('[data-testid="provider-api-key"]').inputValue(), "");
        assert.equal(await page.locator('[data-testid="provider-name"]').evaluate(element => document.activeElement === element), false, "Opening the editor must not force the keyboard open");
        await page.screenshot({ path: path.join(artifacts, screenshotPrefix + "-editor.png") });
        await page.locator('[data-testid="provider-name"]').fill("Unsaved provider");
        await sheet.press("Escape");
        assert.equal(await sheet.locator('[data-testid="sheet-discard"]').isVisible(), true);
        await sheet.locator('[data-testid="sheet-cancel"]').click();
        assert.equal(await page.locator('[data-testid="provider-name"]').inputValue(), "Unsaved provider");
        await sheet.locator('[data-testid="sheet-cancel"]').click();
        await sheet.locator('[data-testid="sheet-discard"]').click();
        await sheet.waitFor({ state: "hidden" });
        assert.equal(provider.name, "Fixture Provider", "Discard must not persist the draft");
        assert.equal(await page.locator('[data-testid="model-manager"]').isVisible(), true);
        await edit.click();
        await page.locator('[data-testid="provider-name"]').fill("Updated Provider");
        if (width < 900) {
          await page.evaluate(() => window.setKeyboardViewport(430, 20));
          await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--ads-visual-viewport-height") === "430px");
          const nav = await sheet.locator(".sheetNavigation").boundingBox();
          assert.ok(nav.y >= 20 && nav.y + nav.height <= 450, "Done and Cancel must remain above the keyboard");
          assert.ok(await page.locator('[data-testid="provider-name"]').evaluate(element => parseFloat(getComputedStyle(element).fontSize)) >= 16);
          result.keyboardScroll = await assertScrollable(sheet.locator(".sheetBody"), sheet.getByRole("button", { name: "Delete provider", exact: true }), false);
          await page.screenshot({ path: path.join(artifacts, screenshotPrefix + "-keyboard.png") });
          await page.evaluate(() => window.setKeyboardViewport(844));
        }
        await page.locator('[data-testid="provider-save"]').click();
        await page.locator('[data-testid="provider-dialog"]').waitFor({ state: "hidden" });
        assert.equal(provider.name, "Updated Provider");
        await page.locator('[data-testid="provider-actions-p1"]').click();
        await page.locator('[data-testid="provider-sync-p1"]').click();
        await page.waitForFunction(() => document.querySelector('[data-testid="model-manager"] [role="status"]')?.textContent.includes("synchronized"));
        assert.ok(calls.some(call => call.path === "/api/model-providers/p1/models/sync"));
        await page.screenshot({ path: path.join(artifacts, screenshotPrefix + "-providers.png") });
        await page.locator('[data-testid="model-row-legacy-model"]').click();
        await page.getByRole("button", { name: "Delete model", exact: true }).click();
        const deletion = page.locator('[data-testid="settings-delete-confirm"]');
        assert.equal(calls.some(call => call.method === "DELETE"), false, "Delete must require confirmation");
        await deletion.getByRole("button", { name: "Delete", exact: true }).click();
        await page.locator('[data-testid="model-row-legacy-model"]').waitFor({ state: "hidden" });
        assert.ok(calls.some(call => call.method === "DELETE" && call.query === "?removeReferences=true"));
        for (const [mode, selector] of [["edit", "model-row-m1"], ["add", "provider-add-model-p1"]]) {
          await page.locator('[data-testid="' + selector + '"]').click();
          const modelSheet = page.locator('[data-testid="model-manager-dialog"]');
          await modelSheet.locator(".modelAdvanced summary").click();
          const body = modelSheet.locator(".sheetBody");
          const lastControl = mode === "edit" ? modelSheet.getByRole("button", { name: "Delete model", exact: true }) : modelSheet.locator('[data-testid="model-manager-config-json"]');
          result[mode + "ModelScroll"] = await assertScrollable(body, lastControl, width > 900);
          for (const id of ["max-input-tokens", "max-output-tokens", "config-json"]) {
            const field = modelSheet.locator('[data-testid="model-manager-' + id + '"]');
            await field.scrollIntoViewIfNeeded();
            await assertInsideScrollport(body, field);
          }
          await page.screenshot({ path: path.join(artifacts, screenshotPrefix + "-" + mode + "-model.png") });
          await modelSheet.locator('[data-testid="sheet-cancel"]').click();
          await modelSheet.waitFor({ state: "hidden" });
        }
        await page.locator('[data-testid="provider-add"]').click();
        if (height === 560) {
          result.addProviderScroll = await assertScrollable(sheet.locator(".sheetBody"), sheet.locator('[data-testid="provider-enabled"]'), true);
        }
        await sheet.locator('[data-testid="sheet-cancel"]').click();
        await sheet.waitFor({ state: "hidden" });
        for (const [tab, service] of [["conversation", "conversation"], ["voice", "transcription"], ["correction", "correction"]]) {
          await page.locator('[data-testid="' + tab + '-settings-tab"]').click();
          const picker = page.locator('[data-testid="service-models-' + service + '"]');
          await picker.locator('[data-testid="service-default-open"]').click();
          await page.locator('[data-testid="service-default-m2"]').locator("..").click();
          await page.locator('[data-testid="service-default-picker"]').waitFor({ state: "hidden" });
          assert.equal(selections.find(item => item.service === service).defaultModelId, "m2");
          assert.equal(await picker.locator('input[type="checkbox"]:checked').count(), 2);
          assert.equal(await picker.locator('input[type="radio"]').count(), 0, "Default selection and enable switches must be separate controls");
          assert.equal(await picker.locator('[data-testid="service-models-save"]').count(), 0, "Switches save automatically");
          assert.equal(await page.locator('input[type="password"]').count(), 0);
        }
        await page.screenshot({ path: path.join(artifacts, screenshotPrefix + "-service.png") });
        await page.locator('[data-testid="voice-options-open"]').click();
        await page.locator('[data-testid="correction-system-prompt"]').fill("An unsaved correction draft");
        const options = page.locator('[data-testid="voice-options-sheet"]');
        await options.locator('[data-testid="sheet-cancel"]').click();
        await options.locator('[data-testid="sheet-discard"]').click();
        await options.waitFor({ state: "hidden" });
        assert.equal(calls.some(call => call.path === "/api/voice/correction"), false);
        if (width < 900) {
          const tabs = await page.locator(".settingsDestinations").boundingBox();
          assert.ok(tabs.y > 720 && tabs.y + tabs.height <= 844, "iOS tab bar stays at the bottom");
          assert.ok(await page.locator(".settingsDestinations button").evaluateAll(buttons => buttons.every(button => button.getBoundingClientRect().height >= 44)));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
        }
        assert.deepEqual(errors, []);
        result.status = "passed";
      } catch (error) {
        result.status = "failed";
        result.error = String(error.stack || error);
        await page.screenshot({ path: path.join(artifacts, screenshotPrefix + "-failure.png") });
        process.exitCode = 1;
      } finally { await page.close(); }
    }
  } finally { await browser.close(); await fixture.close(); }
}
await writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ artifacts, report }, null, 2));
