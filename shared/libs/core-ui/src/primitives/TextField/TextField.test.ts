import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import TextField from "./TextField.vue";

describe("TextField", () => {
  it("emits the raw string on input so v-model tracks each keystroke", async () => {
    const wrapper = mount(TextField, { props: { ariaLabel: "Name" } });
    const input = wrapper.get("input");
    await input.setValue("hello");
    expect(wrapper.emitted("update:modelValue")).toEqual([["hello"]]);
  });

  it("marks the input aria-invalid only while invalid, so screen readers announce the error state and not merely the styling", () => {
    const valid = mount(TextField, { props: { ariaLabel: "Email" } });
    expect(valid.get("input").attributes("aria-invalid")).toBeUndefined();

    const invalid = mount(TextField, { props: { ariaLabel: "Email", invalid: true } });
    expect(invalid.get("input").attributes("aria-invalid")).toBe("true");
  });

  it("disables the underlying input so the field is inert to typing, not merely dimmed", () => {
    const wrapper = mount(TextField, { props: { ariaLabel: "Name", disabled: true } });
    expect((wrapper.get("input").element as HTMLInputElement).disabled).toBe(true);
  });

  it("renders leading and trailing adornments inside the field frame", () => {
    const wrapper = mount(TextField, {
      props: { ariaLabel: "Search" },
      slots: { leading: "🔍", trailing: "⌫" },
    });
    expect(wrapper.text()).toContain("🔍");
    expect(wrapper.text()).toContain("⌫");
  });
});
