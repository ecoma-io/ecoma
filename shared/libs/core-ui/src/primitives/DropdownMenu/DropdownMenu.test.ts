import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import DropdownMenu, { type DropdownMenuEntry } from "./DropdownMenu.vue";

// jsdom has no ResizeObserver — Reka's popper measures with one (same jsdom gap
// the Tabs/Slider/SegmentedControl tests stub around).
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

const ITEMS: DropdownMenuEntry[] = [
  { heading: true, label: "Tệp" },
  { label: "Mở", value: "open", shortcut: "⌘O" },
  { label: "Lưu", value: "save", disabled: true },
  { separator: true },
  { label: "Xoá", value: "delete", danger: true },
];

let mounted: VueWrapper | undefined;

async function mountMenu(props: Record<string, unknown> = {}) {
  mounted = mount(DropdownMenu, {
    props: { items: ITEMS, open: true, ...props },
    slots: { trigger: '<button type="button">Hành động</button>' },
    attachTo: document.body,
  });
  await nextTick();
  await nextTick();
  return mounted;
}

/** The menu is portalled — query the document, never the wrapper. */
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = "";
});

describe("DropdownMenu", () => {
  it("renders only actionable entries as menu items — a heading and a separator are chrome, not commands", async () => {
    await mountMenu();
    expect(items().map((el) => el.querySelector("span")!.textContent!.trim())).toEqual([
      "Mở",
      "Lưu",
      "Xoá",
    ]);
    expect(menu()!.textContent).toContain("Tệp"); // the heading still renders, just not as a command
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(1);
  });

  it("shows an accelerator hint only on the entry that declares one, so the column stays meaningful", async () => {
    await mountMenu();
    expect(items()[0].textContent).toContain("⌘O");
    expect(items()[1].querySelectorAll("span")).toHaveLength(1); // label only, no empty shortcut slot
  });

  it("emits the selected entry's command id so the host maps it to an action and the primitive stays free of app logic", async () => {
    const wrapper = await mountMenu();
    items()[0].click();
    await nextTick();
    expect(wrapper.emitted("select")).toEqual([["open"]]);
  });

  it("keeps a disabled entry inert — it is marked disabled for assistive tech and selects nothing", async () => {
    const wrapper = await mountMenu();
    const disabled = items()[1];
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    disabled.click();
    await nextTick();
    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("paints a danger entry in the destructive token so a destructive command is not one indistinguishable row", async () => {
    await mountMenu();
    expect([...items()[2].classList]).toContain("text-destructive");
    expect([...items()[0].classList]).not.toContain("text-destructive");
  });

  it("keeps the menu unmounted while closed, so a command list never sits in the DOM catching clicks", async () => {
    await mountMenu({ open: false });
    expect(menu()).toBeNull();
  });

  it("reports open changes upward instead of closing itself, so the host can drive the menu", async () => {
    const wrapper = await mountMenu({ open: undefined });
    wrapper.get("button").element.click();
    await nextTick();
    expect(wrapper.emitted("update:open")).toEqual([[true]]);
  });

  it("staggers the rows as the menu opens, capped so a long list does not trail in indefinitely", async () => {
    await mountMenu();
    const delays = items().map((el) => el.style.animationDelay);
    expect(delays[0]).toBe("24ms"); // index 1 in the entry list (the heading is index 0)
    expect(items().every((el) => [...el.classList].includes("animate-fade-rise"))).toBe(true);

    const long = Array.from({ length: 9 }, (_, i) => ({ label: `#${i}`, value: `${i}` }));
    mounted!.unmount();
    document.body.innerHTML = "";
    await mountMenu({ items: long });
    expect(items().at(-1)!.style.animationDelay).toBe("120ms"); // capped at index 5
  });
});
