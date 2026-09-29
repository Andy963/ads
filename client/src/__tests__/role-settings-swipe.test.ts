import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import RoleSettings from "../components/RoleSettings.vue";

const touch = (x: number, y: number, identifier = 1) => ({ clientX: x, clientY: y, identifier });
let wrapper: ReturnType<typeof mount>;
let mobile = true;

beforeEach(() => {
  mobile = true;
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("matchMedia", () => ({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup() {
  const profiles = ["acopilot", "developer", "reviewer"].map(role => ({ id: role, role, model_id: "m1", reasoning_effort: "high", system_prompt: role + " instructions" }));
  const api = {
    get: vi.fn(async (url: string) => structuredClone(url === "/api/role-profiles" ? profiles : [{ id: "m1", displayName: "Model", provider: "openai" }])),
    put: vi.fn(async () => profiles[0]),
  };
  wrapper = mount(RoleSettings, { props: { api: api as any }, global: { stubs: { teleport: true } } });
  await flushPromises();
  return api;
}
async function dispatch(target: Element, type: string, touches: ReturnType<typeof touch>[], changedTouches = touches) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { touches, changedTouches });
  target.dispatchEvent(event);
  await nextTick();
  return event;
}
async function swipe(target: Element, dx: number, dy = 0, x = 180) {
  await dispatch(target, "touchstart", [touch(x, 100)]);
  await dispatch(target, "touchmove", [touch(x + dx, 100 + dy)]);
  await dispatch(target, "touchend", [], [touch(x + dx, 100 + dy)]);
}
function activeRole() { return wrapper.get('.lanePromptLane[aria-pressed="true"]').text(); }

describe("role swipe navigation", () => {
  it("swipes through all three roles without wrapping and preserves unsaved drafts", async () => {
    const api = await setup();
    const bar = wrapper.get(".lanePromptLaneSelector").element;
    await wrapper.get("textarea").setValue("Unsaved Acopilot instructions");
    await swipe(bar, 100);
    expect(activeRole()).toBe("Acopilot");
    await swipe(bar, -100);
    expect(activeRole()).toBe("Developer");
    await wrapper.get("textarea").setValue("Unsaved Developer instructions");
    await swipe(bar, -100);
    expect(activeRole()).toBe("Reviewer");
    await swipe(bar, -100);
    expect(activeRole()).toBe("Reviewer");
    await swipe(bar, 100);
    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("Unsaved Developer instructions");
    await swipe(bar, 100);
    expect((wrapper.get("textarea").element as HTMLTextAreaElement).value).toBe("Unsaved Acopilot instructions");
    expect(api.put).not.toHaveBeenCalled();
  });

  it("ignores short drags, vertical scroll, diagonal motion and screen edges", async () => {
    await setup();
    const panel = wrapper.element;
    for (const [dx, dy, x] of [[-25, 0, 180], [-70, 100, 180], [-80, 70, 180], [100, 0, 10], [-100, 0, 380]]) {
      await swipe(panel, dx, dy, x);
      expect(activeRole()).toBe("Acopilot");
    }
    await dispatch(panel, "touchstart", [touch(180, 100)]);
    const vertical = await dispatch(panel, "touchmove", [touch(185, 130)]);
    expect(vertical.defaultPrevented).toBe(false);
    await dispatch(panel, "touchend", [], [touch(80, 130)]);
    expect(activeRole()).toBe("Acopilot");
  });

  it("keeps editor text-selection and form gestures native", async () => {
    await setup();
    await swipe(wrapper.get("textarea").element, -100);
    await swipe(wrapper.get('[data-testid="role-model-select"]').element, -100);
    expect(activeRole()).toBe("Acopilot");
    await swipe(wrapper.get(".settingsBlockTitle").element, -100);
    expect(activeRole()).toBe("Developer");
  });

  it("cancels multi-touch and touchcancel without switching roles", async () => {
    await setup();
    const panel = wrapper.element;
    await dispatch(panel, "touchstart", [touch(180, 100)]);
    await dispatch(panel, "touchmove", [touch(100, 100)]);
    await dispatch(panel, "touchcancel", []);
    await dispatch(panel, "touchend", [], [touch(80, 100)]);
    expect(activeRole()).toBe("Acopilot");
    await dispatch(panel, "touchstart", [touch(180, 100)]);
    await dispatch(panel, "touchstart", [touch(180, 100), touch(200, 100, 2)]);
    await dispatch(panel, "touchend", [], [touch(80, 100)]);
    expect(activeRole()).toBe("Acopilot");
  });

  it("suppresses a swipe's compatibility click without blocking a later intentional tap", async () => {
    await setup();
    const button = wrapper.get('[data-testid="lane-prompt-lane-acopilot"]');
    await swipe(button.element, -100);
    button.element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    await nextTick();
    expect(activeRole()).toBe("Developer");
    await dispatch(button.element, "touchstart", [touch(80, 100)]);
    await dispatch(button.element, "touchend", [], [touch(80, 100)]);
    await button.trigger("click");
    expect(activeRole()).toBe("Acopilot");
  });

  it("does not swipe while saving or while a model picker is open", async () => {
    const api = await setup();
    await wrapper.get('[data-testid="role-model-select"]').trigger("click");
    await swipe(wrapper.element, -100);
    expect(activeRole()).toBe("Acopilot");
    await wrapper.get('[data-testid="sheet-cancel"]').trigger("click");
    let finish!: () => void;
    api.put.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ id: "acopilot", role: "acopilot", model_id: "m1", reasoning_effort: "high", system_prompt: "Draft" }); }));
    await wrapper.get("textarea").setValue("Draft");
    await wrapper.get('[data-testid="lane-prompt-save"]').trigger("click");
    await swipe(wrapper.element, -100);
    expect(activeRole()).toBe("Acopilot");
    finish();
    await flushPromises();
  });

  it("leaves desktop touch interactions unchanged", async () => {
    mobile = false;
    await setup();
    await swipe(wrapper.element, -100);
    expect(activeRole()).toBe("Acopilot");
  });
});
