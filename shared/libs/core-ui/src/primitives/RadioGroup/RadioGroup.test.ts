import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import RadioGroup, { type RadioOption } from "./RadioGroup.vue";

const options: RadioOption[] = [
  { value: "free", label: "Miễn phí" },
  { value: "pro", label: "Pro", description: "Không giới hạn dự án" },
  { value: "legacy", label: "Gói cũ", disabled: true },
];

describe("RadioGroup", () => {
  it("emits the clicked option's value", async () => {
    const wrapper = mount(RadioGroup, { props: { modelValue: "free", options } });
    const radios = wrapper.findAll('[role="radio"]');
    await radios[1].trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([["pro"]]);
  });

  it("renders every option's label and any description text", () => {
    const wrapper = mount(RadioGroup, { props: { modelValue: "free", options } });
    expect(wrapper.text()).toContain("Miễn phí");
    expect(wrapper.text()).toContain("Pro");
    expect(wrapper.text()).toContain("Không giới hạn dự án");
    expect(wrapper.text()).toContain("Gói cũ");
  });

  it("a disabled option is inert to clicks and stays out of the selection", async () => {
    const wrapper = mount(RadioGroup, { props: { modelValue: "free", options } });
    const legacyRadio = wrapper.findAll('[role="radio"]')[2];
    expect((legacyRadio.element as HTMLButtonElement).disabled).toBe(true);

    await legacyRadio.trigger("click");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("disabling the whole group makes every option inert", () => {
    const wrapper = mount(RadioGroup, { props: { modelValue: "free", options, disabled: true } });
    const radios = wrapper.findAll('[role="radio"]');
    for (const radio of radios) {
      expect((radio.element as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("marks the checked option's role=radio with aria-checked", () => {
    const wrapper = mount(RadioGroup, { props: { modelValue: "pro", options } });
    const radios = wrapper.findAll('[role="radio"]');
    expect(radios[0].attributes("aria-checked")).toBe("false");
    expect(radios[1].attributes("aria-checked")).toBe("true");
  });
});
