import assert from "node:assert/strict";

export async function verifyChatNavigation({ page, mobile, settle }) {
  let drawerGeometry;
  if (mobile) {
    const toggle = page.locator('[data-testid="mobile-drawer-toggle"]');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const box = await toggle.boundingBox();
      // Exercise the left-edge touch region, not just a centered mouse click.
      await toggle.tap({ position: { x: 8, y: box.height / 2 } });
      await page.locator(".mobileDrawer").waitFor({ state: "visible" });
      assert.equal(await toggle.getAttribute("aria-expanded"), "true");
      const drawer = page.locator(".mobileDrawer");
      const projects = drawer.locator('[data-testid="mobile-drawer-section-projects"]');
      assert.equal(await projects.evaluate(element => element === document.activeElement), false,
        "Touch opening must not focus the first navigation button");
      await projects.tap();
      assert.equal(await projects.evaluate(element => element === document.activeElement), false,
        "Touch navigation must release its sticky focus");
      assert.equal(await projects.evaluate(element => getComputedStyle(element).outlineStyle), "none");

      if (attempt === 0) {
        drawerGeometry = await drawer.evaluate(element => {
          const nav = element.querySelector(".mobileDrawerNav");
          const project = element.querySelector(".projectNode");
          const navBounds = nav.getBoundingClientRect();
          const projectBounds = project.getBoundingClientRect();
          return {
            navLeft: navBounds.left, navRight: navBounds.right,
            projectLeft: projectBounds.left, projectRight: projectBounds.right,
            iconLeft: nav.querySelector(".el-icon").getBoundingClientRect().left,
            radioLeft: project.querySelector(".projectStatus").getBoundingClientRect().left,
          };
        });
        assert.ok(Math.abs(drawerGeometry.navLeft - drawerGeometry.projectLeft) < 1, "Drawer cards must share the left edge");
        assert.ok(Math.abs(drawerGeometry.navRight - drawerGeometry.projectRight) < 1, "Drawer cards must share the right edge");
        assert.ok(Math.abs(drawerGeometry.iconLeft - drawerGeometry.radioLeft) < 1, "Navigation icons and project radios must align");

        await drawer.focus();
        await page.keyboard.press("Tab");
        assert.equal(await projects.evaluate(element => element === document.activeElement), true);
        assert.equal(await projects.evaluate(element => getComputedStyle(element).outlineWidth), "2px",
          "Keyboard navigation must retain its visible focus ring after touch input");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await drawer.evaluate(element => element.contains(document.activeElement)), true,
          "Reverse keyboard navigation must stay inside the drawer");
        await page.keyboard.press("Tab");
        assert.equal(await projects.evaluate(element => element === document.activeElement), true);
      }
      const backdrop = page.locator('[data-testid="mobile-drawer-backdrop"]');
      const bounds = await backdrop.boundingBox();
      await backdrop.tap({ position: { x: bounds.width - 5, y: bounds.height / 2 } });
      await page.locator(".mobileDrawer").waitFor({ state: "hidden" });
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    }

    await toggle.focus();
    await page.keyboard.press("Enter");
    const projects = page.locator('[data-testid="mobile-drawer-section-projects"]');
    await projects.waitFor();
    assert.equal(await projects.evaluate(element => element === document.activeElement), true,
      "Keyboard opening must still focus the first navigation item");
    assert.equal(await projects.evaluate(element => getComputedStyle(element).outlineWidth), "2px");
    await page.keyboard.press("Escape");
    await page.locator(".mobileDrawer").waitFor({ state: "hidden" });
    assert.equal(await toggle.evaluate(element => element === document.activeElement), true);
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
  return { leftEdgeMenuTaps: mobile ? 3 : 0, drawerGeometry, hitArea, reachedBottom: true };
}
