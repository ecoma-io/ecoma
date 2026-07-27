/**
 * Keeps the a11y e2e sweep honest about what it covers.
 *
 * `design-system-e2e` scans every story the built Storybook lists in its own
 * `index.json` — derived, never hand-listed, so a story is covered the moment
 * it exists. The hole that derivation leaves open is the one this gate closes:
 * a component with NO story contributes no index entry, so the sweep passes
 * without ever having looked at it. Coverage shrinks and the gate still reports
 * green, which is the failure mode a gate must never have.
 *
 * A component is any directory holding a `.vue` file of its own name —
 * `Button/Button.vue`, `EmptyState/EmptyState.vue`. That is the repo's
 * co-located artifact convention (`shared/libs/core-ui/CLAUDE.md`), and reading
 * it off the tree rather than listing `primitives`/`blocks` here means a third
 * category invented later is covered the day it appears, with nothing to update
 * (Rule 14). Demo and gallery SFCs (`ButtonDemo.vue`, `MotionGallery.vue`) do
 * not match their directory name and are correctly ignored — they are not
 * components the library ships.
 *
 * Overlaps `check-primitive-artifacts` on primitives, deliberately: that gate
 * asserts a primitive is artifact-complete, this one asserts the sweep can see
 * a component at all. Same file, different invariants — and blocks, which that
 * gate puts out of scope on purpose, are held here.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** `…/<Name>/<file>` split into the owning directory, its name, and the file. */
const COMPONENT_FILE_RE = /(?:^|\/)([^/]+)\/([^/]+)$/;

/**
 * Pure core: judges repo-relative `trackedFiles` and returns one violation per
 * component that ships no story. Injectable so the logic is unit-testable
 * without a real repo or a real Storybook build.
 */
export function findComponentsWithoutStories(trackedFiles) {
  /** component directory → { name, files } */
  const dirs = new Map();
  for (const path of trackedFiles) {
    const match = COMPONENT_FILE_RE.exec(path);
    if (!match) continue;
    const [, name, file] = match;
    const dir = path.slice(0, -(file.length + 1));
    if (!dirs.has(dir)) dirs.set(dir, { name, files: new Set() });
    dirs.get(dir).files.add(file);
  }

  const violations = [];
  for (const [dir, { name, files }] of [...dirs].sort(([a], [b]) => a.localeCompare(b))) {
    // The directory-named `.vue` is what makes this a shipped component rather
    // than a folder that merely contains one.
    if (!files.has(`${name}.vue`)) continue;
    if (files.has(`${name}.stories.ts`)) continue;
    violations.push(
      `${dir}: missing ${name}.stories.ts — a component with no story is never ` +
        `scanned by the design-system-e2e a11y sweep, which would pass while covering ` +
        `less than it claims (shared/apps/design-system-e2e/CLAUDE.md)`,
    );
  }
  return violations;
}

/**
 * CLI entry. Takes the directory to scan, relative to the caller's cwd, because
 * this runs from `design-system-e2e`'s lint — not from the project it guards.
 *
 * `git ls-files` is resolved against the REPO ROOT, not the cwd. Run
 * cwd-relative from `design-system-e2e` it would list that project's own files,
 * find no components, and report success — a gate that silently checks nothing is
 * worse than no gate. Anchoring at the toplevel makes the returned paths
 * repo-relative wherever this is invoked from.
 */
export function checkE2eStoryCoverage(args) {
  const target = args[0];
  if (!target) {
    console.error(
      "check-e2e-story-coverage: expected a directory to scan, e.g. ../../libs/core-ui/src",
    );
    return 1;
  }

  const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  // Absolute pathspec, listed FROM the toplevel: the pathspec still points at
  // the caller's intended directory while the paths come back repo-relative,
  // which is what the pure core above expects.
  const tracked = execFileSync("git", ["ls-files", "--", resolve(target)], {
    cwd: toplevel,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

  // Loud on an empty scan: a mistyped or moved path must not read as "clean".
  if (tracked.length === 0) {
    console.error(
      `check-e2e-story-coverage: '${target}' matched no tracked files — ` +
        `the path is wrong or the code moved; refusing to report a pass`,
    );
    return 1;
  }

  const violations = findComponentsWithoutStories(tracked);
  for (const v of violations) console.error(v);
  return violations.length > 0 ? 1 : 0;
}
