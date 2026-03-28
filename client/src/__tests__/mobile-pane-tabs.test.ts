import { describe, it, expect } from "vitest";
import { readSfc } from "./readSfc";

import { createAppContext } from "../app/controller";

describe("mobile pane tabs", () => {
  it("defaults to the project pane on mobile", () => {
    const ctx = createAppContext();
    expect(ctx.mobilePane.value).toBe("tasks");
  });

  it("renders Planner, Worker, and Reviewer in one shared lane tab shell", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).toContain('const chatLanes: Array<{ id: ChatLane; label: string }> = [');
    expect(sfc).toContain('{ id: "planner", label: "Planner" }');
    expect(sfc).toContain('{ id: "worker", label: "Worker" }');
    expect(sfc).toContain('{ id: "reviewer", label: "Reviewer" }');
    expect(sfc).toMatch(/<div class="laneTabs"[^>]*role="tablist"[^>]*>/);
  });

  it("shows only the active lane panel and binds panel visibility to the shared active tab state", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).toMatch(/v-show="activeChatLane === 'planner'"/);
    expect(sfc).toMatch(/v-show="activeChatLane === 'worker'"/);
    expect(sfc).toMatch(/v-show="activeChatLane === 'reviewer'"/);
    expect(sfc).toMatch(/:class="\{ active: activeChatLane === lane.id \}"/);
    expect(sfc).toMatch(/:aria-selected="activeChatLane === lane.id"/);
  });

  it("removes the legacy worker drawer path and repeated project label from the central chat shell", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).not.toContain("topbarWorker");
    expect(sfc).not.toContain("workerDrawerOverlay");
    expect(sfc).not.toContain("workerDrawer");
    expect(sfc).not.toContain('class="activeProjectDisplay"');
  });
});
