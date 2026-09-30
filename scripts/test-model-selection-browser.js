import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, webkit } from "playwright";

import { startChatBrowserServer } from "./lib/chat-browser-server.js";
import { getStateDatabase } from "../dist/server/state/database.js";
import { createGlobalModelConfigStore } from "../dist/server/state/globalModelConfigStore.js";
import { createModelServiceStore } from "../dist/server/state/modelServiceStore.js";

const buildRoot = path.resolve(process.env.ADS_CHAT_BUILD_DIR || "dist/client");
const artifacts = await mkdtemp(path.join(tmpdir(), "ads-model-selection-"));
const report = { environment: "Real settings HTTP routes and WebSocket controls with temporary SQLite; simulated viewports, not physical iPhone validation", cases: [] };

async function swipeRole(locator, dx, dy = 0, cancel = false) {
  // WebKit has no Playwright touch-drag API; dispatch the DOM touch sequence
  // against the real component, keeping native scrolling a separate check.
  await locator.evaluate((element, { dx, dy, cancel }) => {
    const rect = element.getBoundingClientRect();
    const touch = (x, y) => ({ identifier: 1, clientX: x, clientY: y, target: element });
    const x = rect.left + rect.width / 2;
    const y = rect.top + Math.min(rect.height / 2, 16);
    for (const [type, points, changed] of [
      ["touchstart", [touch(x, y)], [touch(x, y)]],
      ["touchmove", [touch(x + dx, y + dy)], [touch(x + dx, y + dy)]],
      [cancel ? "touchcancel" : "touchend", [], [touch(x + dx, y + dy)]],
    ]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(event, { touches: points, changedTouches: changed });
      element.dispatchEvent(event);
    }
  }, { dx, dy, cancel });
}

