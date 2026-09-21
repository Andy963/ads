import assert from "node:assert/strict";

async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

export async function verifyLocalFirstTranscript({ page, context, fixture, frames, send, waitForReply, chooseLane, settle, report, engine }) {
  await chooseLane("advisor");
  const chat = page.locator(".chat:visible");
  const syncResponses = [];
  report.syncResponses = syncResponses;
  const onResponse = async (response) => {
    if (new URL(response.url()).pathname !== "/api/sync/events") return;
    const body = await response.json().catch(() => null);
    syncResponses.push({
      status: response.status(), afterSeq: new URL(response.url()).searchParams.get("afterSeq"),
      latestSeq: body?.latestSeq, truncated: body?.truncated,
      types: body?.events?.map((event) => event.type),
    });
  };
  page.on("response", onResponse);

  await chat.evaluate((root) => {
    root.dispatchEvent(new Event("wheel"));
    root.scrollTop = Math.max(300, (root.scrollHeight - root.clientHeight) / 2);
    root.dispatchEvent(new Event("scroll"));
  });
  await settle();
  await chat.evaluate((root) => {
    const native = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    const rows = [...root.querySelectorAll(".msg")];
    const anchor = rows.find((row) => row.getBoundingClientRect().bottom > root.getBoundingClientRect().top);
    window.__localFirstProbe = {
      root, rows, markdown: [...root.querySelectorAll(".md")],
      scrollTop: root.scrollTop, anchor, anchorTop: anchor.getBoundingClientRect().top, writes: [],
    };
    Object.defineProperty(root, "scrollTop", {
      configurable: true, get: () => native.get.call(root),
      set: (value) => { window.__localFirstProbe.writes.push(value); native.set.call(root, value); },
    });
  });
  const snapshot = () => page.evaluate(() => {
    const probe = window.__localFirstProbe;
    return {
      retained: probe.rows.every((row) => probe.root.contains(row)) && probe.markdown.every((node) => probe.root.contains(node)),
      scrollDelta: probe.root.scrollTop - probe.scrollTop,
      anchorDelta: probe.anchor.getBoundingClientRect().top - probe.anchorTop,
      writes: [...probe.writes],
    };
  });
  try {
    const unchangedStart = frames.length;
    fixture.disconnectClients();
    await until(() => frames.slice(unchangedStart).some((frame) => frame.type === "welcome" && frame.chatSessionId === "advisor"), "unchanged reconnect");
    await settle();
    assert.ok(frames.slice(unchangedStart).some((frame) => frame.historyMode === "resume"));
    assert.ok(!frames.slice(unchangedStart).some((frame) => frame.type === "history"));
    report.unchanged = await snapshot();
    assert.equal(report.unchanged.retained, true);
    assert.equal(report.unchanged.scrollDelta, 0);
    assert.equal(report.unchanged.anchorDelta, 0);
    assert.deepEqual(report.unchanged.writes, []);

    const marker = "browser-advisor-offline-delta";
    const release = fixture.holdReply(marker);
    await send(marker);
    await until(() => fixture.received.some((entry) => entry.marker === marker), "held provider request");
    const deltaStart = frames.length;
    const responseStart = syncResponses.length;
    fixture.disconnectClients();
    release();
    await waitForReply(`Advisor reply: ${marker}`);
    await settle();
    await until(() => syncResponses.length > responseStart, "real HTTP catch-up response");
    const replies = syncResponses.slice(responseStart);
    assert.ok(replies.every((response) => response.status === 200 && !response.truncated));
    assert.ok(replies.some((response) => response.types.includes("result")));
    assert.ok(replies.every((response) => !response.types.includes("history")));
    assert.ok(!frames.slice(deltaStart).some((frame) => frame.type === "history"));
    report.incremental = await snapshot();
    assert.equal(report.incremental.retained, true);
    assert.ok(Math.abs(report.incremental.anchorDelta) <= 2);
    assert.deepEqual(report.incremental.writes, []);
  } finally {
    await chat.evaluate((root) => { delete root.scrollTop; });
  }

  const saved = await chat.evaluate((root) => {
    const top = root.getBoundingClientRect().top;
    const row = [...root.querySelectorAll(".msg")].find((entry) => entry.getBoundingClientRect().bottom > top);
    root.dispatchEvent(new Event("scroll"));
    return { id: row.dataset.id, offset: row.getBoundingClientRect().top - top, loaded: root.querySelectorAll(".msg").length };
  });
  await page.waitForFunction((id) => Object.keys(localStorage).some((key) => {
    if (!key.startsWith("ads.transcript.v1.")) return false;
    const cached = JSON.parse(localStorage.getItem(key));
    return cached.complete && cached.viewport?.anchorId === id && cached.viewport?.following === false;
  }), saved.id);
  // Hold the actual server response. page.route cannot reliably intercept a
  // fetch initiated by the installed service worker, especially in WebKit.
  const authGate = fixture.holdAuthentication();
  await page.addInitScript(({ anchorId }) => {
    const observer = new MutationObserver(() => {
      const root = document.querySelector(".chat");
      const row = [...(root?.querySelectorAll(".msg") ?? [])].find((entry) => entry.dataset.id === anchorId);
      if (!root || !row) return;
      window.__cachedFirstFrame = {
        readOnly: document.querySelector(".app")?.getAttribute("data-cache-read-only"),
        offset: row.getBoundingClientRect().top - root.getBoundingClientRect().top,
        loaded: root.querySelectorAll(".msg").length,
      };
      observer.disconnect();
    });
    observer.observe(document, { subtree: true, childList: true });
  }, { anchorId: saved.id });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.__cachedFirstFrame));
    await until(() => authGate.received() > 0, "held authentication request");
    report.firstFrame = await page.evaluate(() => window.__cachedFirstFrame);
    assert.equal(report.firstFrame.readOnly, "true");
    assert.equal(report.firstFrame.loaded, saved.loaded);
    assert.ok(Math.abs(report.firstFrame.offset - saved.offset) <= 2, `Cold cache anchor moved by ${report.firstFrame.offset - saved.offset}px`);
    assert.equal(await page.locator("textarea.composer-input:visible").isDisabled(), true);
  } finally {
    authGate.release();
  }
  await page.waitForSelector("textarea:not(:disabled):visible");
  await settle();

  report.offline = true;
  // Playwright's Linux WebKit fails navigation internally when its offline
  // flag is set, before the worker can serve the cached shell. Refuse every
  // origin HTTP request instead; this still requires an actual cached-shell
  // reload, but is explicitly an origin-outage test, not iOS offline proof.
  report.offlineMode = engine === "webkit" ? "origin-unreachable; offline-toggle reload fails on this Linux WebKit host" : "browser-context-offline";
  const offlineAuthResponse = engine === "webkit"
    ? page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/auth/status" && response.status() === 503;
    })
    : null;
  try {
    if (engine === "webkit") fixture.setOriginOffline(true);
    else await context.setOffline(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".chat .msg");
    await offlineAuthResponse;
    await settle();
    assert.equal(await page.locator(".app").getAttribute("data-cache-read-only"), "true");
    assert.equal(await page.locator("textarea.composer-input:visible").isDisabled(), true);
    assert.ok((await page.locator(".chat").innerText()).includes("Advisor reply: browser-advisor-offline-delta"));
    await page.evaluate(() => { window.__offlineRow = document.querySelector(".chat .msg"); });
    report.offlineReadable = true;
  } finally {
    const onlineAuthResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/auth/me" && response.status() === 200;
    });
    fixture.setOriginOffline(false);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await onlineAuthResponse;
  }
  await page.waitForSelector("textarea:not(:disabled):visible");
  await settle();
  assert.equal(await page.evaluate(() => document.querySelector(".chat .msg") === window.__offlineRow), true);
  report.offline = false;
  page.off("response", onResponse);
}
