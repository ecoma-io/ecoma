import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkPrimitiveArtifacts, findIncompletePrimitives } from "./check-primitive-artifacts.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const ROOT = "shared/libs/core-ui/src/primitives";

/** Every artifact a complete primitive carries. */
const complete = (name, dir = ROOT) => [
  `${dir}/${name}/${name}.vue`,
  `${dir}/${name}/${name}.test.ts`,
  `${dir}/${name}/${name}Demo.vue`,
  `${dir}/${name}/${name}.stories.ts`,
  `${dir}/${name}/${name}.mdx`,
];

describe("findIncompletePrimitives", () => {
  it("passes a primitive carrying all five artifacts", () => {
    expect(findIncompletePrimitives(complete("Button"))).toEqual([]);
  });

  it("names the missing test, the artifact nothing else in the toolchain notices is absent", () => {
    const files = complete("Dialog").filter((f) => !f.endsWith("Dialog.test.ts"));
    expect(findIncompletePrimitives(files)).toEqual([
      expect.stringContaining(`${ROOT}/Dialog: missing Dialog.test.ts`),
    ]);
  });

  it("reports every missing artifact of a primitive, not just the first", () => {
    expect(findIncompletePrimitives([`${ROOT}/Draft/Draft.vue`])).toHaveLength(4);
  });

  it("reports each incomplete primitive independently, leaving the complete ones alone", () => {
    const files = [...complete("Button"), `${ROOT}/Badge/Badge.vue`];
    const violations = findIncompletePrimitives(files);
    expect(violations.every((v) => v.includes("Badge"))).toBe(true);
    expect(violations).toHaveLength(4);
  });

  it("ignores an extra internal file a primitive happens to hold (e.g. ToastItem.vue)", () => {
    const files = [...complete("Toast"), `${ROOT}/Toast/ToastItem.vue`];
    expect(findIncompletePrimitives(files)).toEqual([]);
  });

  it("leaves blocks alone — they follow the same shape minus the mandatory test", () => {
    expect(
      findIncompletePrimitives(["shared/libs/core-ui/src/blocks/ToastStack/ToastStack.vue"]),
    ).toEqual([]);
  });

  it("recognises a primitive directory whether the scan runs from the repo root or from inside core-ui", () => {
    expect(findIncompletePrimitives(complete("Button", "src/primitives"))).toEqual([]);
    expect(findIncompletePrimitives(["src/primitives/Button/Button.vue"])).toHaveLength(4);
  });

  it("does not treat a nested directory under a primitive as a primitive of its own", () => {
    const files = [...complete("Button"), `${ROOT}/Button/parts/Label.vue`];
    expect(findIncompletePrimitives(files)).toEqual([]);
  });
});

describe("checkPrimitiveArtifacts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fails loudly, naming the primitive and the artifact it lacks", () => {
    vi.mocked(execFileSync).mockReturnValue(`${ROOT}/Badge/Badge.vue\n`);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(checkPrimitiveArtifacts()).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Badge.test.ts"));
  });

  it("passes a tree where every primitive is complete", () => {
    vi.mocked(execFileSync).mockReturnValue(`${complete("Button").join("\n")}\n`);
    expect(checkPrimitiveArtifacts()).toBe(0);
  });
});
