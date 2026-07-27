import { RuleTester } from "eslint";
import rule from "./no-journey-markers.mjs";

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

ruleTester.run("no-journey-markers", rule, {
  valid: [
    "// strict open: rejects with the underlying CoreRequestError instead of silently scaffolding",
    "/** Each window owns exactly one project; ProjectService closes the previous one on open/create. */",
    "// cites invariant I2, I9 — architecture cross-reference, not a phase label",
    'describe("CommandPalette lists commands sourced from the command registry", () => {})',
    "// dialectVersion 1 payloads are rewritten to 2 on regenerate",
    'it.each([[1]])("renders row %s from the command registry", () => {})',
    'it.todo("persists the selected locale across restarts")',
    'suite("profile engine", () => {})',
    'ruleTester.run("no-journey-markers", rule, {})', // not a test global — helper API
  ],
  invalid: [
    {
      code: "// Strict open (REVIEW-UX-0.2 A3): rejects with the underlying CoreRequestError",
      errors: [{ messageId: "journeyMarker" }],
    },
    {
      code: "// The mf-asset:// protocol (D7, `docs/history/PLAN-0.2.md`)",
      errors: [{ messageId: "journeyMarker" }],
    },
    {
      code: '// This is what makes "each window = 1 project" (roadmap 0.1) real',
      errors: [{ messageId: "journeyMarker" }],
    },
    {
      code: "/** Vietnamese and English ship at 0.1. */",
      errors: [{ messageId: "journeyMarker" }],
    },
    {
      code: "/** Locales shipped at 0.1. English is the fallback. */",
      errors: [{ messageId: "journeyMarker" }],
    },
    {
      code: "// Inspector landed at 0.2 alongside the media settings pane",
      errors: [{ messageId: "journeyMarker" }],
    },
    {
      code: 'test("has no WCAG 2.1 A/AA violations (0.2 surface)", () => {})',
      errors: [{ messageId: "journeyMarker" }],
    },
    {
      code: 'describe("CommandPalette (REVIEW-UX-0.2 A10 — sourced from the command registry)", () => {})',
      errors: [{ messageId: "journeyMarker" }],
    },
    {
      code: 'it.each([[1]])("ships at 0.2 for case %s", () => {})',
      errors: [{ messageId: "journeyMarker" }],
    },
    {
      code: 'test.only.each([[1]])("lands at 0.3 for case %s", () => {})',
      errors: [{ messageId: "journeyMarker" }],
    },
    {
      code: 'describe.each([[1]])("roadmap 0.1 group %s", () => {})',
      errors: [{ messageId: "journeyMarker" }],
    },
    {
      code: 'it.each`a`("ships at 0.2", () => {})',
      errors: [{ messageId: "journeyMarker" }],
    },
    {
      code: 'test.for([[1]])("lands at 0.3 for case %s", () => {})',
      errors: [{ messageId: "journeyMarker" }],
    },
    {
      code: 'it.runIf(isLinux)("ships at 0.2", () => {})',
      errors: [{ messageId: "journeyMarker" }],
    },
    {
      code: 'it.todo("wire up the export path shipped at 0.4")',
      errors: [{ messageId: "journeyMarker" }],
    },
    {
      code: 'bench("sorts the palette (REVIEW-UX-0.2 A10)", () => {})',
      errors: [{ messageId: "journeyMarker" }],
    },
  ],
});

console.log("no-journey-markers: all cases passed");
