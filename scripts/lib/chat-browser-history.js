import assert from "node:assert/strict";

export async function verifyMonotonicHistory({ page, send, waitForReply, chooseLane, settle, report }) {
  const snapshots = [];
  report.snapshots = snapshots;
  await chooseLane("advisor");
  const chat = page.locator('.lanePanel:not([aria-hidden]) .chat');
  const list = chat.locator(".messageList");
  const loadedCount = async () => Number(await list.getAttribute("data-loaded-messages"));
  const initialTotal = Number(await list.getAttribute("data-total-messages"));

  // Populate persisted history through the real WebSocket prompt path, then test
  // the initial window on reload rather than mistaking a live sliding window for it.
  for (let index = 0; index < 35; index += 1) {
    const marker = `browser-advisor-scroll-${index}`;
    await send(marker);
    await waitForReply(`Advisor reply: ${marker}`);
  }
  const persistedTotal = initialTotal + 70;
  assert.equal(Number(await list.getAttribute("data-total-messages")), persistedTotal);

  // Establish the newest-page invariant after streaming has finished and before
  // pagehide persists the viewport.
  await chat.evaluate((root) => {
    root.dispatchEvent(new Event("wheel"));
    root.scrollTop = root.scrollHeight;
    root.dispatchEvent(new Event("scroll"));
  });
  await settle();

  await page.reload();
  await page.waitForSelector("textarea:not(:disabled):visible");
  await chooseLane("advisor");
  await waitForReply("Advisor reply: browser-advisor-scroll-34");
  await settle();
  assert.equal(Number(await list.getAttribute("data-total-messages")), persistedTotal);
  assert.equal(await loadedCount(), 30, "Reload must initially mount only the newest history page");
  report.initialLoaded = 30;
  report.total = persistedTotal + 2;

  await chat.evaluate((root) => {
    const nativeScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    if (!nativeScroll?.get || !nativeScroll.set) throw new Error("Missing native scrollTop descriptor");
    const rows = new Map();
    const writes = [];
    const rememberRows = () => {
      for (const row of root.querySelectorAll(".msg")) rows.set(row.dataset.id, row);
    };
    rememberRows();
    Object.defineProperty(root, "scrollTop", {
      configurable: true,
      get: () => nativeScroll.get.call(root),
      set: (value) => {
        writes.push(value);
        nativeScroll.set.call(root, value);
      },
    });
    root.__historyProbe = {
      move: (top) => {
        // Test-driven movement bypasses the recorder; application scroll writes do not.
        nativeScroll.set.call(root, top);
        root.dispatchEvent(new Event("scroll"));
      },
      resetWrites: () => writes.splice(0),
      rememberRows,
      snapshot: () => ({
        retained: [...rows].every(([id, row]) => root.contains(row) && row.dataset.id === id),
        rememberedCount: rows.size,
        writes: [...writes],
        scrollTop: root.scrollTop,
        scrollHeight: root.scrollHeight,
        clientHeight: root.clientHeight,
        anchor: root.__historyProbe.anchor ? {
          id: root.__historyProbe.anchor.row.dataset.id,
          beforeTop: root.__historyProbe.anchor.top,
          top: root.__historyProbe.anchor.row.getBoundingClientRect().top,
          height: root.__historyProbe.anchor.row.getBoundingClientRect().height,
        } : null,
        anchorDelta: root.__historyProbe.anchor
          ? root.__historyProbe.anchor.row.getBoundingClientRect().top - root.__historyProbe.anchor.top
          : null,
      }),
    };
  });

  const verifyRows = async (stage) => {
    const snapshot = await chat.evaluate((root) => root.__historyProbe.snapshot());
    snapshots.push({ stage, loaded: await loadedCount(), ...snapshot });
    assert.equal(snapshot.retained, true, `${stage}: loaded DOM rows must retain their identity`);
    assert.deepEqual(snapshot.writes, [], `${stage}: history browsing must not write scrollTop`);
    return snapshot;
  };

  try {
    await chat.evaluate((root) => root.__historyProbe.move((root.scrollHeight - root.clientHeight) / 2));
    await settle();
    await send("browser-advisor-scroll-away");
    await waitForReply("Advisor reply: browser-advisor-scroll-away");
    await settle();
    assert.equal(await loadedCount(), 32, "Tail appends must retain the initial window while away from the bottom");
    await chat.evaluate((root) => root.__historyProbe.resetWrites());
    await verifyRows("tail append before expansion");
    await chat.evaluate((root) => root.__historyProbe.rememberRows());

    const total = persistedTotal + 2;
    while (await loadedCount() < total) {
      const previousCount = await loadedCount();
      const expected = Math.min(total, previousCount + 20);
      await chat.evaluate((root) => root.__historyProbe.move(root.scrollHeight));
      await settle();
      assert.equal(await loadedCount(), previousCount, "Downward scrolling must not shrink or expand the window");
      await verifyRows("scroll down");

      await chat.evaluate((root) => {
        root.__historyProbe.move(120);
        const bounds = root.getBoundingClientRect();
        const row = [...root.querySelectorAll(".msg")].find((element) => {
          const box = element.getBoundingClientRect();
          return box.top >= bounds.top && box.bottom <= bounds.bottom;
        });
        if (!row) throw new Error("No visible history row to anchor");
        root.__historyProbe.anchor = { row, top: row.getBoundingClientRect().top };
        root.__historyProbe.beforePrepend = root.__historyProbe.snapshot();
      });
      snapshots.push({ stage: "before prepend", loaded: previousCount, ...await chat.evaluate((root) => root.__historyProbe.beforePrepend) });
      await page.waitForFunction((expectedCount) => {
        const root = document.querySelector('.lanePanel:not([aria-hidden]) .chat');
        return Number(root?.querySelector(".messageList")?.getAttribute("data-loaded-messages")) >= expectedCount;
      }, expected);
      await settle();
      assert.equal(await loadedCount(), expected, "Each upward intersection must load at most one history page");
      const snapshot = await verifyRows("prepend older page");
      assert.ok(Math.abs(snapshot.anchorDelta) <= 2, `Native scroll anchoring shifted the visible row by ${snapshot.anchorDelta}px`);
      await chat.evaluate((root) => {
        root.__historyProbe.anchor = null;
        root.__historyProbe.rememberRows();
      });
    }

    for (const position of ["bottom", "top", "bottom", "top", "bottom"]) {
      await chat.evaluate((root, target) => root.__historyProbe.move(target === "bottom" ? root.scrollHeight : 120), position);
      await settle();
      assert.equal(await loadedCount(), total);
      await verifyRows(`fully loaded scroll ${position}`);
    }
  } finally {
    await chat.evaluate((root) => {
      delete root.scrollTop;
      delete root.__historyProbe;
    });
  }
}
