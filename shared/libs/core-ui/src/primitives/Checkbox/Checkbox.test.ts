import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import Checkbox from "./Checkbox.vue";

type CheckboxProps = InstanceType<typeof Checkbox>["$props"];

describe("Checkbox", () => {
  it("emits the toggled value on click, flipping unchecked to checked", async () => {
    const wrapper = mount(Checkbox, { props: { modelValue: false, label: "Ghi nhớ" } });
    await wrapper.get('[role="checkbox"]').trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([[true]]);
  });

  it("moves out of indeterminate into checked on click, not back to unchecked", async () => {
    const wrapper = mount(Checkbox, {
      props: { modelValue: "indeterminate", label: "Chọn một phần" },
    });
    await wrapper.get('[role="checkbox"]').trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([[true]]);
  });

  it("disabled prevents any change from a click", async () => {
    const wrapper = mount(Checkbox, {
      props: { modelValue: false, disabled: true, label: "Vô hiệu hoá" },
    });
    await wrapper.get('[role="checkbox"]').trigger("click");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("marks the underlying control disabled so it is inert to keyboard input too", () => {
    const wrapper = mount(Checkbox, { props: { disabled: true, label: "Vô hiệu hoá" } });
    expect((wrapper.get('[role="checkbox"]').element as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders a checked indicator icon only while checked, not while unchecked", () => {
    const uncheckedWrapper = mount(Checkbox, { props: { modelValue: false, label: "X" } });
    expect(uncheckedWrapper.find("svg").exists()).toBe(false);

    const checkedWrapper = mount(Checkbox, { props: { modelValue: true, label: "X" } });
    expect(checkedWrapper.find("svg").exists()).toBe(true);
  });

  // Iconography's ≤12px rule: the 12px tick/dash must declare stroke-width
  // 2.5 rather than inherit the global 1.5, which would render 0.75 device px
  // and wash out against the filled box. Both branches of the template render
  // their own copy of the pair, so both are pinned — dropping the attribute on
  // either one is the exact drift this guards.
  const indicatorCases: { name: string; props: CheckboxProps }[] = [
    { name: "labelled + checked", props: { modelValue: true, label: "Đã chọn" } },
    {
      name: "labelled + indeterminate",
      props: { modelValue: "indeterminate", label: "Chọn một phần" },
    },
    { name: "bare + checked", props: { modelValue: true, ariaLabel: "Chọn hàng" } },
    {
      name: "bare + indeterminate",
      props: { modelValue: "indeterminate", ariaLabel: "Chọn hàng" },
    },
  ];
  it.each(indicatorCases)(
    "draws the 12px indicator glyph at the small-glyph stroke width ($name)",
    ({ props }) => {
      const wrapper = mount(Checkbox, { props });
      const glyph = wrapper.get("svg");
      expect(glyph.classes()).toContain("h-3"); // still the 12px box the rule applies to
      expect(glyph.attributes("stroke-width")).toBe("2.5");
    },
  );

  it("renders the visible label text inline instead of requiring a separate aria-label", () => {
    const wrapper = mount(Checkbox, { props: { modelValue: false, label: "Đồng ý điều khoản" } });
    expect(wrapper.text()).toContain("Đồng ý điều khoản");
  });

  it("names the control via aria-label when no visible label is given", () => {
    const wrapper = mount(Checkbox, { props: { modelValue: false, ariaLabel: "Chọn hàng" } });
    expect(wrapper.get('[role="checkbox"]').attributes("aria-label")).toBe("Chọn hàng");
  });
});
