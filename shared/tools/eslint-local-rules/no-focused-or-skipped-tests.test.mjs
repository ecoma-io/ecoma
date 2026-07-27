import { RuleTester } from "eslint";

import rule from "./no-focused-or-skipped-tests.mjs";

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

ruleTester.run("no-focused-or-skipped-tests", rule, {
  valid: [
    'it("renders", () => {})',
    'describe("group", () => {})',
    'it.todo("pending behaviour")', // sanctioned pending marker
    'test.each([1, 2])("case %i", () => {})',
    'it.each([[1]])("case %s", () => {})',
    'it.runIf(isLinux)("case", () => {})', // conditional run, no focus/skip flag
    "test.skip()", // Playwright: skip the rest at runtime (no title)
    'test.skip(browserName === "firefox", "flaky on firefox")', // conditional skip
    "obj.skip(10)", // not a test global — pagination-style API
    'pager.skip.each([1])("case", () => {})', // not a test global — chained non-test API
    "list.only", // member access, not a call
  ],
  invalid: [
    { code: 'it.only("renders", () => {})', errors: [{ messageId: "focusedTest" }] },
    { code: 'describe.only("group", () => {})', errors: [{ messageId: "focusedTest" }] },
    { code: 'it.skip("renders", () => {})', errors: [{ messageId: "skippedTest" }] },
    { code: 'describe.skip("group", () => {})', errors: [{ messageId: "skippedTest" }] },
    { code: 'test.concurrent.only("case", () => {})', errors: [{ messageId: "focusedTest" }] },
    { code: 'test.skip("named skip", () => {})', errors: [{ messageId: "skippedTest" }] },
    { code: 'it.only.each([[1]])("case %s", () => {})', errors: [{ messageId: "focusedTest" }] },
    { code: 'it.skip.each([[1]])("case %s", () => {})', errors: [{ messageId: "skippedTest" }] },
    {
      code: 'describe.only.each([[1]])("group %s", () => {})',
      errors: [{ messageId: "focusedTest" }],
    },
    { code: 'it.skip.each`a`("case", () => {})', errors: [{ messageId: "skippedTest" }] },
  ],
});

console.log("no-focused-or-skipped-tests: all cases passed");
