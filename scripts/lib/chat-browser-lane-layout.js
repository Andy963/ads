import assert from "node:assert/strict";

export function readLaneLayout(page) {
  return page.evaluate(() => {
    const describe = element => element && ({
      tag: element.tagName,
      id: element.id,
      testId: element.getAttribute("data-testid"),
      classes: element.className,
    });
    const measure = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        ...describe(element),
        left: rect.left, top: rect.top, width: rect.width, height: rect.height,
        scrollLeft: element.scrollLeft, scrollTop: element.scrollTop,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        overflowX: style.overflowX, overflowY: style.overflowY,
        transform: style.transform, inlineTransform: element.style.transform,
        ariaHidden: element.getAttribute("aria-hidden"), inert: element.inert,
      };
    };
    const ancestors = [];
    for (let element = document.querySelector(".lanePanels"); element; element = element.parentElement) {
      ancestors.push(measure(element));
    }
    return {
      activeElement: describe(document.activeElement),
      activeTab: describe(document.querySelector(".laneTab.active")),
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY,
        visualOffsetLeft: visualViewport?.offsetLeft, visualOffsetTop: visualViewport?.offsetTop },
      ancestors,
      panels: [...document.querySelectorAll(".lanePanelsTrack, .lanePanel")].map(measure),
    };
  });
}

export function waitForLaneAlignment(page, lane) {
  return page.waitForFunction(expected => {
    const panel = document.querySelector(`[data-testid="lane-panel-${expected}"]`);
    const viewport = document.querySelector(".lanePanels");
    if (!panel || !viewport || panel.hasAttribute("aria-hidden")) return false;
    return Math.abs(panel.getBoundingClientRect().left - viewport.getBoundingClientRect().left) < 1;
  }, lane);
}

export async function verifyLaneScrollIsolation(page, readings) {
  for (const lane of ["actions", "acopilot"]) {
    // Capture and pause inside the browser before the tap. A slow protocol
    // round trip must not let the transition finish before we can inspect it.
    const capture = await page.evaluateHandle(() => {
      const track = document.querySelector(".lanePanelsTrack");
      const state = { transition: null, error: null };
      const onTransition = event => {
        if (event.target !== track || event.propertyName !== "transform") return;
        track.removeEventListener("transitionrun", onTransition);
        state.transition = track.getAnimations().find(animation => animation.transitionProperty === "transform");
        if (state.transition) state.transition.pause();
        else state.error = "Expected an active lane transition";
      };
      track.addEventListener("transitionrun", onTransition);
      return { state, dispose: () => {
        track.removeEventListener("transitionrun", onTransition);
        if (state.transition?.playState === "paused") state.transition.play();
      } };
    });
    try {
      await page.locator(`[data-testid="lane-tab-${lane}"]`).tap();
      // Intentionally exceed the 360ms transition to simulate delayed CI
      // continuation; the browser-side capture must keep it paused.
      await page.waitForTimeout(500);
      await page.waitForFunction(({ state }) => Boolean(state.transition || state.error), capture);
      await capture.evaluate(async ({ state }, expected) => {
        if (state.error) throw new Error(state.error);
        const transition = state.transition;
        await transition.ready;
        if (transition.playState !== "paused") throw new Error("Lane transition was not captured in time");
        transition.currentTime = Number(transition.effect.getTiming().duration) * 0.05;
        const input = document.querySelector(`[data-testid="lane-panel-${expected}"] textarea`);
        input.scrollIntoView({ block: "nearest", inline: "nearest" });
        transition.play();
      }, lane);
    } finally {
      await capture.evaluate(state => state.dispose());
      await capture.dispose();
    }
    await page.waitForFunction(() => document.querySelector(".lanePanelsTrack").getAnimations()
      .every(animation => animation.playState === "finished"));
    const reading = await readLaneLayout(page);
    readings.push({ lane, ...reading });
    assert.equal(reading.ancestors[0].scrollLeft, 0, "Native reveal scrolling must not shift the lane viewport");
    await waitForLaneAlignment(page, lane);
    const input = page.locator(`[data-testid="lane-panel-${lane}"] textarea`);
    await input.fill(`Draft for ${lane}`);
    await page.locator(`[data-testid="lane-tab-${lane}"]`).tap();
    await waitForLaneAlignment(page, lane);
    assert.equal(await input.inputValue(), `Draft for ${lane}`);
    assert.equal(await input.evaluate(element => document.activeElement === element), true,
      "Re-selecting the active lane must preserve composer focus");
    await input.fill("");
  }
}
