import assert from "node:assert/strict";
import path from "node:path";

const commandSelector = '.lanePanel:not([aria-hidden]) .execute-cmd';

export async function verifyExecuteMarquee({ page, fixture, send, waitForReply, artifacts, engine }) {
  const results = [];
  const command = page.locator(commandSelector);
  const measure = () => command.evaluate((slot) => {
    const track = slot.querySelector(".execute-cmd-track");
    const copy = slot.querySelector(".execute-cmd-copy");
    const style = getComputedStyle(track);
    return {
      slotWidth: slot.clientWidth,
      textWidth: copy.getBoundingClientRect().width,
      x: copy.getBoundingClientRect().left - slot.getBoundingClientRect().left,
      overflowing: slot.classList.contains("execute-cmd--overflowing"),
      running: slot.closest(".execute-block").classList.contains("execute-block--running"),
      animationDuration: style.animationDuration,
      iterationCount: style.animationIterationCount,
      blocks: slot.closest(".lanePanel").querySelectorAll(".execute-block").length,
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
  });
  const verifyMovement = async () => {
    const before = await measure();
    assert.equal(before.overflowing, true);
    assert.equal(before.animationDuration, "20s", "The command must scroll at half the previous 10-second-cycle speed");
    assert.ok(before.textWidth > before.slotWidth);
    assert.equal(before.pageOverflow, false);
    // Observe native animation frames; do not seek or accelerate the animation.
    try {
      await page.waitForFunction(({ selector, x }) => {
        const slot = document.querySelector(selector);
        const copy = slot?.querySelector(".execute-cmd-copy");
        return copy && copy.getBoundingClientRect().left - slot.getBoundingClientRect().left < x - 5;
      }, { selector: commandSelector, x: before.x }, { timeout: 1500, polling: "raf" });
    } catch (cause) {
      throw new Error(`Command did not move left: ${JSON.stringify({ before, after: await measure() })}`, { cause });
    }
    return { before, after: await measure() };
  };
  const verifyTail = async () => {
    await page.waitForFunction((selector) => {
      const slot = document.querySelector(selector);
      const text = slot?.querySelector(".execute-cmd-copy")?.firstChild;
      if (!text?.textContent) return false;
      const range = document.createRange();
      range.setStart(text, Math.max(0, text.textContent.length - 12));
      range.setEnd(text, text.textContent.length);
      const tail = range.getBoundingClientRect();
      const viewport = slot.getBoundingClientRect();
      return tail.width > 0 && tail.left >= viewport.left && tail.right <= viewport.right;
    }, commandSelector, { timeout: 22000, polling: "raf" });
    return measure();
  };

  try {
    for (const reducedMotion of ["no-preference", "reduce"]) {
      await page.emulateMedia({ reducedMotion });
      const marker = `browser-worker-marquee-${reducedMotion === "reduce" ? "reduced" : "normal"}`;
      const result = { reducedMotion };
      results.push(result);
      const complete = fixture.holdCommandCompletion(marker);
      try {
        await send(marker);
        await page.waitForFunction(({ selector, marker }) =>
          document.querySelector(selector)?.getAttribute("title")?.includes(marker),
        { selector: commandSelector, marker });
        result.running = await verifyMovement();
        assert.equal(result.running.before.running, true);
        const firstPixels = await command.screenshot();
        result.runningTail = await verifyTail();
        assert.equal(result.runningTail.running, true);
        const tailPixels = await command.screenshot(artifacts
          ? { path: path.join(artifacts, `${engine}-marquee-${reducedMotion}-running-tail.png`) }
          : {});
        assert.ok(!firstPixels.equals(tailPixels), "The visible command pixels must change, not only the transform");
      } finally {
        complete();
      }

      await waitForReply(`Worker reply: ${marker}`);
      result.completed = await verifyMovement();
      assert.equal(result.completed.before.running, false);
      result.completedTail = await verifyTail();
      if (artifacts) await command.screenshot({ path: path.join(artifacts, `${engine}-marquee-${reducedMotion}-completed-tail.png`) });

      const nextMarker = `${marker}-next`;
      const completeNext = fixture.holdCommandCompletion(nextMarker);
      try {
        await send(nextMarker);
        await page.waitForFunction(({ selector, marker }) =>
          document.querySelector(selector)?.getAttribute("title")?.includes(marker),
        { selector: commandSelector, marker: nextMarker });
        const replacement = await measure();
        assert.equal(replacement.blocks, 1);
        assert.ok(replacement.x > -replacement.textWidth / 4, "A replacement command must start near its beginning, not inherit the previous offset");
        result.replacement = await verifyMovement();
      } finally {
        completeNext();
      }
      await waitForReply(`Worker reply: ${nextMarker}`);

      const shortMarker = `${marker}-short`;
      await send(shortMarker);
      await waitForReply(`Worker reply: ${shortMarker}`);
      result.short = await measure();
      assert.equal(await command.innerText(), "npm test");
      assert.equal(result.short.overflowing, false);
      assert.equal(result.short.x, 0);
      assert.equal(result.short.blocks, 1);
      assert.equal(await command.locator(".execute-cmd-track").evaluate((track) => track.getAnimations().length), 0);
    }
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
  return results;
}
