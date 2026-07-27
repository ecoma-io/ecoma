import { mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import Dialog from "./Dialog.vue";

let mounted: VueWrapper | undefined;

/** Mount attached to the DOM (Reka portals the panel out of the wrapper) and let the teleport settle. */
async function mountDialog(props: Record<string, unknown> = {}) {
  mounted = mount(Dialog, {
    props: { open: true, title: "Xoá quy trình", ...props },
    attachTo: document.body,
  });
  await nextTick();
  await nextTick();
  return mounted;
}

/** The content panel — queried off the document, never the wrapper, because it is portalled. */
const panel = () => document.querySelector<HTMLElement>('[role="dialog"]')!;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = "";
});

describe("Dialog", () => {
  it("widens the panel per size — md 32rem for a confirm, lg 44rem for a multi-section form, xl 64rem for an authoring surface", async () => {
    const widths: Record<string, string> = {
      md: "w-[min(92vw,32rem)]",
      lg: "w-[min(92vw,44rem)]",
      xl: "w-[min(94vw,64rem)]",
    };
    for (const [size, cls] of Object.entries(widths)) {
      await mountDialog({ size });
      expect([...panel().classList]).toContain(cls);
      mounted!.unmount();
      document.body.innerHTML = "";
    }
  });

  it("falls back to the confirm-box width when size is omitted, so a plain confirm never renders authoring-wide", async () => {
    await mountDialog();
    const classes = [...panel().classList];
    expect(classes).toContain("w-[min(92vw,32rem)]");
    expect(classes).not.toContain("w-[min(92vw,44rem)]");
    expect(classes).not.toContain("w-[min(94vw,64rem)]");
  });

  it("portals the panel to document.body rather than leaving it inside the caller's tree, so no ancestor overflow or stacking context can clip a modal", async () => {
    const wrapper = await mountDialog();
    expect(wrapper.element.contains(panel())).toBe(false);
    expect(panel().closest("body")).toBe(document.body);
  });

  it("names the dialog by its title so assistive tech announces what is being asked, not an unnamed modal", async () => {
    await mountDialog({ title: "Xoá quy trình" });
    const labelId = panel().getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent?.trim()).toBe("Xoá quy trình");
  });

  it("hideTitle removes the title from the visual layout but keeps it as the accessible name", async () => {
    await mountDialog({ title: "Bộ lọc", hideTitle: true });
    const labelId = panel().getAttribute("aria-labelledby")!;
    const titleEl = document.getElementById(labelId)!;
    expect(titleEl.textContent?.trim()).toBe("Bộ lọc");
    expect([...titleEl.classList]).toContain("sr-only");
  });

  it("wires a description as the dialog's accessible description instead of loose body text", async () => {
    await mountDialog({ description: "Hành động này không thể hoàn tác." });
    const describedBy = panel().getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent?.trim()).toBe(
      "Hành động này không thể hoàn tác.",
    );
  });

  it("offers the close affordance by default and drops it when closable is false (Esc and overlay click stay the caller's only exit then)", async () => {
    await mountDialog();
    expect(document.querySelector("[aria-label='Đóng']")).not.toBeNull();
    mounted!.unmount();
    document.body.innerHTML = "";

    await mountDialog({ closable: false });
    expect(document.querySelector("[aria-label='Đóng']")).toBeNull();
  });

  it("reports the close request upward instead of closing itself, so the host state stays the single source of truth", async () => {
    const wrapper = await mountDialog();
    document.querySelector<HTMLButtonElement>("[aria-label='Đóng']")!.click();
    await nextTick();
    expect(wrapper.emitted("update:open")).toEqual([[false]]);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull(); // still open — the host decides
  });

  it("renders no panel at all while closed — a modal must not sit in the DOM swallowing clicks", async () => {
    await mountDialog({ open: false });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
