import { describe, it, expect } from "vitest";
import { readSfc } from "./readSfc";

import { createAppContext } from "../app/controller";

describe("mobile pane tabs", () => {
  it("defaults to the project pane on mobile", () => {
    const ctx = createAppContext();
    expect(ctx.mobilePane.value).toBe("tasks");
  });

  it("renders the mobile tab order as projects then chat", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    // Ensure the first mobile tab is "项目" and the second is "对话".
    expect(sfc).toMatch(/<div v-if="isMobile" class="paneTabs"[\s\S]*?>[\s\S]*?>\s*项目\s*<\/button>[\s\S]*?>\s*对话\s*<\/button>/);
  });

  it("does not show the active project label on mobile", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).not.toContain('class="activeProjectDisplay"');
  });
});
