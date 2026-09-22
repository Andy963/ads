import assert from "node:assert/strict";

export async function verifyChatNavigation({ page, mobile, settle }) {
  if (mobile) {
    const toggle = page.locator('[data-testid="mobile-drawer-toggle"]');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const box = await toggle.boundingBox();
      // Exercise the left-edge touch region, not just a centered mouse click.
      await toggle.tap({ position: { x: 8, y: box.height / 2 } });
      await page.locator(".mobileDrawer").waitFor({ state: "visible" });
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      const backdrop = page.locator('[data-testid="mobile-drawer-backdrop"]');
      const bounds = await backdrop.boundingBox();
      await backdrop.tap({ position: { x: bounds.width - 5, y: bounds.height / 2 } });
      await page.locator(".mobileDrawer").waitFor({ state: "hidden" });
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    }
  }

  const chat = page.locator('.lanePanel:not([aria-hidden]) .chat');
  await chat.evaluate((host) => {
    host.scrollTop = (host.scrollHeight - host.clientHeight) / 2;
    host.dispatchEvent(new Event("scroll"));
  });
  const button = page.locator('.lanePanel:not([aria-hidden]) .scrollToBottom');
  await button.waitFor();
  const hitArea = await button.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return { width: box.width, height: box.height, reachable: element === hit || element.contains(hit) };
  });
  assert.ok(hitArea.width >= 44 && hitArea.height >= 44, "Bottom navigation needs a full touch target");
  assert.equal(hitArea.reachable, true, "The floating button must be reachable without scrolling it into view");
  if (mobile) await button.tap();
  else await button.click();
  await page.waitForFunction(() => {
    const host = document.querySelector('.lanePanel:not([aria-hidden]) .chat');
    return host && host.scrollHeight - host.scrollTop - host.clientHeight <= 2;
  });
  // Let the bounded layout-correction frames finish before the next test
  // deliberately changes the reading position without user-input events.
  for (let frame = 0; frame < 5; frame += 1) await settle();
  assert.equal(await button.count(), 0);
  return { leftEdgeMenuTaps: mobile ? 3 : 0, hitArea, reachedBottom: true };
}
