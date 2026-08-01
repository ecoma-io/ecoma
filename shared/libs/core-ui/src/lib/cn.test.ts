import { describe, expect } from "vitest";
import { fc, test } from "@fast-check/vitest";
import { cn } from "./cn";

// The input space cn() must survive: every ClassValue clsx accepts — null,
// undefined, booleans, numbers, arbitrary strings (whitespace, unicode,
// Tailwind-adjacent garbage), nested arrays.
const classValue = fc.oneof(
  fc.constantFrom(null, undefined, false, true, 0),
  fc.string(),
  fc.array(fc.oneof(fc.string(), fc.constantFrom(null, undefined, false, true, 0))),
);

describe("cn class merging", () => {
  test.prop([fc.array(classValue)])(
    "is total: arbitrary input never throws and always yields a string",
    (inputs) => {
      expect(typeof cn(...inputs)).toBe("string");
    },
  );

  test.prop([fc.array(classValue)])(
    "is idempotent: re-merging the merged result leaves it unchanged",
    (inputs) => {
      const merged = cn(...inputs);
      expect(cn(merged)).toBe(merged);
    },
  );

  // The design system leans on passthrough for unrecognized tokens — e.g.
  // arbitrary-property utilities like `[transition:color,background-color]`
  // that Tailwind v4 does not compile bare must still reach the DOM.
  test.prop([fc.stringMatching(/^\S+$/)])(
    "keeps a lone space-free token untouched, whatever it looks like",
    (token) => {
      expect(cn(token)).toBe(token);
    },
  );

  test("drops falsy inputs: an all-falsy call produces an empty string", () => {
    expect(cn()).toBe("");
    expect(cn(null, undefined, false, 0, "")).toBe("");
  });
});
