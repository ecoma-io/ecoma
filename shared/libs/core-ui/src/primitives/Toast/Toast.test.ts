import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import Toast from "./Toast.vue";

// Unit tier: the internal collaborator is isolated
// (local/no-unmocked-internal-imports). The stub keeps only the seam this
// file's own behavior is defined against — that `Toast` bundles a single
// provider/viewport pair and forwards its props to the card. What the card
// itself renders from those props (description, accent, action, close,
// auto-dismiss, region structure) is `ToastItem`'s own behavior, pinned
// against a real `ToastItem` in `Toast.integration.test.ts`.
vi.mock("./ToastItem.vue", () => ({
  default: {
    name: "ToastItem",
    props: ["open", "title", "description", "variant", "duration", "closable", "actionLabel"],
    emits: ["update:open", "action"],
    template: "<div />",
  },
}));

describe("Toast", () => {
  it("bundles exactly one provider/viewport so a lone toast works standalone", () => {
    const wrapper = mount(Toast, { props: { title: "Đã lưu" } });
    // ToastProvider/ToastViewport are real Reka UI, not mocked — only the
    // card (ToastItem) is stubbed above.
    expect(wrapper.findAll("ol")).toHaveLength(1);
    expect(wrapper.findComponent({ name: "ToastItem" }).exists()).toBe(true);
  });

  it("forwards its props through to the item unchanged", () => {
    const wrapper = mount(Toast, {
      props: {
        title: "Đã lưu",
        description: "Bản nháp đã được ghi.",
        variant: "ai",
        duration: 2000,
        closable: false,
        actionLabel: "Hoàn tác",
      },
    });
    expect(wrapper.findComponent({ name: "ToastItem" }).props()).toMatchObject({
      title: "Đã lưu",
      description: "Bản nháp đã được ghi.",
      variant: "ai",
      duration: 2000,
      closable: false,
      actionLabel: "Hoàn tác",
    });
  });
});
