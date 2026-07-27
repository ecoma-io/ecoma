import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import SegmentedControl, { type SegmentedControlOption } from "./SegmentedControl.vue";

// jsdom has no ResizeObserver — the sliding indicator observes the checked
// segment (same jsdom gap the Tabs/Slider tests stub around).
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const OPTIONS: SegmentedControlOption[] = [
  { value: "compact", label: "Gọn" },
  { value: "cozy", label: "Vừa", testId: "density-cozy" },
  { value: "roomy", label: "Rộng", disabled: true },
];

const segments = (wrapper: ReturnType<typeof mount>) => wrapper.findAll('[role="radio"]');

describe("SegmentedControl", () => {
  it("exposes the options as a single-choice radio group so arrow keys move between them, not Tab", () => {
    const wrapper = mount(SegmentedControl, {
      props: { options: OPTIONS, modelValue: "compact" },
      attrs: { "aria-label": "Mật độ" },
    });
    expect(wrapper.get('[role="radiogroup"]').attributes("aria-orientation")).toBe("horizontal");
    expect(segments(wrapper).map((s) => s.text())).toEqual(["Gọn", "Vừa", "Rộng"]);
  });

  it("marks exactly the model value as checked, so one option is always the active one", () => {
    const wrapper = mount(SegmentedControl, {
      props: { options: OPTIONS, modelValue: "cozy" },
      attrs: { "aria-label": "Mật độ" },
    });
    expect(segments(wrapper).map((s) => s.attributes("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
  });

  it("emits the picked value as a string instead of self-updating — the host owns the setting", async () => {
    const wrapper = mount(SegmentedControl, {
      props: { options: OPTIONS, modelValue: "compact" },
      attrs: { "aria-label": "Mật độ" },
    });
    await segments(wrapper)[1].trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([["cozy"]]);
  });

  it("keeps a per-option disabled segment inert while its neighbours stay pickable", async () => {
    const wrapper = mount(SegmentedControl, {
      props: { options: OPTIONS, modelValue: "compact" },
      attrs: { "aria-label": "Mật độ" },
    });
    await segments(wrapper)[2].trigger("click");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect((segments(wrapper)[2].element as HTMLButtonElement).disabled).toBe(true);
    expect((segments(wrapper)[1].element as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables the whole control when the group is disabled, not just its paint", async () => {
    const wrapper = mount(SegmentedControl, {
      props: { options: OPTIONS, modelValue: "compact", disabled: true },
      attrs: { "aria-label": "Mật độ" },
    });
    await segments(wrapper)[1].trigger("click");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    expect(segments(wrapper).every((s) => (s.element as HTMLButtonElement).disabled)).toBe(true);
  });

  it("compresses padding and type in the sm form for dense chrome, and uses the roomier default otherwise", () => {
    const dense = mount(SegmentedControl, {
      props: { options: OPTIONS, modelValue: "compact", size: "sm" },
      attrs: { "aria-label": "Mật độ" },
    });
    expect(segments(dense)[0].classes()).toContain("text-[11px]");

    const roomy = mount(SegmentedControl, {
      props: { options: OPTIONS, modelValue: "compact" },
      attrs: { "aria-label": "Mật độ" },
    });
    expect(segments(roomy)[0].classes()).toContain("text-sm");
    expect(segments(roomy)[0].classes()).toContain("px-3");
  });

  it("forwards an option's test id to its segment so hosts keep a stable hook onto one choice", () => {
    const wrapper = mount(SegmentedControl, {
      props: { options: OPTIONS, modelValue: "compact" },
      attrs: { "aria-label": "Mật độ" },
    });
    expect(wrapper.get('[data-testid="density-cozy"]').text()).toBe("Vừa");
  });

  it("hides the sliding indicator while nothing is checked, instead of parking it over the first segment", async () => {
    const wrapper = mount(SegmentedControl, {
      props: { options: OPTIONS },
      attrs: { "aria-label": "Mật độ" },
      attachTo: document.body,
    });
    await nextTick();
    const indicator = wrapper.get('[aria-hidden="true"]');
    expect(indicator.attributes("style")).toContain("opacity: 0");
    wrapper.unmount();
  });

  it("disconnects its resize observer on unmount so a removed control leaves no live observer behind", () => {
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect = disconnect;
      },
    );
    const wrapper = mount(SegmentedControl, {
      props: { options: OPTIONS, modelValue: "compact" },
      attrs: { "aria-label": "Mật độ" },
    });
    disconnect.mockClear();
    wrapper.unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
