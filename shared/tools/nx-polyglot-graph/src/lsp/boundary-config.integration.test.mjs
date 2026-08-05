/**
 * The config reader against a real file that really changes.
 *
 * Integration rather than unit, and the tier is the point: the behaviour being
 * pinned IS the ESM module cache, which only exists in a process that outlives
 * the edit. A mocked `import()` would agree with any implementation.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readBoundaryConfig } from "./boundary-config.mjs";

const config = (tag) => `
export const depConstraints = [
  { sourceTag: ${JSON.stringify(tag)}, onlyDependOnLibsWithTags: ["zone:inner"] },
];
export const moduleBoundaryOptions = {
  allow: [],
  buildTargets: ["build"],
  enforceBuildableLibDependency: false,
  allowCircularSelfDependency: false,
  checkDynamicDependenciesExceptions: [],
  ignoredCircularDependencies: [],
  banTransitiveDependencies: false,
  checkNestedExternalImports: false,
};
`;

let root;
const write = (text) => writeFileSync(join(root, "module-boundaries.config.mjs"), text, "utf8");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nx-polyglot-graph-config-"));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("reading a boundary config that outlives the process reading it", () => {
  it("re-reads the file at a new revision, which is why a config change can re-diagnose", () => {
    // Without the revision, `import()` hands back the module it memoised when
    // the editor opened, and the server re-diagnoses every open file against a
    // constraint table that no longer exists — while looking like it refreshed.
    write(config("zone:first"));

    return readBoundaryConfig(root, 0).then((first) => {
      expect(first.depConstraints[0].sourceTag).toBe("zone:first");
      write(config("zone:second"));

      return Promise.all([readBoundaryConfig(root, 0), readBoundaryConfig(root, 1)]).then(
        ([sameRevision, nextRevision]) => {
          // The same revision is the memoised module — deliberately, so a
          // diagnosis of ten open files pays for one load, not ten.
          expect(sameRevision.depConstraints[0].sourceTag).toBe("zone:first");
          expect(nextRevision.depConstraints[0].sourceTag).toBe("zone:second");
        },
      );
    });
  });

  it("refuses a malformed table rather than enforcing the half of it that parsed", async () => {
    // The validation is `../config.mjs`'s, reached rather than restated: two
    // answers to "is this table well-formed" would disagree the day one moved.
    write(`
      export const depConstraints = [{ sourceTags: "typo" }];
      export const moduleBoundaryOptions = {};
    `);

    await expect(readBoundaryConfig(root, 2)).rejects.toThrow(/is malformed/u);
  });

  it("names the file it could not load, since a missing law enforces nothing silently", async () => {
    const empty = mkdtempSync(join(tmpdir(), "nx-polyglot-graph-config-empty-"));
    try {
      await expect(readBoundaryConfig(empty, 0)).rejects.toThrow(
        /cannot load .*module-boundaries\.config\.mjs/u,
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
