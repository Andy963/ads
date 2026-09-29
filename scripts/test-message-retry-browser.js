import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, webkit } from "playwright";

import { startChatBrowserServer } from "./lib/chat-browser-server.js";

const artifacts = await mkdtemp(path.join(tmpdir(), "ads-message-retry-"));
const report = { environment: "Real WebSocket/history routes and temporary SQLite; task list uses an HTTP fixture", cases: [] };
const selectedEngine = process.argv.find(arg => arg.startsWith("--engine="))?.split("=")[1];
const selectedWidth = Number(process.argv.find(arg => arg.startsWith("--width="))?.split("=")[1]);

for (const [engine, browserType] of [["webkit", webkit], ["chromium", chromium]]) {
  if (selectedEngine && selectedEngine !== engine) continue;
  const browser = await browserType.launch();
  try {
    for (const width of [320, 390, 1280]) {
      if (selectedWidth && selectedWidth !== width) continue;
      const fixture = await startChatBrowserServer(path.resolve("dist/client"), { settingsApi: true });
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width < 900, hasTouch: width < 900, serviceWorkers: "block" });
      page.setDefaultTimeout(15000);
      const result = { engine, width, lanes: [] };
      report.cases.push(result);
      const errors = [];
      const prompts = [];
      const events = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("websocket", socket => {
        socket.on("framereceived", ({ payload }) => {
          const frame = JSON.parse(String(payload));
          if (["ack", "user", "in_flight", "status", "error", "result", "history"].includes(frame.type)) {
            events.push({ type: frame.type, ok: frame.ok, kind: frame.kind, inFlight: frame.inFlight,
              message: frame.message, clientMessageId: frame.clientMessageId, queueStatus: frame.queue_status });
          }
        });
        socket.on("framesent", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.type === "prompt") prompts.push({ ...frame, socket: socket.url() });
        });
      });
      const activate = async locator => width < 900 ? locator.tap() : locator.click();
      const chooseLane = async lane => {
        await activate(page.locator(`[data-testid="lane-tab-${lane}"]`));
        await page.waitForFunction(lane => {
          const panel = document.querySelector(`[data-testid="lane-panel-${lane}"]`);
          if (!panel || panel.hasAttribute("aria-hidden")) return false;
          return Math.abs(panel.getBoundingClientRect().left - document.querySelector(".lanePanels").getBoundingClientRect().left) < 1;
        }, lane);
        return page.locator(`[data-testid="lane-panel-${lane}"]`);
      };
      try {
        await page.goto(fixture.origin);
        await page.locator('[data-testid="chat-model-capsule"]:not(:disabled)').waitFor();
        for (const [lane, runtime] of [["acopilot", "Advisor"], ["actions", "Worker"]]) {
          const panel = await chooseLane(lane);
          const marker = `browser-${runtime.toLowerCase()}-retry-${width}`;
          fixture.failReplyOnce(marker);
          await panel.locator("textarea.composer-input").fill(marker);
          await activate(panel.locator('[data-testid="composer-send-btn"]'));
          const retry = panel.locator('[data-testid="inline-turn-retry"]');
          await retry.waitFor();
          const first = prompts.filter(prompt => prompt.payload.text === marker);
          assert.equal(first.length, 1);
          const release = fixture.holdReply(marker);
          try {
            await activate(retry);
            await page.waitForFunction(() => !document.querySelector('.lanePanel:not([aria-hidden]) [data-testid="inline-turn-retry"]'));
            const progress = panel.locator('[data-testid="lane-connection-status"].laneStatusBar--progress');
            await progress.waitFor();
            assert.ok((await progress.textContent()).trim());
            const attempts = prompts.filter(prompt => prompt.payload.text === marker);
            assert.equal(attempts.length, 2);
            assert.equal(attempts[1].client_message_id, first[0].client_message_id);
            assert.equal(attempts[1].socket, first[0].socket);
            assert.equal(attempts[1].payload.replay_incomplete, true);
            assert.equal(attempts[1].payload.model, first[0].payload.model);
            assert.equal(attempts[1].payload.model_reasoning_effort, first[0].payload.model_reasoning_effort);
            assert.equal(await panel.locator('.msg[data-role="user"]').count(), 1);
            await page.screenshot({ path: path.join(artifacts, `${engine}-${width}-${lane}-retry.png`) });
          } finally { release(); }
          await panel.locator('.msg[data-role="assistant"]').filter({ hasText: `${runtime} reply: ${marker}` }).waitFor();
          await panel.locator(".queue-item").waitFor({ state: "detached" });
          const order = await panel.locator('.msg[data-role="assistant"] .msgActions').evaluateAll(rows => rows.map(row =>
            Array.from(row.children).map(element => element.className),
          ));
          assert.ok(order.every(classes => classes[0] === "msgTime" && classes[1] === "msgCopyBtn"));
          assert.equal(fixture.received.filter(item => item.marker === marker && item.lane === runtime).length, 2);
          result.lanes.push(lane);
        }

        const actions = await chooseLane("actions");
        const blockedMarker = "browser-worker-blocked-retry";
        fixture.failReplyOnce(blockedMarker);
        await actions.locator("textarea.composer-input").fill(blockedMarker);
        await activate(actions.locator('[data-testid="composer-send-btn"]'));
        await actions.locator('[data-testid="inline-turn-retry"]').waitFor();
        const jobs = [
          { id: "running-job", issue_title: "Review provider configuration and role settings", current_step: "Checking runtime and UI regressions", status: "running" },
          { id: "queued-job", issue_title: "Check the next queued task", status: "queued" },
          { id: "blocked-job", issue_title: "Wait for the required review decision", status: "blocked" },
        ].map((job, index) => ({ ...job, issue_id: 490 + index, created_at: Date.now() - 10000, updated_at: Date.now() }));
        await page.route("**/api/actions/jobs?*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(jobs) }));
        await page.reload();
        const taskPanel = await chooseLane("actions");
        const taskQueue = taskPanel.locator('[data-testid="actions-job-banner"]');
        await taskQueue.waitFor();
        assert.equal(await taskQueue.locator('[data-testid="actions-queue-row"]').count(), 3);
        const activeRow = taskQueue.locator(".actionsQueueRow--active");
        assert.equal(await activeRow.evaluate(element => {
          const badge = element.querySelector(".actionsJobBadge").getBoundingClientRect();
          const button = element.querySelector("button").getBoundingClientRect();
          const main = element.querySelector(".actionsJobMain").getBoundingClientRect();
          return badge.top < main.bottom && badge.bottom > main.top && button.top < main.bottom && button.bottom > main.top;
        }), true, "Task status, title, and action should share a compact row");
        assert.deepEqual(await taskQueue.evaluate(element => {
          const style = getComputedStyle(element);
          return { radius: style.borderRadius, shadow: style.boxShadow, overflow: element.scrollWidth > element.clientWidth };
        }), { radius: "12px", shadow: "none", overflow: false });
        const retry = taskPanel.locator('[data-testid="inline-turn-retry"]');
        await retry.waitFor();
        const before = prompts.length;
        await activate(retry);
        await page.locator('.noticeToast[role="status"]').waitFor();
        assert.equal(prompts.length, before, "An active Actions job must block inline retries");
        assert.equal(await retry.count(), 1);
        await page.screenshot({ path: path.join(artifacts, `${engine}-${width}-task-queue.png`) });
        assert.deepEqual(errors, []);
        result.status = "passed";
      } catch (error) {
        result.status = "failed";
        result.error = String(error.stack ?? error);
        result.events = events;
        result.visibleStatus = await page.locator('.lanePanel:not([aria-hidden])').innerText().catch(() => "");
        await page.screenshot({ path: path.join(artifacts, `${engine}-${width}-failure.png`) }).catch(() => {});
        process.exitCode = 1;
      } finally {
        await page.close();
        await fixture.close();
        await writeFile(path.join(artifacts, "report.json"), JSON.stringify(report, null, 2));
      }
    }
  } finally { await browser.close(); }
}
console.log(JSON.stringify({ artifacts, ...report }, null, 2));
