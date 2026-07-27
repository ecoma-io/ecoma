import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import Popover from "./Popover.vue";

// jsdom has no ResizeObserver — Reka measures the arrow with one (same jsdom
// gap the Tabs/Slider/SegmentedControl tests stub around).
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

let mounted: VueWrapper | undefined;

/** The trigger is rendered `as-child`, so the caller's own button IS the trigger. */
const TRIGGER = '<button type="button">Bộ lọc</button>';

async function mountPopover(props: Record<string, unknown> = {}) {
  mounted = mount(Popover, {
    props,
    slots: { trigger: TRIGGER, default: "<p>Nội dung bảng</p>" },
    attachTo: document.body,
  });
  await nextTick();
  await nextTick();
  return mounted;
}

/** The panel is portalled — query the document, never the wrapper. */
const panel = () => document.querySelector<HTMLElement>('[role="dialog"]');

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = "";
});

describe("Popover", () => {
  it("keeps the panel unmounted while closed, so secondary content is opt-in rather than always in the page", async () => {
    await mountPopover();
    expect(panel()).toBeNull();
    expect(document.body.textContent).not.toContain("Nội dung bảng");
  });

  it("opens on a trigger click and portals the panel out of the caller's tree, past any clipping ancestor", async () => {
    const wrapper = await mountPopover();
    await wrapper.get("button").trigger("click");
    await nextTick();
    expect(panel()!.textContent).toContain("Nội dung bảng");
    expect(wrapper.element.contains(panel())).toBe(false);
  });

  it("wires the trigger's expanded state so assistive tech knows the panel is open, and reports the change upward", async () => {
    const wrapper = await mountPopover();
    const trigger = wrapper.get("button");
    expect(trigger.attributes("aria-expanded")).toBe("false");

    await trigger.trigger("click");
    await nextTick();
    expect(trigger.attributes("aria-expanded")).toBe("true");
    expect(trigger.attributes("aria-controls")).toBe(panel()!.id);
    expect(wrapper.emitted("update:open")).toEqual([[true]]);
  });

  it("renders the caller's own element as the trigger — no wrapper element swallows its accessible name", async () => {
    const wrapper = await mountPopover();
    expect(document.querySelectorAll("button")).toHaveLength(1);
    expect(wrapper.get("button").attributes("data-state")).toBe("closed");
  });

  it("places the panel below the trigger by default, the side a filter or details card is expected on", async () => {
    await mountPopover({ open: true });
    expect(panel()!.getAttribute("data-side")).toBe("bottom");
  });

  it("honours an explicit side so a panel near the viewport edge can be anchored deliberately", async () => {
    await mountPopover({ open: true, side: "right" });
    expect(panel()!.getAttribute("data-side")).toBe("right");
  });

  it("shows the pointer notch by default and drops it when the panel reads better flush", async () => {
    await mountPopover({ open: true });
    expect(panel()!.querySelector("svg")).not.toBeNull();
    mounted!.unmount();
    document.body.innerHTML = "";

    await mountPopover({ open: true, arrow: false });
    expect(panel()!.querySelector("svg")).toBeNull();
  });
});
