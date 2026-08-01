import { describe, expect, it } from "vitest";

import { messages } from "./messages";

function leafKeys(value: object, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, entry]) =>
    typeof entry === "string" ? [prefix + key] : leafKeys(entry, `${prefix}${key}.`),
  );
}

const locales = Object.entries(messages).map(
  ([code, message]) => [code, leafKeys(message).sort()] as const,
);

describe("shell copy triads", () => {
  it("every locale carries the same message keys", () => {
    const canonical = locales[0];
    if (canonical == null) {
      throw new Error("messages must declare at least one locale");
    }
    expect(canonical[1].length).toBeGreaterThan(0);
    for (const [code, keys] of locales.slice(1)) {
      expect(keys, `locale ${code} diverges from ${canonical[0]}`).toEqual(canonical[1]);
    }
  });
});
