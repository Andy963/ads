import { describe, it, expect } from "vitest";
import { readSfc } from "./readSfc";

describe("mobile navigation shell", () => {
  it("renders Advisor and Worker in one shared mobile workspace tab shell", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).toContain('const chatLanes: Array<{ id: ChatLane; label: string }> = [');
    expect(sfc).toContain('{ id: "planner", label: "Advisor" }');
    expect(sfc).toContain('{ id: "worker", label: "Worker" }');
    expect(sfc).not.toContain('{ id: "tasks", label: "Task" }');
        expect(sfc).not.toContain('{ id: "reviewer", label: "Reviewer" }');
    expect(sfc).toMatch(/<div class="laneTabs"[^>]*role="tablist"[^>]*>/);
  });

  it("shows only the active lane panel and binds panel visibility to the shared active tab state", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).toMatch(/v-show="activeWorkspaceTab === 'planner'"/);
    expect(sfc).toMatch(/v-show="activeWorkspaceTab === 'worker'"/);
    expect(sfc).not.toMatch(/v-show="activeWorkspaceTab === 'tasks'"/);
    expect(sfc).not.toMatch(/v-show="activeWorkspaceTab === 'reviewer'"/);
    expect(sfc).toMatch(/:class="\{[\s\S]*active:\s*activeWorkspaceTab === tab.id/);
    expect(sfc).toMatch(/:aria-selected="activeWorkspaceTab === tab.id"/);
  });

  it("uses a unified model manager without provider subitems", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).toContain('data-testid="mobile-drawer-toggle"');
    expect(sfc).toContain('data-testid="mobile-drawer-section-projects"');
    expect(sfc).toContain('data-testid="mobile-drawer-section-models"');
    expect(sfc).toContain("<span>Provider</span>");
    expect(sfc).not.toContain('class="mobileDrawerSubitems"');
    expect(sfc).not.toContain("MODEL_AGENT_GROUPS");
    expect(sfc).toContain('class="mobileMainPanel"');
    // projectTasks removed
    expect(sfc).not.toContain('class="lanePanel taskLanePanel"');
    expect(sfc).not.toContain('class="mobileTaskWorkspace"');
    expect(sfc).toContain('v-if="mobileDrawerSection === \'models\'"');
    expect(sfc).toContain("flex-direction: column");
    expect(sfc).toContain('v-if="!isMobile && p.id === \'default\'"');
    // create button removed
    expect(sfc).not.toContain('id: "create-task"');
    expect(sfc).not.toContain("mobileDrawerSubitemArrow");
    expect(sfc).not.toContain("mobileDrawerManager");
    expect(sfc).not.toContain('mobilePane === "tasks"');
    expect(sfc).not.toContain('mobilePane === "chat"');
    expect(sfc).not.toContain('class="paneTabs"');
  });

  it("uses the two-line menu icon and scopes actions to the active module", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).toContain('class="mobileMenuIcon"');
    expect(sfc).toContain('<rect x="2" y="5.5" width="16" height="2.2" rx="1.1" />');
    expect(sfc).toContain('<rect x="2" y="12.3" width="10" height="2.2" rx="1.1" />');
    expect(sfc).toContain('id: "resume"');
    expect(sfc).toContain('id: "new-session"');
    expect(sfc).toContain('id: "create-model"');
    expect(sfc).toContain('id: "refresh-models"');
    expect(sfc).not.toContain('id: "choose-provider"');
    expect(sfc).not.toContain('label: "选择 Provider"');
    expect(sfc).not.toContain('label: "切换 Provider"');
    expect(sfc).toContain("disabled: activeLaneBusy.value || resumeThreadBlocked.value");
    expect(sfc).toContain("mobileModelManagerRef.value?.create()");
    expect(sfc).not.toContain("打开项目");
  });

  it("hides duplicate lane session buttons on mobile", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).toContain('v-if="!isMobile && activeLaneHasResume"');
    expect(sfc).toContain('v-if="!isMobile"\n            class="laneTabIconBtn"');
  });

  it("keeps lane tab row free of duplicate warning banners", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).not.toContain('class="laneTabWarning"');
    expect(sfc).not.toContain('data-testid="lane-thread-warning"');
    expect(sfc).not.toContain("activeLaneThreadWarning");
  });
});
