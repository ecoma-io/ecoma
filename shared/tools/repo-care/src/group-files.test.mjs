import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import { discoverProjectRoots, groupFiles, ownerOf, readProjectNames } from "./group-files.mjs";

const segment = fc
  .array(fc.constantFrom(..."abcdefgh"), { minLength: 1, maxLength: 5 })
  .map((chars) => chars.join(""));

/** Project roots paired with a pull request's changed files — some owned, some not. */
const pullRequest = fc
  .uniqueArray(
    fc.array(segment, { minLength: 1, maxLength: 3 }).map((parts) => parts.join("/")),
    { maxLength: 5 },
  )
  .chain((projectRoots) =>
    fc.record({
      projectRoots: fc.constant(projectRoots),
      files: fc.array(
        fc.oneof(
          ...(projectRoots.length > 0
            ? [
                fc
                  .tuple(fc.constantFrom(...projectRoots), segment)
                  .map(([root, file]) => `${root}/src/${file}.ts`),
              ]
            : []),
          fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => parts.join("/")),
          segment.map((file) => `${file}.md`), // a file at the repository root
        ),
        { maxLength: 12 },
      ),
    }),
  );

/** A fake `git ls-files` returning the given tracked paths. */
const gitLs = (paths) => () => paths.join("\n");

describe("discoverProjectRoots", () => {
  it("takes a directory holding a tracked project.json as a project, so the list follows the index", () => {
    expect(
      discoverProjectRoots(".", gitLs(["shared/libs/core-ui/project.json", "app/project.json"])),
    ).toEqual(["app", "shared/libs/core-ui"]);
  });

  it("never sees build output, because the index does not carry it — a built Storybook ships its own project.json", () => {
    expect(discoverProjectRoots(".", gitLs(["shared/apps/design-system/project.json"]))).toEqual([
      "shared/apps/design-system",
    ]);
  });

  it("does not call the repository root a project, since it would then own every path", () => {
    expect(discoverProjectRoots(".", gitLs(["project.json", "app/project.json"]))).toEqual(["app"]);
  });

  it("ignores a file that merely ends in project.json", () => {
    expect(discoverProjectRoots(".", gitLs(["app/subproject.json"]))).toEqual([]);
  });

  it("degrades to no projects outside a checkout rather than throwing at the caller", () => {
    expect(
      discoverProjectRoots(".", () => {
        throw new Error("not a git repository");
      }),
    ).toEqual([]);
  });
});

describe("ownerOf", () => {
  const roots = ["shared/libs/core-ui", "shared/tools/dev-cli"];

  it("gives a file to the deepest project that owns it", () => {
    expect(ownerOf("shared/libs/core-ui/src/Button.vue", roots)).toBe("shared/libs/core-ui");
  });

  it("falls back to the subsystem for a file no project owns", () => {
    expect(ownerOf("shared/CLAUDE.md", roots)).toBe("shared");
  });

  it("keeps dot-directories apart instead of collapsing them with the root files", () => {
    expect(ownerOf(".claude/skills/preflight/SKILL.md", roots)).toBe(".claude");
    expect(ownerOf(".github/workflows/ci.yml", roots)).toBe(".github");
  });

  it("gives a repository-root file its own group rather than an empty name", () => {
    expect(ownerOf("CLAUDE.md", roots)).toBe(".");
  });

  it("does not let a project own a sibling whose name merely starts the same way", () => {
    expect(ownerOf("shared/libs/core-ui-extras/x.ts", roots)).toBe("shared");
  });
});

describe("groupFiles", () => {
  const roots = ["a/one", "a/two"];

  it("puts every file under exactly one owner", () => {
    const files = ["a/one/x.ts", "a/one/y.ts", "a/two/z.ts", "a/README.md", "root.md"];
    const groups = groupFiles(files, roots);
    expect(groups.flatMap((g) => g.files).sort()).toEqual([...files].sort());
    expect(new Set(groups.map((g) => g.name)).size).toBe(groups.length);
  });

  it("orders by descending file count, so the first calls go to the largest part", () => {
    const groups = groupFiles(["a/one/x.ts", "a/one/y.ts", "a/two/z.ts"], roots);
    expect(groups.map((g) => g.name)).toEqual(["a/one", "a/two"]);
  });

  it("breaks a tie by name, so two runs over the same diff agree on the order", () => {
    const groups = groupFiles(["a/two/z.ts", "a/one/x.ts"], roots);
    expect(groups.map((g) => g.name)).toEqual(["a/one", "a/two"]);
  });

  it("returns nothing for an empty change set rather than one empty group", () => {
    expect(groupFiles([], roots)).toEqual([]);
  });

  it("labels a project group with its Nx name, the vocabulary a commit scope already uses", () => {
    const [group] = groupFiles(["a/one/x.ts"], roots, { "a/one": "core-ui" });
    expect(group.name).toBe("core-ui");
    expect(group.root).toBe("a/one");
  });

  it("keeps the directory as the label when no project owns the group", () => {
    expect(groupFiles([".github/ci.yml"], roots)[0].name).toBe(".github");
  });

  it("spells out the repository root, since '.' names nothing to a reader", () => {
    expect(groupFiles(["CLAUDE.md"], roots)[0].name).toBe("repository root");
  });

  // The grouping decides what each review pass gets to read. A file that lands
  // in no group is never reviewed and nothing says so; a file that lands in two
  // is reviewed twice and can be reported twice. Neither shows up in an example
  // test written against a layout someone already had in mind.
  test.prop([pullRequest])(
    "puts every changed file in exactly one group",
    ({ projectRoots, files }) => {
      const grouped = groupFiles(files, projectRoots).flatMap((group) => group.files);
      expect([...grouped].sort()).toEqual([...files].sort());
    },
  );

  test.prop([pullRequest])(
    "gives a group only files that resolve to its own owner",
    ({ projectRoots, files }) => {
      for (const group of groupFiles(files, projectRoots)) {
        for (const file of group.files) expect(ownerOf(file, projectRoots)).toBe(group.root);
      }
    },
  );

  // The order is what spends the review's first (and most likely to succeed)
  // calls on the largest part of the pull request, and the tie-break is what
  // makes a re-run produce the same comment as the run before it.
  test.prop([pullRequest])(
    "orders groups by descending file count, breaking ties by root",
    ({ projectRoots, files }) => {
      const keys = groupFiles(files, projectRoots).map((group) => [group.files.length, group.root]);
      const expected = [...keys].sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
      expect(keys).toEqual(expected);
    },
  );
});

describe("readProjectNames", () => {
  it("reads each project's own declared name rather than guessing from the path", () => {
    const read = (p) => (p === "./a/one/project.json" ? '{"name":"core-ui"}' : "{}");
    expect(readProjectNames(["a/one"], ".", read)).toEqual({ "a/one": "core-ui" });
  });

  it("skips a manifest it cannot parse, so one broken project.json does not lose every label", () => {
    const read = (p) => (p === "./a/one/project.json" ? "{oops" : '{"name":"two"}');
    expect(readProjectNames(["a/one", "a/two"], ".", read)).toEqual({ "a/two": "two" });
  });
});
