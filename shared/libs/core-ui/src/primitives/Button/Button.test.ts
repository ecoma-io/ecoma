import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import Button from "./Button.vue";

describe("Button", () => {
  it("a loading button is disabled even when the disabled prop itself is false (shimmer sweep, never a clickable dead state)", () => {
    const wrapper = mount(Button, {
      props: { loading: true, disabled: false },
      slots: { default: "Save" },
    });
    const button = wrapper.get("button").element as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("is enabled by default (neither disabled nor loading)", () => {
    const wrapper = mount(Button, { slots: { default: "Save" } });
    const button = wrapper.get("button").element as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("announces busy state and swaps which content layer assistive tech sees: idle exposes the label, loading exposes the loading text (opacity alone would leave both audible)", async () => {
    const wrapper = mount(Button, {
      props: { loading: false, loadingText: "Đang lưu…" },
      slots: { default: "Lưu" },
    });
    const layerOf = (text: string) =>
      wrapper.findAll("span").find((s) => s.text() === text && s.element.children.length === 0)!
        .element.parentElement!;

    expect(wrapper.get("button").attributes("aria-busy")).toBeUndefined();
    expect(layerOf("Đang lưu…").getAttribute("aria-hidden")).toBe("true");

    await wrapper.setProps({ loading: true });
    expect(wrapper.get("button").attributes("aria-busy")).toBe("true");
    expect(layerOf("Đang lưu…").getAttribute("aria-hidden")).toBeNull();
    const label = wrapper.findAll("span").find((s) => s.text() === "Lưu")!;
    expect(label.attributes("aria-hidden")).toBe("true");
  });

  it("keeps both the label and the loading layer mounted across the swap so the button never changes width mid-transition", async () => {
    const wrapper = mount(Button, {
      props: { loading: false, loadingText: "Đang lưu…" },
      slots: { default: "Lưu" },
    });
    expect(wrapper.text()).toContain("Lưu");
    expect(wrapper.text()).toContain("Đang lưu…");
    await wrapper.setProps({ loading: true });
    expect(wrapper.text()).toContain("Lưu");
    expect(wrapper.text()).toContain("Đang lưu…");
  });

  it("renders the progress arc without any loading text when loadingText is omitted (spinner-only layer, width still reserved by the label)", () => {
    const wrapper = mount(Button, { props: { loading: true }, slots: { default: "Lưu" } });
    expect(wrapper.find("svg").exists()).toBe(true);
    expect(wrapper.text()).toBe("Lưu");
  });

  it("dims only a genuinely disabled button — a loading button stays at full opacity so it reads as working, not unavailable", async () => {
    const wrapper = mount(Button, { props: { loading: true }, slots: { default: "Lưu" } });
    expect(wrapper.get("button").classes()).not.toContain("opacity-50");
    await wrapper.setProps({ loading: false, disabled: true });
    expect(wrapper.get("button").classes()).toContain("opacity-50");
  });

  it("keeps every icon size square and at or above the 24px minimum target, so a dense row never shrinks the hit area below what a pointer can land on", () => {
    // Tailwind's h-N/w-N are N*4 px. The assertion is that no icon size drops
    // under the WCAG 2.2 SC 2.5.8 floor and that every one stays square.
    const sizes = [
      { size: "icon", steps: 9 },
      { size: "icon-sm", steps: 8 },
    ] as const;
    for (const { size, steps } of sizes) {
      const classes = mount(Button, { props: { size }, slots: { default: "×" } }).classes();
      expect(classes).toContain(`h-${String(steps)}`);
      expect(classes).toContain(`w-${String(steps)}`);
      expect(steps * 4).toBeGreaterThanOrEqual(24);
    }
  });
});
