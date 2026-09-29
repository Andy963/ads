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
const artifacts = await mkdtemp(path.join(tmpdir(), "ads-role-prompt-keyboard-"));
const report = {
  environment: "Production app with synthetic visualViewport keyboard resize and 47px top safe area; not physical phone validation",
  assetPaths: [...html.matchAll(/(?:src|href)="([^"\s]*\/assets\/[^"\s]+)"/g)].map((match) => match[1]),
  cases: [],
};
const prompt = Array.from({ length: 40 }, (_, index) => `Instruction line ${index + 1}`).join("\n");
const profile = { id: "acopilot", role: "acopilot", system_prompt: prompt, model_id: "browser-model", reasoning_effort: "high" };

function readEditorLayout(panel) {
  return panel.evaluate((element) => {
    const editor = element.querySelector("textarea");
    const actions = element.querySelector(".lanePromptActions");
    const style = getComputedStyle(editor);
    const editorRect = editor.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    return {
      minHeight: style.minHeight, flex: style.flex, fontSize: style.fontSize, lineHeight: style.lineHeight,
      visibleLines: Math.floor((editor.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight)),
      editorTop: editorRect.top, editorBottom: editorRect.bottom,
      actionsTop: actionsRect.top, actionsBottom: actionsRect.bottom,
      actionBottomOffset: getComputedStyle(actions).bottom,
    };
  });
}

