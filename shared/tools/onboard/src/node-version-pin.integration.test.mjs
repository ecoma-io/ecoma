import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readVersionPins, repoRoot, verGe } from "./setup.mjs";

/**
 * `.node-version` (the exact Node version this workspace develops and tests
 * on, read by actions/setup-node's `node-version-file` in
 * `.github/actions/setup/action.yml` and the repo-care workflows) and
 * `package.json`'s `engines.node` (the compatibility floor `setup.mjs`
 * checks a contributor's Node against) are two deliberately different facts
 * — see the comment above the "Version pins owned by the repo" section in
 * `setup.mjs`. Keeping both is defensible only as long as the exact pin
 * never drops below the floor it is supposed to satisfy; this test is what
 * catches that drift instead of leaving it to review.
 *
 * Reads the real repo-root files rather than a fixture — the interaction
 * being pinned IS the two real files agreeing, which is exactly what
 * justifies an integration test over a unit test here.
 */
describe(".node-version against package.json's engines.node floor", () => {
  it("the repo's exact .node-version pin still satisfies engines.node's floor", () => {
    const root = repoRoot();
    const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const { nodeMin } = readVersionPins(pkgJson);
    const pinned = readFileSync(join(root, ".node-version"), "utf8").trim();

    expect(verGe(pinned, nodeMin)).toBe(true);
  });
});
