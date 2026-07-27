import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import Tooltip from "./Tooltip.vue";

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
const TRIGGER = '<button type="button" aria-label="Xoá">X</button>';

async function mountTooltip(props: Record<string, unknown> = {}) {
  mounted = mount(Tooltip, {
    props: { content: "Xoá vĩnh viễn", ...props },
    slots: { trigger: TRIGGER },
    attachTo: document.body,
  });
  await nextTick();
  await nextTick();
  return mounted;
}

/** The tip is portalled — query the document, never the wrapper. */
const tip = () => document.querySelector<HTMLElement>('[role="tooltip"]');

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = "";
});

describe("Tooltip", () => {
  it("keeps the tip out of the DOM until it is opened, so a hint never sits in the page as stray text", async () => {
    await mountTooltip();
    expect(tip()).toBeNull();
    expect(document.body.textContent).not.toContain("Xoá vĩnh viễn");
  });

  it("shows the content when opened and portals it out of the caller's tree", async () => {
    const wrapper = await mountTooltip({ open: true });
    expect(tip()).not.toBeNull();
    expect(tip()!.textContent).toContain("Xoá vĩnh viễn");
    expect(wrapper.element.contains(tip())).toBe(false);
  });

  it("describes the trigger rather than naming it — a tip supplements an accessible name, it must never be the only source of one", async () => {
    await mountTooltip({ open: true });
    const trigger = document.querySelector<HTMLElement>("button[aria-label='Xoá']")!;
    expect(trigger.getAttribute("aria-describedby")).toBeTruthy();
    expect(trigger.getAttribute("aria-labelledby")).toBeNull();
    expect(trigger.getAttribute("aria-label")).toBe("Xoá"); // the caller's own name survives as-child
  });

  it("renders the caller's own element as the trigger instead of wrapping it, so no wrapper swallows its accessible name", async () => {
    const wrapper = await mountTooltip();
    const trigger = wrapper.get("button");
    expect(document.querySelectorAll("button")).toHaveLength(1); // no wrapper button was added
    expect(trigger.attributes("data-state")).toBe("closed"); // Reka's trigger props land on the caller's own element
    expect(trigger.attributes("aria-label")).toBe("Xoá");
  });

  it("prefers the default slot over the content prop, so rich hint markup is not silently dropped", async () => {
    mounted = mount(Tooltip, {
      props: { content: "prop text", open: true },
      slots: { trigger: TRIGGER, default: "<em>slot text</em>" },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();
    expect(tip()!.textContent).toContain("slot text");
    expect(tip()!.textContent).not.toContain("prop text");
  });

  it("reports open changes upward so a host can drive the tip (e.g. an onboarding hint) instead of only hover", async () => {
    const wrapper = await mountTooltip();
    await wrapper.get("button").trigger("focus");
    await nextTick();
    expect(wrapper.emitted("update:open")).toEqual([[true]]);
  });
});
