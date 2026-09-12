import assert from "node:assert/strict";

export async function verifyPostSendInteractions({ page, fixture, mobile }) {
  const input = () => page.locator("textarea.composer-input:visible");
  const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const activate = async (selector) => {
    if (mobile) await page.locator(selector).tap();
    else await page.locator(selector).click();
    await settle();
  };
  const chooseLane = async (lane) => {
    await activate(`[data-testid="lane-tab-${lane}"]`);
    assert.equal(await page.locator(`[data-testid="lane-tab-${lane}"]`).getAttribute("aria-selected"), "true");
    assert.equal(await page.locator(".lanePanel:visible").count(), 1);
  };
  const setKeyboardViewport = async (height, offsetTop = 0) => {
    if (!mobile) return;
    await page.evaluate(({ height, offsetTop }) => {
      Object.assign(window.__chatViewport, { height, offsetTop });
      window.__chatViewport.dispatchEvent(new Event("resize"));
      window.__chatViewport.dispatchEvent(new Event("scroll"));
    }, { height, offsetTop });
    await settle();
  };
  const measureInput = () => input().evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      value: element.value,
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
      insets: Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
        + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth),
      overflow: style.overflowY,
      focused: element === document.activeElement,
    };
  });
  const verifyCleared = async (editor) => {
    assert.equal(await input().evaluate((element, original) => element === original, editor), true,
      "Sending must not replace the original editor to hide a stale DOM value");
    const metrics = await measureInput();
    assert.equal(metrics.value, "", "Every accepted send must clear the same editor");
    assert.equal(metrics.height, metrics.lineHeight + metrics.insets, "Every accepted send must restore one row");
    return metrics;
  };

  await chooseLane("planner");
  await input().fill("");
  await activate("textarea.composer-input:visible");
  await setKeyboardViewport(430);
  const originalEditor = await input().elementHandle();
  const firstPrompt = "browser-advisor-post-send-first";
  const releaseFirstReply = fixture.holdReply(firstPrompt);
  await input().pressSequentially(firstPrompt);
  await activate(".sendIcon:visible");
  const firstSend = await verifyCleared(originalEditor);
  await page.locator(".stopIcon:visible").waitFor();

  const lines = ["browser-advisor-post-send-second"];
  const rowsAfterSending = [];
  for (let rows = 1; rows <= 5; rows += 1) {
    if (rows > 1) {
      await input().press("Shift+Enter");
      lines.push(`Line ${rows}`);
    }
    await input().pressSequentially(lines.at(-1));
    await settle();
    const metrics = await measureInput();
    assert.equal(metrics.value, lines.join("\n"), "Typing after sending must update the same draft");
    assert.equal(metrics.height, metrics.lineHeight * rows + metrics.insets, `After sending, ${rows} full rows must remain visible`);
    assert.equal(metrics.overflow, "hidden");
    rowsAfterSending.push(metrics.height);
  }
  assert.equal(await input().evaluate((element, original) => element === original, originalEditor), true);
  releaseFirstReply();
  await page.waitForFunction((marker) => document.querySelector(".chat")?.textContent.includes(`Advisor reply: ${marker}`), firstPrompt);
  await page.locator(".sendIcon:visible").waitFor();

  const secondPrompt = lines[0];
  const releaseSecondReply = fixture.holdReply(secondPrompt);
  await activate(".sendIcon:visible");
  const secondSend = await verifyCleared(originalEditor);
  await page.locator(".stopIcon:visible").waitFor();
  let activePrompt = secondPrompt;
  let releaseActiveReply = releaseSecondReply;
  let composedSend;
  if (mobile) {
    releaseSecondReply();
    await page.waitForFunction((marker) => document.querySelector(".chat")?.textContent.includes(`Advisor reply: ${marker}`), secondPrompt);
    await page.locator(".sendIcon:visible").waitFor();
    activePrompt = "browser-advisor-post-send-composition";
    releaseActiveReply = fixture.holdReply(activePrompt);
    await input().evaluate((element, marker) => {
      element.focus();
      element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      element.value = marker;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, inputType: "insertCompositionText" }));
    }, activePrompt);
    await settle();
    assert.equal(await page.locator(".sendIcon:visible").isEnabled(), true,
      "Composition after previous sends must enable the send control before compositionend");
    await activate(".sendIcon:visible");
    composedSend = await verifyCleared(originalEditor);
    await page.locator(".stopIcon:visible").waitFor();
  }
  await input().pressSequentially("Advisor draft after two sends");
  if (mobile) {
    await input().dispatchEvent("compositionend");
    assert.equal(await input().inputValue(), "Advisor draft after two sends", "A delayed compositionend must not restore sent text or erase the new draft");
  }
  await setKeyboardViewport(300, 72);
  await chooseLane("worker");
  assert.equal(await input().inputValue(), "");
  assert.ok(!(await page.locator(".chat").innerText()).includes(firstPrompt));
  assert.ok(!(await page.locator(".chat").innerText()).includes(secondPrompt));
  await input().pressSequentially("Worker draft after two sends");
  await setKeyboardViewport(430, 24);
  await chooseLane("planner");
  assert.equal(await input().inputValue(), "Advisor draft after two sends");
  assert.ok((await page.locator(".chat").innerText()).includes(secondPrompt));
  await chooseLane("worker");
  assert.equal(await input().inputValue(), "Worker draft after two sends");
  releaseActiveReply();
  await chooseLane("planner");
  await page.waitForFunction((marker) => document.querySelector(".chat")?.textContent.includes(`Advisor reply: ${marker}`), activePrompt);
  assert.equal(await input().inputValue(), "Advisor draft after two sends");
  assert.equal(fixture.received.filter(({ marker }) => marker === firstPrompt).length, 1);
  assert.equal(fixture.received.filter(({ marker }) => marker === secondPrompt).length, 1);
  if (mobile) assert.equal(fixture.received.filter(({ marker }) => marker === activePrompt).length, 1);
  await input().fill("");
  await chooseLane("worker");
  await input().fill("");
  await chooseLane("planner");
  await setKeyboardViewport(mobile ? 844 : 900);
  await originalEditor.dispose();
  return { firstSend, secondSend, composedSend, rowsAfterSending };
}
