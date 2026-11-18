import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ReasoningEffortSlider from "../components/ReasoningEffortSlider.vue";

const options = [{ id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "max", label: "Max" }];

describe("reasoning effort slider", () => {
  it("previews without emitting, then commits exactly one configured value", async () => {
    const wrapper = mount(ReasoningEffortSlider, { props: { options, modelValue: "high" } });
    const slider = wrapper.get<HTMLInputElement>('input[type="range"]');
    slider.element.value = "2";
    await slider.trigger("input");
    expect(slider.attributes("aria-valuetext")).toBe("Max");
    expect(wrapper.emitted("change")).toBeUndefined();
    await slider.trigger("change");
    expect(wrapper.emitted("change")).toEqual([["max"]]);
    wrapper.unmount();
  });

  it("cancels a touch preview and tracks model and server changes", async () => {
    const wrapper = mount(ReasoningEffortSlider, { props: { options, modelValue: "high" } });
    const slider = wrapper.get<HTMLInputElement>("input");
    slider.element.value = "2";
    await slider.trigger("input");
    await slider.trigger("pointercancel");
    expect(slider.element.value).toBe("1");
    expect(wrapper.emitted("change")).toBeUndefined();
    await wrapper.setProps({ modelValue: "medium", options: options.slice(0, 2) });
    expect(slider.element.value).toBe("0");
    expect(slider.attributes("max")).toBe("1");
    expect(slider.attributes("aria-valuetext")).toBe("Medium");
    wrapper.unmount();
  });

  it.each([{ options, disabled: true }, { options: [options[1]], disabled: false }])("disables unavailable changes: %j", async props => {
    const wrapper = mount(ReasoningEffortSlider, { props: { ...props, modelValue: "high" } });
    const slider = wrapper.get<HTMLInputElement>("input");
    expect(slider.element.disabled).toBe(true);
    await slider.setValue("0");
    expect(wrapper.emitted("change")).toBeUndefined();
    wrapper.unmount();
  });
});
