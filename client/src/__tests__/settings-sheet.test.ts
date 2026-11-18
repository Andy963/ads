import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import SettingsSheet from "../components/SettingsSheet.vue";

describe("SettingsSheet navigation actions", () => {
  it("renders default Cancel button in top-left slot when closeLabel is omitted", () => {
    const wrapper = mount(SettingsSheet, {
      props: {
        title: "Default Sheet",
      },
      attachTo: document.body,
    });

    const cancelBtn = document.body.querySelector('[data-testid="sheet-cancel"]');
    expect(cancelBtn).not.toBeNull();
    expect(cancelBtn?.textContent?.trim()).toBe("Cancel");
    wrapper.unmount();
  });

  it("suppresses top-left button when closeLabel is empty", () => {
    const wrapper = mount(SettingsSheet, {
      props: {
        title: "Selector Sheet",
        closeLabel: "",
        actionLabel: "Done",
        actionTestId: "model-picker-done",
      },
      attachTo: document.body,
    });

    const cancelBtn = document.body.querySelector('[data-testid="sheet-cancel"]');
    expect(cancelBtn).toBeNull();

    const doneBtn = document.body.querySelector('[data-testid="model-picker-done"]');
    expect(doneBtn).not.toBeNull();
    expect(doneBtn?.textContent?.trim()).toBe("Done");
    expect(doneBtn?.classList.contains("sheetDone")).toBe(true);
    wrapper.unmount();
  });

  it("retains Cancel on top-left and Done on top-right when both are configured", () => {
    const wrapper = mount(SettingsSheet, {
      props: {
        title: "Edit Dialog",
        actionLabel: "Done",
        actionTestId: "provider-save",
      },
      attachTo: document.body,
    });

    const cancelBtn = document.body.querySelector('[data-testid="sheet-cancel"]');
    const doneBtn = document.body.querySelector('[data-testid="provider-save"]');
    expect(cancelBtn).not.toBeNull();
    expect(cancelBtn?.textContent?.trim()).toBe("Cancel");
    expect(doneBtn).not.toBeNull();
    expect(doneBtn?.textContent?.trim()).toBe("Done");
    wrapper.unmount();
  });
});
