import { describe, expect, it } from "vitest";
import { readSfc } from "./readSfc";

describe("App brand version display", () => {
  it("renders the brand version in the drawer footer instead of the topbar", async () => {
    const content = await readSfc("../App.vue", import.meta.url);
    const topbar = content.match(/<header class="topbar">([\s\S]*?)<\/header>/)?.[1] ?? "";
    const drawer = content.match(/<aside[\s\S]*?data-testid="mobile-drawer"[\s\S]*?<\/aside>/)?.[0] ?? "";

    expect(topbar).not.toMatch(/class="brand"/);
    expect(topbar).not.toMatch(/brandVersion/);
    expect(drawer).toMatch(/<footer class="drawerFooter" data-testid="drawer-footer">/);
    expect(drawer).toMatch(/<span class="drawerBrandTitle">ADS<\/span>/);
    expect(drawer).toMatch(/<span class="drawerBrandVersion">v\{\{ appVersion \}\}<\/span>/);
    expect(content).toMatch(/\.drawerFooter\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?margin-top:\s*auto;/);
    expect(content).toMatch(/\.drawerBrandVersion\s*\{/);
    expect(content).not.toMatch(/\.brandVersion\s*\{/);
  });

  it("lets the project tree fill the sidebar space above the footer", async () => {
    const content = await readSfc("../App.vue", import.meta.url);

    expect(content).toMatch(/\.projectTree\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?height:\s*auto;/);
    expect(content).toMatch(
      /\.left\.mobileDrawer \.drawerFooter\s*\{[\s\S]*?padding-bottom:\s*calc\(4px \+ env\(safe-area-inset-bottom, 0px\)\);/,
    );
  });
});
