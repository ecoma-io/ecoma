import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import WindowControls from "./WindowControls.vue";

const button = (wrapper: ReturnType<typeof mount>, id: string) =>
  wrapper.get(`[data-testid="win-${id}"]`);

describe("WindowControls", () => {
  it("emits the window intent for each button instead of touching the platform — the host owns the bridge", async () => {
    const wrapper = mount(WindowControls);
    await button(wrapper, "minimize").trigger("click");
    await button(wrapper, "maximize").trigger("click");
    await button(wrapper, "close").trigger("click");
    expect(wrapper.emitted("minimize")).toHaveLength(1);
    expect(wrapper.emitted("maximize")).toHaveLength(1);
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("names each icon-only button so the cluster is operable by screen reader, not just by sight", () => {
    const wrapper = mount(WindowControls);
    expect(button(wrapper, "minimize").attributes("aria-label")).toBe("Minimize");
    expect(button(wrapper, "maximize").attributes("aria-label")).toBe("Maximize");
    expect(button(wrapper, "close").attributes("aria-label")).toBe("Close");
    expect(wrapper.findAll("svg").every((s) => s.attributes("aria-hidden") === "true")).toBe(true);
  });

  it("relabels the middle button to Restore while maximized, and swaps its glyph — one button, two states", async () => {
    const wrapper = mount(WindowControls, { props: { isMaximized: false } });
    const restoreGlyph = () => wrapper.get('[data-testid="win-maximize"]').findAll("path");
    expect(restoreGlyph()).toHaveLength(0);

    await wrapper.setProps({ isMaximized: true });
    expect(button(wrapper, "maximize").attributes("aria-label")).toBe("Restore");
    expect(restoreGlyph()).toHaveLength(1); // the overlapping-frames glyph
  });

  it("takes host-supplied labels so the chrome can be localised without forking the primitive", () => {
    const wrapper = mount(WindowControls, {
      props: {
        isMaximized: true,
        labels: {
          minimize: "Thu nhỏ",
          maximize: "Phóng to",
          restore: "Khôi phục",
          close: "Đóng",
        },
      },
    });
    expect(button(wrapper, "minimize").attributes("aria-label")).toBe("Thu nhỏ");
    expect(button(wrapper, "maximize").attributes("aria-label")).toBe("Khôi phục");
    expect(button(wrapper, "close").attributes("aria-label")).toBe("Đóng");
  });

  it("marks every control type=button so a control cluster inside a form never submits it", () => {
    const wrapper = mount(WindowControls);
    expect(wrapper.findAll("button").map((b) => b.attributes("type"))).toEqual([
      "button",
      "button",
      "button",
    ]);
  });

  it("reserves the destructive paint for close alone — the one OS affordance allowed without a confirm", () => {
    const wrapper = mount(WindowControls);
    expect(button(wrapper, "close").classes()).toContain("hover:bg-destructive");
    expect(button(wrapper, "minimize").classes()).not.toContain("hover:bg-destructive");
    expect(button(wrapper, "maximize").classes()).not.toContain("hover:bg-destructive");
  });
});
