import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import Spinner from "./Spinner.vue";

describe("Spinner", () => {
  it("announces the wait via role=status and aria-label so screen readers don't need to see the SVG", () => {
    const wrapper = mount(Spinner, { props: { label: "Đang lưu" } });
    const status = wrapper.get('[role="status"]');
    expect(status.attributes("aria-label")).toBe("Đang lưu");
    expect(wrapper.get("svg").attributes("aria-hidden")).toBe("true");
  });

  it("defaults the label to a generic loading message when the caller doesn't provide one", () => {
    const wrapper = mount(Spinner);
    expect(wrapper.get('[role="status"]').attributes("aria-label")).toBe("Đang tải");
  });
});
