import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import Select from "./Select.vue";

const options = [
  { value: "en", label: "English" },
  { value: "vi", label: "Tiếng Việt" },
];

describe("Select", () => {
  it("invalid paints the destructive border and sets aria-invalid on the trigger — same error language as TextField, so a Field-reported error can reach the control", () => {
    const wrapper = mount(Select, {
      props: { options, invalid: true },
      attrs: { "aria-label": "Ngôn ngữ" },
    });
    const trigger = wrapper.get("button");
    expect(trigger.attributes("aria-invalid")).toBe("true");
    expect(trigger.classes()).toContain("border-destructive");
  });

  it("stays quiet (no destructive border, no aria-invalid) when valid", () => {
    const wrapper = mount(Select, { props: { options }, attrs: { "aria-label": "Ngôn ngữ" } });
    const trigger = wrapper.get("button");
    expect(trigger.attributes("aria-invalid")).toBeUndefined();
    expect(trigger.classes()).not.toContain("border-destructive");
  });

  it("matches TextField's height scale per size so mixed form rows align (sm 32px, md 36px default, lg 44px)", () => {
    const heights: Record<string, string> = { sm: "h-8", md: "h-9", lg: "h-11" };
    for (const [size, cls] of Object.entries(heights)) {
      const wrapper = mount(Select, {
        props: { options, size: size as "sm" | "md" | "lg" },
        attrs: { "aria-label": "Ngôn ngữ" },
      });
      expect(wrapper.get("button").classes()).toContain(cls);
    }
    const fallback = mount(Select, { props: { options }, attrs: { "aria-label": "Ngôn ngữ" } });
    expect(fallback.get("button").classes()).toContain("h-9");
  });
});
