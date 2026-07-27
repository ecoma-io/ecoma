import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import Field from "./Field.vue";

// Integration tier, deliberately: only a real `InlineError` proves the error
// message actually reaches assistive tech as a live alert (`role="alert"`).
// Mocking `InlineError` here would remove that role entirely and leave the
// assertion pinning nothing; `Field.test.ts` covers Field's own logic
// (label/id pairing, required asterisk, hint-vs-error swap) against a mocked
// `InlineError`.
describe("Field", () => {
  it("surfaces its error message to assistive tech as a live alert", () => {
    const wrapper = mount(Field, {
      props: { label: "Email", for: "email-input", error: "Email không hợp lệ" },
    });
    expect(wrapper.get('[role="alert"]').text()).toContain("Email không hợp lệ");
  });
});
