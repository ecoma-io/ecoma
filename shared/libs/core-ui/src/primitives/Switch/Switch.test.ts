import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import Switch from "./Switch.vue";

const control = (wrapper: ReturnType<typeof mount>) => wrapper.get('[role="switch"]');

describe("Switch", () => {
  it("carries role=switch with aria-checked so assistive tech reads it as a boolean setting, not a plain button", () => {
    const off = mount(Switch, {
      props: { modelValue: false },
      attrs: { "aria-label": "Tự động lưu" },
    });
    expect(control(off).attributes("aria-checked")).toBe("false");

    const on = mount(Switch, {
      props: { modelValue: true },
      attrs: { "aria-label": "Tự động lưu" },
    });
    expect(control(on).attributes("aria-checked")).toBe("true");
  });

  it("emits the flipped value on click instead of self-updating — the setting takes effect immediately, so the host owns the write", async () => {
    const wrapper = mount(Switch, {
      props: { modelValue: false },
      attrs: { "aria-label": "Tự động lưu" },
    });
    await control(wrapper).trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([[true]]);
    expect(control(wrapper).attributes("aria-checked")).toBe("false"); // not self-updated
  });

  it("emits false when switching a checked setting off", async () => {
    const wrapper = mount(Switch, {
      props: { modelValue: true },
      attrs: { "aria-label": "Tự động lưu" },
    });
    await control(wrapper).trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([[false]]);
  });

  it("defaults to off, so a setting never renders as enabled before the host supplies its value", () => {
    const wrapper = mount(Switch, { attrs: { "aria-label": "Tự động lưu" } });
    expect(control(wrapper).attributes("aria-checked")).toBe("false");
  });

  it("disabled makes the control inert to click and to keyboard, not merely dimmed", async () => {
    const wrapper = mount(Switch, {
      props: { modelValue: false, disabled: true },
      attrs: { "aria-label": "Tự động lưu" },
    });
    expect((control(wrapper).element as HTMLButtonElement).disabled).toBe(true);
    await control(wrapper).trigger("click");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("mirrors the model value into data-state, the hook the checked warp fill and the unchecked muted track both key on", async () => {
    const wrapper = mount(Switch, { props: { modelValue: false }, attrs: { "aria-label": "X" } });
    expect(control(wrapper).attributes("data-state")).toBe("unchecked");
    await wrapper.setProps({ modelValue: true });
    expect(control(wrapper).attributes("data-state")).toBe("checked");

    const classes = control(wrapper).classes();
    expect(classes).toContain("data-[state=checked]:bg-primary");
    expect(classes).toContain("data-[state=checked]:bg-primary");
    expect(classes).toContain("data-[state=unchecked]:bg-muted-foreground/30");
  });
});