for (const [engine, browserType] of [["webkit", webkit], ["chromium", chromium]]) {
  const browser = await browserType.launch();
  try {
    for (const width of [320, 390, 1280]) {
      const fixture = await startChatBrowserServer(buildRoot, { settingsApi: true });
      const db = getStateDatabase(fixture.statePath);
      const models = createGlobalModelConfigStore(db);
      models.upsertModelConfig({ ...models.getModelConfig("m1"), configJson: { reasoningEfforts: ["max", "medium", "high"] } });
      models.upsertModelConfig({ id: "m2", modelId: "second-model", displayName: "Second model alias", provider: "openai", isEnabled: true, isDefault: false });
      createModelServiceStore(db).save("conversation", ["m1", "m2"], "m1");
      const result = { engine, width };
      report.cases.push(result);
      db.prepare("UPDATE role_profiles SET model_id = ?, system_prompt = ?, reasoning_effort = ? WHERE role = ?")
        .run("browser-model", "Saved instructions", "high", "developer");
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width < 900, hasTouch: width < 900, serviceWorkers: "block" });
      page.setDefaultTimeout(10000);
      const errors = [];
      const overrides = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("websocket", socket => socket.on("framesent", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "model_override") overrides.push(message);
      }));
      try {
        await page.goto(fixture.origin);
        await page.locator('[data-testid="chat-model-capsule"]:not(:disabled)').waitFor();
        await page.locator('.lanePanel:not([aria-hidden]) textarea.composer-input').fill("Review the latest changes");
        await page.screenshot({ path: path.join(artifacts, `${engine}-${width}-main.png`) });
        await page.locator('[data-testid="chat-model-capsule"]').click();
        const sheet = page.locator('[data-testid="model-picker-sheet"]');
        await sheet.waitFor();
        assert.equal(await sheet.evaluate(element => element.matches("dialog:modal")), true);
        assert.equal(await sheet.evaluate(element => getComputedStyle(element).fontFamily === getComputedStyle(document.querySelector(".app")).fontFamily), true);
        const slider = sheet.locator('input[type="range"]');
        assert.equal(await slider.getAttribute("max"), "2");
        assert.deepEqual(await sheet.locator("[data-effort]").evaluateAll(elements => elements.map(element => element.dataset.effort)), ["medium", "high", "max"]);
        assert.equal(await slider.getAttribute("aria-valuetext"), "High");
        const prior = overrides.length;
        const bounds = await slider.boundingBox();
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.down();
        await page.mouse.move(bounds.x + bounds.width - 14, bounds.y + bounds.height / 2, { steps: 8 });
        assert.equal(await slider.getAttribute("aria-valuetext"), "Max");
        assert.equal(overrides.length, prior, "Dragging must not send intermediate overrides");
        await page.mouse.up();
        await page.waitForFunction(() => document.querySelector('[data-testid="chat-capsule-effort"]')?.textContent === "Max");
        await page.waitForFunction(() => document.querySelector('[data-testid="reasoning-effort-slider"]')?.value === "2");
        assert.equal(overrides.length, prior + 1);
        assert.equal(overrides.at(-1).payload.model_reasoning_effort, "max");
        await slider.press("ArrowLeft");
        await page.waitForFunction(() => document.querySelector('[data-testid="chat-capsule-effort"]')?.textContent === "High");
        await sheet.locator('[data-testid="model-picker-item-m2"]').click();
        await page.waitForFunction(() => document.querySelector('[data-testid="chat-capsule-text"]')?.textContent === "Second model alias");
        assert.equal(await slider.getAttribute("max"), "1");
        assert.equal(await sheet.evaluate(element => element.scrollWidth <= element.clientWidth), true);
        await page.screenshot({ path: path.join(artifacts, `${engine}-${width}-chat-picker.png`) });
        await sheet.locator('[data-testid="sheet-cancel"]').click();
        assert.equal(await page.locator('[data-testid="chat-model-capsule"]').evaluate(element => document.activeElement === element), true);

        if (width < 900) {
          await page.locator('[data-testid="mobile-drawer-toggle"]').click();
          const drawer = page.locator('[data-testid="mobile-drawer"]');
          await page.waitForFunction(() => {
            const drawer = document.querySelector('[data-testid="mobile-drawer"]');
            return drawer && Math.abs(drawer.getBoundingClientRect().left) < 1;
          });
          assert.equal(await drawer.evaluate(element => getComputedStyle(element).backgroundColor), "rgb(242, 242, 247)");
          assert.equal(await drawer.locator(".mobileDrawerNav").evaluate(element => getComputedStyle(element).borderRadius), "12px");
          result.drawerNavigation = [];
          for (const height of [844, 568]) {
            await page.setViewportSize({ width, height });
            const rows = await drawer.locator(".mobileDrawerNavItem").evaluateAll(elements => elements.map(element => {
              const box = element.getBoundingClientRect();
              const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
              return {
                height: box.height,
                top: box.top,
                bottom: box.bottom,
                reachable: element === hit || element.contains(hit),
                fits: element.scrollWidth <= element.clientWidth,
              };
            }));
            assert.equal(rows.length, 3);
            for (const [index, row] of rows.entries()) {
              assert.ok(row.height >= (height > 600 ? 56 : 48), "Primary navigation needs comfortable row heights, including on short screens");
              assert.ok(row.reachable && row.fits, "Every navigation row must remain reachable without horizontal overflow");
              assert.ok(row.top >= 0 && row.bottom <= height, "All navigation rows must fit in the viewport");
              if (index > 0) assert.ok(row.top >= rows[index - 1].bottom, "Navigation rows must not overlap");
            }
            result.drawerNavigation.push({ viewportHeight: height, rows });
            await page.screenshot({ path: path.join(artifacts, `${engine}-${width}-${height}-drawer.png`) });
          }
          await page.setViewportSize({ width, height: 844 });
          await page.screenshot({ path: path.join(artifacts, `${engine}-${width}-drawer.png`) });
          await page.locator('[data-testid="mobile-drawer-section-prompts"]').click();
        } else await page.locator('[data-testid="settings-open"]').click();
        const panel = page.locator('[data-testid="lane-prompt-panel"]');
        await panel.locator('[data-testid="lane-prompt-lane-actions"]').click();
        const editor = panel.locator("textarea");
        await editor.fill("Unsaved instructions");
        if (width < 900) {
          const bar = panel.locator(".lanePromptLaneSelector");
          result.roleBarHeight = (await bar.boundingBox()).height;
          assert.ok(result.roleBarHeight <= 36, "Role navigation should remain compact");
          await swipeRole(bar, -90);
          await page.waitForFunction(() => document.querySelector('.lanePromptLane[aria-pressed="true"]')?.textContent === "Reviewer");
          await swipeRole(bar, 90);
          await page.waitForFunction(() => document.querySelector('.lanePromptLane[aria-pressed="true"]')?.textContent === "Developer");
          assert.equal(await editor.inputValue(), "Unsaved instructions");
          for (const gesture of [[10, 90], [-90, 0, true]]) {
            await swipeRole(bar, ...gesture);
            assert.equal(await bar.locator('[aria-pressed="true"]').textContent(), "Developer");
          }
          await swipeRole(editor, -90);
          assert.equal(await bar.locator('[aria-pressed="true"]').textContent(), "Developer");
          assert.equal(fixture.requests.filter(request => request.method === "PUT" && request.pathname.startsWith("/api/role-profiles")).length, 0);
          if (engine === "chromium") {
            const session = await page.context().newCDPSession(page);
            const box = await bar.boundingBox();
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            for (const direction of [-1, 1]) {
              await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
              for (const offset of [20, 45, 90]) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + direction * offset, y }] });
              await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
              await page.waitForFunction(role => document.querySelector('.lanePromptLane[aria-pressed="true"]')?.textContent === role, direction < 0 ? "Reviewer" : "Developer");
            }
            await session.detach();
            assert.equal(await editor.inputValue(), "Unsaved instructions");
          }
        }
        assert.equal(await panel.evaluate(element => element.querySelector("textarea").compareDocumentPosition(element.querySelector('[data-testid="role-model-select"]')) & Node.DOCUMENT_POSITION_FOLLOWING ? true : false), true);
        if (width < 900) await panel.locator('[data-testid="role-model-select"]').tap();
        else await panel.locator('[data-testid="role-model-select"]').click();
        const roleSheet = page.locator('[data-testid="role-selection-sheet"]');
        assert.equal(await roleSheet.locator('[data-testid="role-model-m1"]').getAttribute("aria-pressed"), "true");
        await roleSheet.locator('[data-testid="role-model-m1"]').click();
        await roleSheet.waitFor({ state: "detached" });
        let record = db.prepare("SELECT model_id, system_prompt FROM role_profiles WHERE role = ?").get("developer");
        assert.deepEqual(record, { model_id: "m1", system_prompt: "Saved instructions" });
        assert.equal(await editor.inputValue(), "Unsaved instructions");
        await panel.locator('[data-testid="role-model-select"]').click();
        await page.route("**/api/role-profiles/profile-default-developer", route => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Model temporarily unavailable" }) }), { times: 1 });
        await roleSheet.locator('[data-testid="role-model-m2"]').click();
        await roleSheet.locator('[role="alert"]').waitFor();
        assert.equal(await roleSheet.locator('[data-testid="role-model-m1"]').getAttribute("aria-pressed"), "true");
        await roleSheet.locator('[data-testid="role-model-m2"]').click();
        await roleSheet.waitFor({ state: "detached" });
        await panel.locator('[data-testid="role-effort-select"]').click();
        await roleSheet.locator('[data-testid="role-effort-medium"]').click();
        await roleSheet.waitFor({ state: "detached" });
        await panel.locator('[data-testid="lane-prompt-save"]').click();
        await page.waitForFunction(() => document.querySelector('[data-testid="lane-prompt-status"]')?.textContent?.startsWith("Instructions saved."));
        record = db.prepare("SELECT model_id, system_prompt, reasoning_effort FROM role_profiles WHERE role = ?").get("developer");
        assert.deepEqual(record, { model_id: "m2", system_prompt: "Unsaved instructions", reasoning_effort: "medium" });
        assert.equal(db.prepare("SELECT count(*) AS total FROM role_profiles").get().total, 3);
        assert.equal(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), true);
        await page.screenshot({ path: path.join(artifacts, `${engine}-${width}-role-settings.png`) });
        assert.deepEqual(errors, []);
        result.status = "passed";
      } catch (error) {
        result.status = "failed";
        result.error = String(error.stack ?? error);
        await page.screenshot({ path: path.join(artifacts, `${engine}-${width}-failure.png`) }).catch(() => {});
        process.exitCode = 1;
      } finally {
        await page.close();
        await fixture.close();
        await writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
      }
    }
  } finally {
    await browser.close();
  }
}
console.log(JSON.stringify({ artifacts, ...report }, null, 2));
