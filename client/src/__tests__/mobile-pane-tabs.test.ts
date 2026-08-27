import { describe, it, expect } from "vitest";
import { readSfc } from "./readSfc";

describe("mobile navigation shell", () => {
  it("renders Task, Advisor, and Worker in one shared mobile workspace tab shell", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).toContain('const chatLanes: Array<{ id: ChatLane; label: string }> = [');
    expect(sfc).toContain('{ id: "planner", label: "Advisor" }');
    expect(sfc).toContain('{ id: "worker", label: "Worker" }');
    expect(sfc).toContain('{ id: "tasks", label: "Task" }');
    expect(sfc).toMatch(/isMobile\.value \? \[\{ id: "tasks", label: "Task" \}, \.\.\.chatLanes\]/);
    expect(sfc).not.toContain('{ id: "reviewer", label: "Reviewer" }');
    expect(sfc).toMatch(/<div class="laneTabs"[^>]*role="tablist"[^>]*>/);
  });

  it("shows only the active lane panel and binds panel visibility to the shared active tab state", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).toMatch(/v-show="activeWorkspaceTab === 'planner'"/);
    expect(sfc).toMatch(/v-show="activeWorkspaceTab === 'worker'"/);
    expect(sfc).toMatch(/v-show="activeWorkspaceTab === 'tasks'"/);
    expect(sfc).not.toMatch(/v-show="activeWorkspaceTab === 'reviewer'"/);
    expect(sfc).toMatch(/:class="\{ active: activeWorkspaceTab === tab.id \}"/);
    expect(sfc).toMatch(/:aria-selected="activeWorkspaceTab === tab.id"/);
  });

  it("uses a vertical module drawer with module-specific subitems", async () => {
    const sfc = await readSfc("../App.vue", import.meta.url);
    expect(sfc).toContain('data-testid="mobile-drawer-toggle"');
    expect(sfc).toContain('data-testid="mobile-drawer-section-projects"');
    expect(sfc).toContain('data-testid="mobile-drawer-section-rules"');
    expect(sfc).toContain('data-testid="mobile-drawer-section-models"');
    expect(sfc).toContain("<span>Provider</span>");
    expect(sfc).toContain('class="mobileDrawerSubitems"');
    expect(sfc).toContain('v-for="group in MODEL_AGENT_GROUPS"');
    expect(sfc).toContain(':data-testid="`mobile-drawer-model-${group.kind}`"');
    expect(sfc).toContain('class="mobileMainPanel"');
    expect(sfc).toContain(':show-add-button="false"');
    expect(sfc).toContain('v-if="!isMobile && p.expanded"');
    expect(sfc).toContain('class="lanePanel taskLanePanel"');
    expect(sfc).toContain('class="mobileTaskWorkspace"');
    expect(sfc).toContain('v-if="mobileDrawerSection === \'rules\'"');
    expect(sfc).toContain(':agent="mobileModelAgent"');
    expect(sfc).toContain("flex-direction: column");
    expect(sfc).toContain('v-if="!isMobile && p.id === \'default\'"');
    expect(sfc).toContain(':show-create-button="!isMobile"');
    expect(sfc).toContain('id: "create-task"');
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
    expect(sfc).toContain('id: "create-rule"');
    expect(sfc).toContain('id: "refresh-rules"');
    expect(sfc).toContain('id: "create-model"');
    expect(sfc).toContain('id: "refresh-models"');
    expect(sfc).toContain('id: "choose-provider"');
    expect(sfc).not.toContain('label: "选择 Provider"');
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
