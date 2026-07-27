import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import EmptyState from "./EmptyState.vue";

const SLOTS = {
  icon: "<svg data-testid='glyph' />",
  action: '<button type="button">Tạo quy trình</button>',
};

describe("EmptyState", () => {
  it("hides the icon from assistive tech, since the title already carries the meaning", () => {
    const wrapper = mount(EmptyState, { props: { title: "Chưa có quy trình nào" }, slots: SLOTS });
    const medallion = wrapper.get("[data-testid='glyph']").element.parentElement as HTMLElement;

    expect(medallion.getAttribute("aria-hidden")).toBe("true");
  });

  it("sizes the glyph at the emphasis step of the icon scale rather than blowing it up to fill the empty region", () => {
    const wrapper = mount(EmptyState, { props: { title: "Chưa có quy trình nào" }, slots: SLOTS });
    const medallion = wrapper.get("[data-testid='glyph']").element.parentElement as HTMLElement;

    // 20px is the "nhấn mạnh / empty state" step in Design System ›
    // Iconography. The hairline medallion is what gives a 20px stroke
    // something to sit against — without it a lone glyph in a large blank
    // region reads as a stray mark, which is what invites oversizing it.
    expect(medallion.className).toContain("[&_svg]:h-5");
    expect(medallion.className).toContain("rounded-full");
    expect(medallion.className).toContain("border-border");
  });

  it("renders no icon or action region at all when the host slots neither, so the block never reserves empty space", () => {
    const wrapper = mount(EmptyState, { props: { title: "Chưa có quy trình nào" } });

    expect(wrapper.find("svg").exists()).toBe(false);
    expect(wrapper.find("button").exists()).toBe(false);
    expect(wrapper.text()).toBe("Chưa có quy trình nào");
  });

  it("staggers the entrance so the parts arrive in reading order instead of appearing at once", () => {
    const wrapper = mount(EmptyState, {
      props: { title: "Chưa có quy trình nào", description: "Tạo quy trình đầu tiên." },
      slots: SLOTS,
    });

    // Icon → title → description → CTA, 60ms apart. This is content appearing,
    // not feedback for an action, so it budgets like a panel (Motion ›
    // staggered reveal) rather than against the 200ms interaction ceiling.
    const delays = wrapper
      .findAll(".animate-fade-rise")
      .map((el) => (el.element as HTMLElement).style.animationDelay);
    expect(delays).toEqual(["", "60ms", "120ms", "180ms"]);
  });
});
