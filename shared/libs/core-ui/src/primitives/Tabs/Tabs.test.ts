import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Tabs, { type TabItem } from "./Tabs.vue";

// jsdom has no ResizeObserver — TabsIndicator (via vueuse's useResizeObserver)
// degrades gracefully without one, but stub it anyway so a future indicator
// tweak that relies on a real observer doesn't fail silently here (same jsdom
// gap SegmentedControl/Slider tests stub around).
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

const tabs: TabItem[] = [
  { value: "overview", label: "Overview" },
  { value: "activity", label: "Activity" },
  { value: "settings", label: "Settings", disabled: true },
];

function mountTabs(modelValue: string) {
  return mount(Tabs, {
    props: { modelValue, tabs },
    slots: {
      overview: "Overview panel content",
      activity: "Activity panel content",
      settings: "Settings panel content",
    },
  });
}

describe("Tabs initial selection", () => {
  it("respects the initial modelValue by marking that trigger active and no other", () => {
    const wrapper = mountTabs("activity");
    const triggers = wrapper.findAll('[role="tab"]');
    expect(triggers[0]!.attributes("aria-selected")).toBe("false");
    expect(triggers[1]!.attributes("aria-selected")).toBe("true");
    expect(triggers[2]!.attributes("aria-selected")).toBe("false");
  });

  it("renders only the active panel's slot content, not inactive panels", () => {
    const wrapper = mountTabs("overview");
    expect(wrapper.text()).toContain("Overview panel content");
    expect(wrapper.text()).not.toContain("Activity panel content");
  });
});

describe("Tabs trigger activation", () => {
  it("emits the newly selected tab's value when a trigger is activated", async () => {
    const wrapper = mountTabs("overview");
    const triggers = wrapper.findAll('[role="tab"]');
    await triggers[1]!.trigger("mousedown", { button: 0 });

    expect(wrapper.emitted("update:modelValue")).toEqual([["activity"]]);
  });

  it("switches the rendered panel to match the newly active tab once the host echoes modelValue back", async () => {
    const wrapper = mountTabs("overview");
    await wrapper.setProps({ modelValue: "activity" });
    // Reka's TabsContent gates each panel's mount on an internal Presence
    // state machine (for animation support) that flips one microtask after
    // the `present` prop changes — flushPromises drains that transition.
    await flushPromises();

    expect(wrapper.text()).toContain("Activity panel content");
    expect(wrapper.text()).not.toContain("Overview panel content");
  });

  it("does not activate a disabled tab, so no selection change is emitted", async () => {
    const wrapper = mountTabs("overview");
    const triggers = wrapper.findAll('[role="tab"]');
    await triggers[2]!.trigger("mousedown", { button: 0 });

    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });
});