for (const [engine, browserType] of [["webkit", webkit], ["chromium", chromium]]) {
  const fixture = await startChatBrowserServer(buildRoot);
  let browser;
  try {
    browser = await browserType.launch();
    for (const mobile of [true, false]) {
      const result = { engine, mobile };
      report.cases.push(result);
      const page = await browser.newPage({
        viewport: { width: mobile ? 390 : 1280, height: 844 },
        isMobile: mobile, hasTouch: mobile, serviceWorkers: "block",
      });
      const errors = [];
      const savedPrompts = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(10000);
      try {
        await page.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== fixture.origin) return route.fulfill({ body: "" });
          if (url.pathname === "/api/role-profiles/acopilot" && route.request().method() === "PUT") {
            const { system_prompt: savedPrompt } = route.request().postDataJSON();
            assert.deepEqual(Object.keys(route.request().postDataJSON()), ["system_prompt"], "Instruction saves must not resubmit model or effort");
            savedPrompts.push(savedPrompt);
            return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...profile, ...route.request().postDataJSON() }) });
          }
          const fixtures = {
            "/api/model-configs": [],
            "/api/models": [{ id: "m1", modelId: "browser-model", displayName: "Browser model", provider: "openai", isEnabled: true, isDefault: true }],
            "/api/model-providers": [],
            "/api/role-profiles": [profile],
          };
          if (!(url.pathname in fixtures)) return route.continue();
          return route.fulfill({ contentType: "application/json", body: JSON.stringify(fixtures[url.pathname]) });
        });
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
        await page.goto(fixture.origin);
        // The mobile layout viewport is wider until the document's viewport
        // meta tag loads. Initialize the synthetic viewport from the ready page.
        await page.evaluate(() => window.setKeyboardViewport(window.innerHeight));
        if (mobile) {
          await page.locator('[data-testid="mobile-drawer-toggle"]').tap();
          await page.locator('[data-testid="mobile-drawer-section-prompts"]').tap();
          // Headless engines have zero safe-area insets. Reserve the real-device
          // topbar budget explicitly, without altering the panel under test.
          await page.locator(".topbar").evaluate((element) => {
            element.style.height = "87px";
            element.style.paddingTop = "47px";
          });
        } else {
          await page.locator('[data-testid="settings-open"]').click();
        }
        const panel = page.locator('[data-testid="lane-prompt-panel"]');
        const editor = panel.locator("textarea");
        await editor.waitFor();
        const auxiliary = [".roleControlsBar"];
        for (const selector of auxiliary) assert.equal(await panel.locator(selector).isVisible(), true, selector);
        const baseline = await editor.evaluate((element) => ({
          minHeight: getComputedStyle(element).minHeight, height: element.getBoundingClientRect().height,
        }));
        result.baseline = baseline;
        assert.ok(baseline.height <= 844, "The editor must fit the initial viewport");
        await editor.focus();
        if (mobile) {
          await page.evaluate(() => window.setKeyboardViewport(422, 0, 2));
          await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--ads-visual-viewport-height") === "422px");
          assert.equal(await page.locator(".lanePromptPanel--keyboard-open").count(), 0, "Zoom alone is not a keyboard");
          await page.evaluate(() => window.setKeyboardViewport(237.5, 0, 2));
          await page.waitForFunction(() => document.querySelector(".lanePromptPanel--keyboard-open"));
        }
        await page.evaluate(() => window.setKeyboardViewport(475));
        await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--ads-visual-viewport-height") === "475px");
        if (mobile) {
          await page.waitForFunction(() => document.querySelector(".lanePromptPanel--keyboard-open"));
          for (const selector of auxiliary) assert.equal(await panel.locator(selector).isVisible(), false, selector);
          assert.equal(await panel.locator(".lanePromptLaneSelector").isVisible(), true);
          result.keyboard = await readEditorLayout(panel);
          assert.equal(result.keyboard.minHeight, "0px");
          assert.equal(result.keyboard.flex, "1 1 auto");
          assert.ok(result.keyboard.visibleLines >= 10, JSON.stringify(result.keyboard));
          assert.ok(result.keyboard.editorBottom <= result.keyboard.actionsTop, "Actions must not cover the editor");
          assert.ok(result.keyboard.actionsBottom <= 475, "Actions must remain above the keyboard");
          assert.equal(result.keyboard.actionBottomOffset, "0px");
          await editor.evaluate((element) => element.setSelectionRange(element.value.length, element.value.length));
          await editor.press("ArrowLeft");
          await page.waitForFunction(() => {
            const editor = document.querySelector(".lanePromptTextarea");
            return editor.scrollTop + editor.clientHeight >= editor.scrollHeight - 24;
          });
          await editor.press("End");
          await editor.press("x");
          assert.equal((await editor.inputValue()).endsWith("40x"), true, "The last line must remain editable");
          await page.screenshot({ path: path.join(artifacts, `${engine}-keyboard.png`) });

          const saveRequest = page.waitForRequest((request) => request.url().endsWith("/api/role-profiles/acopilot") && request.method() === "PUT");
          await panel.locator('[data-testid="lane-prompt-save"]').tap();
          await saveRequest;
          await panel.locator('[data-testid="lane-prompt-status"]').waitFor();
          assert.equal(savedPrompts.length, 1, "One tap must save exactly once despite the focus/layout transition");
          assert.equal(savedPrompts[0], `${prompt}x`);
          await editor.focus();
          await page.waitForFunction(() => document.querySelector(".lanePromptPanel--keyboard-open"));
          result.afterSave = await readEditorLayout(panel);
          assert.ok(result.afterSave.visibleLines >= 10, JSON.stringify(result.afterSave));
          assert.ok(result.afterSave.editorBottom <= result.afterSave.actionsTop, "Save feedback must not obscure editing");

          await page.evaluate(() => window.setKeyboardViewport(420, 20));
          await page.waitForFunction(() => {
            const editor = document.querySelector(".lanePromptTextarea").getBoundingClientRect();
            const actions = document.querySelector(".lanePromptActions").getBoundingClientRect();
            return editor.bottom <= actions.top && actions.bottom <= 440;
          });
          await page.evaluate(() => window.setKeyboardViewport(844));
          await page.waitForFunction(() => !document.querySelector(".lanePromptPanel--keyboard-open"));
          assert.equal(await editor.evaluate((element) => document.activeElement === element), true);
          for (const selector of auxiliary) assert.equal(await panel.locator(selector).isVisible(), true, selector);
          assert.equal(await panel.locator('[data-testid="lane-prompt-status"]').isVisible(), true);
          assert.equal(await editor.evaluate((element) => getComputedStyle(element).minHeight), baseline.minHeight);

          await page.evaluate(() => window.setKeyboardViewport(475));
          await page.waitForFunction(() => document.querySelector(".lanePromptPanel--keyboard-open"));
          await editor.evaluate((element) => element.blur());
          await page.waitForFunction(() => !document.querySelector(".lanePromptPanel--keyboard-open"));
          for (const selector of auxiliary) assert.equal(await panel.locator(selector).isVisible(), true, selector);

          await page.evaluate(() => window.setKeyboardViewport(844));
          await page.locator('[data-testid="mobile-drawer-toggle"]').tap();
          await page.locator('[data-testid="mobile-drawer-section-models"]').tap();
          await page.locator('[data-testid="settings-providers-panel"]').waitFor();
          assert.equal(await page.locator(".lanePromptPanel--keyboard-open").count(), 0);
        } else {
          assert.equal(await page.locator(".lanePromptPanel--keyboard-open").count(), 0);
          for (const selector of auxiliary) assert.equal(await panel.locator(selector).isVisible(), true, selector);
          assert.deepEqual(await editor.evaluate((element) => ({
            minHeight: getComputedStyle(element).minHeight, height: element.getBoundingClientRect().height,
          })), baseline);
        }
        assert.deepEqual(errors, []);
        result.status = "passed";
      } catch (error) {
        result.status = "failed";
        result.error = String(error.stack ?? error);
        await page.screenshot({ path: path.join(artifacts, `${engine}-${mobile}-failure.png`) }).catch(() => {});
        process.exitCode = 1;
      } finally {
        await page.close();
        await writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
      }
    }
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
console.log(JSON.stringify({ artifacts, ...report }, null, 2));
