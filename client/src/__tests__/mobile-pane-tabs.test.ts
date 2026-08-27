import { describe, it, expect } from "vitest";
import { readSfc } from "./readSfc";

describe("mobile navigation shell", () => {
  it("renders Advisor and Worker in one shared lane tab shell", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).toContain('const chatLanes: Array<{ id: ChatLane; label: string }> = [');
    expect(sfc).toContain('{ id: "planner", label: "Advisor" }');
    expect(sfc).toContain('{ id: "worker", label: "Worker" }');
    expect(sfc).not.toContain('{ id: "reviewer", label: "Reviewer" }');
    expect(sfc).toMatch(/<div class="laneTabs"[^>]*role="tablist"[^>]*>/);
  });

  it("shows only the active lane panel and binds panel visibility to the shared active tab state", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).toMatch(/v-show="activeChatLane === 'planner'"/);
    expect(sfc).toMatch(/v-show="activeChatLane === 'worker'"/);
    expect(sfc).not.toMatch(/v-show="activeChatLane === 'reviewer'"/);
    expect(sfc).toMatch(/:class="\{ active: activeChatLane === lane.id \}"/);
    expect(sfc).toMatch(/:aria-selected="activeChatLane === lane.id"/);
  });

  it("uses a mobile drawer and keeps the chat shell visible instead of pane tabs", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).toContain('data-testid="mobile-drawer-toggle"');
    expect(sfc).toContain('data-testid="mobile-drawer-section-projects"');
    expect(sfc).toContain('data-testid="mobile-drawer-section-rules"');
    expect(sfc).toContain('data-testid="mobile-drawer-section-models"');
    expect(sfc).toContain('data-testid="mobile-context-menu-toggle"');
    expect(sfc).not.toContain('mobilePane === "tasks"');
    expect(sfc).not.toContain('mobilePane === "chat"');
    expect(sfc).not.toContain('class="paneTabs"');
  });

  it("scopes the context menu actions to the active drawer module", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).toContain('id: "resume"');
    expect(sfc).toContain('id: "new-session"');
    expect(sfc).toContain('id: "create-rule"');
    expect(sfc).toContain('id: "refresh-rules"');
    expect(sfc).toContain('id: "create-model"');
    expect(sfc).toContain('id: "refresh-models"');
    expect(sfc).toContain("disabled: activeLaneBusy.value || resumeThreadBlocked.value");
    expect(sfc).toContain("mobileGlobalRuleManagerRef.value?.create()");
    expect(sfc).toContain("mobileModelManagerRef.value?.create()");
    expect(sfc).not.toContain("打开项目");
  });

  it("hides duplicate lane session buttons on mobile", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).toContain('v-if="!isMobile && activeLaneHasResume"');
    expect(sfc).toContain('v-if="!isMobile"\n            class="laneTabIconBtn"');
  });
});
