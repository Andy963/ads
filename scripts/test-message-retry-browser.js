import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, webkit } from "playwright";

import { startChatBrowserServer } from "./lib/chat-browser-server.js";
import { readLaneLayout, waitForLaneAlignment, verifyLaneScrollIsolation } from "./lib/chat-browser-lane-layout.js";

const artifacts = await mkdtemp(path.join(tmpdir(), "ads-message-retry-"));
const report = { environment: "Real WebSocket/history routes and temporary SQLite; task list uses an HTTP fixture", cases: [] };
const selectedEngine = process.argv.find(arg => arg.startsWith("--engine="))?.split("=")[1];
const selectedWidth = Number(process.argv.find(arg => arg.startsWith("--width="))?.split("=")[1]);
const durableQueue = !process.argv.includes("--compat-queue");
report.durableQueue = durableQueue;
const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC2kAAAAASUVORK5CYII=", "base64");

for (const [engine, browserType] of [["webkit", webkit], ["chromium", chromium]]) {
  if (selectedEngine && selectedEngine !== engine) continue;
  const browser = await browserType.launch();
  try {
    for (const width of [320, 390, 1280]) {
      if (selectedWidth && selectedWidth !== width) continue;
      const fixture = await startChatBrowserServer(path.resolve("dist/client"), { settingsApi: true, durableQueue });
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width < 900, hasTouch: width < 900, serviceWorkers: "block" });
      page.setDefaultTimeout(15000);
      const result = { engine, width, lanes: [], laneSelections: [] };
      report.cases.push(result);
      const errors = [];
      const prompts = [];
      const events = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("websocket", socket => {
        socket.on("framereceived", ({ payload }) => {
          const frame = JSON.parse(String(payload));
          if (["ack", "user", "in_flight", "status", "error", "result", "history", "prompt_reconcile_result"].includes(frame.type)) {
            events.push({ type: frame.type, ok: frame.ok, kind: frame.kind, inFlight: frame.inFlight,
              message: frame.message, clientMessageId: frame.clientMessageId, queueStatus: frame.queue_status, identities: frame.identities });
          }
        });
        socket.on("framesent", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.type === "prompt") prompts.push({ ...frame, socket: socket.url() });
        });
      });
      const activate = async locator => width < 900 ? locator.tap() : locator.click();
      const chooseLane = async lane => {
        const selection = { lane, before: await readLaneLayout(page) };
        result.laneSelections.push(selection);
        await activate(page.locator(`[data-testid="lane-tab-${lane}"]`));
        await waitForLaneAlignment(page, lane);
        selection.after = await readLaneLayout(page);
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
            assert.equal(attempts[1].payload.retry_original, true);
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
          if (durableQueue) {
            const offlineMarker = `browser-${runtime.toLowerCase()}-offline-retry-${width}`;
            fixture.failReplyOnce(offlineMarker);
            await panel.locator("textarea.composer-input").fill(offlineMarker);
            await activate(panel.locator('[data-testid="composer-send-btn"]'));
            await retry.waitFor();
            const original = prompts.find(prompt => prompt.payload.text === offlineMarker);
            assert.ok(original);
            await page.context().setOffline(true);
            fixture.disconnectClients();
            await page.locator(`[data-testid="lane-tab-status-${lane}"].laneTabStatusDot--disconnected`).waitFor();
            await activate(retry);
            await panel.locator(".queue-item").waitFor();
            assert.equal(await panel.locator(".queue-status").count(), 0);
            assert.equal((await panel.locator(".queue-controls").textContent()).trim(), "");
            assert.equal(prompts.filter(prompt => prompt.payload.text === offlineMarker).length, 1);
            assert.equal(await page.evaluate(id => Object.keys(localStorage)
              .filter(key => key.startsWith("ads.outbox."))
              .some(key => JSON.parse(localStorage.getItem(key)).queued?.some(prompt =>
                prompt.clientMessageId === id && prompt.replayIncomplete === true)), original.client_message_id),
            true, "The retry must survive in persistent storage");
            // Closing the page before reconnect ensures no warm runtime can
            // hide a missing cold-start retry restoration path.
            if (width === 390) await page.goto("about:blank");
            await page.context().setOffline(false);
            if (width === 390) {
              await page.goto(fixture.origin);
              await page.locator('[data-testid="chat-model-capsule"]:not(:disabled)').waitFor();
              await chooseLane(lane);
            }
            await panel.locator('.msg[data-role="assistant"]').filter({ hasText: `${runtime} reply: ${offlineMarker}` }).waitFor();
            await panel.locator(".queue-item").waitFor({ state: "detached" });
            const attempts = prompts.filter(prompt => prompt.payload.text === offlineMarker);
            assert.equal(attempts.length, 2);
            assert.equal(attempts[1].client_message_id, original.client_message_id);
            assert.equal(attempts[1].payload.model, original.payload.model);
            assert.equal(attempts[1].payload.model_reasoning_effort, original.payload.model_reasoning_effort);
            assert.equal(fixture.received.filter(item => item.marker === offlineMarker && item.lane === runtime).length, 2);
            assert.ok(events.some(event => event.identities?.some(identity =>
              identity.clientMessageId === original.client_message_id && identity.retryable === true)),
            "The offline retry must survive the real durable reconciliation response");

            const imageMarker = `browser-${runtime.toLowerCase()}-image-retry-${width}`;
            const imagePath = `/api/attachments/browser-${lane}-${width}/raw`;
            let uploads = 0;
            await page.route("**/api/attachments/images?*", route => {
              uploads += 1;
              return route.fulfill({ contentType: "application/json", body: JSON.stringify({
                id: `browser-${lane}-${width}`, url: imagePath,
                contentType: "image/png", width: 1, height: 1, sizeBytes: imageBytes.length,
              }) });
            });
            await page.route(`**${imagePath}`, route => route.fulfill({ contentType: "image/png", body: imageBytes }));
            fixture.failReplyOnce(imageMarker);
            await panel.locator('input[type="file"]').setInputFiles({ name: "retry.png", mimeType: "image/png", buffer: imageBytes });
            await panel.locator('[data-testid="attachment-item-0"]').waitFor();
            await panel.locator("textarea.composer-input").fill(imageMarker);
            await activate(panel.locator('[data-testid="composer-send-btn"]'));
            await retry.waitFor();
            const imageOriginal = prompts.find(prompt => prompt.payload.text?.includes(imageMarker));
            assert.ok(imageOriginal);
            assert.equal(imageOriginal.payload.images.length, 1);
            assert.ok(imageOriginal.payload.text.includes(imagePath));
            assert.equal(uploads, 1);
            // Drop all warm client state. The retry must use the server's saved
            // image request, not reconstruct it from the reloaded chat bubble.
            await page.reload();
            await page.locator('[data-testid="chat-model-capsule"]:not(:disabled)').waitFor();
            await chooseLane(lane);
            await retry.waitFor();
            await activate(retry);
            await panel.locator('.msg[data-role="assistant"]').filter({ hasText: `${runtime} reply: ${imageMarker}` }).waitFor();
            await panel.locator(".queue-item").waitFor({ state: "detached" });
            const imageAttempts = prompts.filter(prompt => prompt.client_message_id === imageOriginal.client_message_id);
            assert.equal(imageAttempts.length, 2);
            assert.equal(imageAttempts[1].payload.retry_original, true);
            assert.equal(imageAttempts[1].payload.images, undefined, "The client must not persist or resend a second image copy");
            assert.equal(uploads, 1, "Retry must not upload the attachment again");
            assert.deepEqual(fixture.received.filter(item => item.marker === imageMarker && item.lane === runtime)
              .map(item => item.imageCount), [1, 1], "Both provider attempts must receive the original image");
            assert.equal(await panel.locator('.msg[data-role="user"]').filter({ hasText: imageMarker }).count(), 1);
            assert.ok(!events.some(event => String(event.message ?? "").includes("different prompt payload")));
            await page.unroute("**/api/attachments/images?*");
          }
          result.lanes.push(lane);
        }

        if (width < 900) {
          await chooseLane("acopilot");
          result.scrollIsolation = [];
          await verifyLaneScrollIsolation(page, result.scrollIsolation);
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
        assert.equal(await taskQueue.locator('[data-testid="actions-queue-front"]').count(), 1);
        assert.equal(await taskQueue.locator('[data-testid="actions-queue-peek"]').count(), 2);
        const activeRow = taskQueue.locator('[data-testid="actions-queue-front"]');
        assert.equal(await activeRow.getAttribute("data-job-id"), "running-job");
        assert.equal(await activeRow.evaluate(element => {
          const badge = element.querySelector(".actionsJobBadge").getBoundingClientRect();
          const button = element.querySelector("button").getBoundingClientRect();
          const title = element.querySelector(".actionsQueueCardTitle").getClientRects()[0];
          return badge.top < title.bottom && badge.bottom > title.top && button.top < title.bottom && button.bottom > title.top;
        }), true, "Task status, title, and action should share a compact row");
        assert.deepEqual(await activeRow.evaluate(element => {
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
        await activeRow.press("ArrowDown");
        assert.equal(await activeRow.getAttribute("data-job-id"), "blocked-job");
        await activeRow.press("ArrowDown");
        assert.equal(await activeRow.getAttribute("data-job-id"), "queued-job");
        await page.route("**/api/actions/jobs/queued-job/cancel", route => route.fulfill({
          contentType: "application/json", body: JSON.stringify({ status: "cancelled" }),
        }));
        await Promise.all([
          page.waitForResponse(response => response.url().endsWith("/api/actions/jobs/queued-job/cancel") && response.ok()),
          activate(activeRow.locator('[data-testid="btn-action-cancel"]')),
        ]);
        assert.deepEqual(errors, []);
        result.status = "passed";
      } catch (error) {
        result.status = "failed";
        result.error = String(error.stack ?? error);
        result.layout = await readLaneLayout(page).catch(() => null);
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
console.log(JSON.stringify({ artifacts, ...report, cases: report.cases.map(result => result.status === "passed"
  ? { engine: result.engine, width: result.width, lanes: result.lanes, status: result.status }
  : result) }, null, 2));
