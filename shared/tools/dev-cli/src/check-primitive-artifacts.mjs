/**
 * Enforces the five-artifact convention for UI primitives mechanically: a
 * primitive `<Name>` under `src/primitives/<Name>/` is complete only with
 * `<Name>.vue`, `<Name>.test.ts`, `<Name>Demo.vue`, `<Name>.stories.ts` and
 * `<Name>.mdx` (`shared/libs/core-ui/CLAUDE.md`).
 *
 * Existence only — whether a test pins anything worth pinning (Rule 8) stays on
 * review, where judgment lives. The test artifact is the one that regresses
 * silently: a primitive can ship, render and be consumed with no test at all,
 * and nothing else in the toolchain notices.
 *
 * Blocks (`src/blocks/<Name>/`) follow the same shape minus the mandatory test,
 * so they are deliberately out of scope here.
 */
import { execFileSync } from "node:child_process";

import { cwdGitEnv } from "./git-env.mjs";

const PRIMITIVE_FILE_RE = /(?:^|\/)src\/primitives\/([^/]+)\/([^/]+)$/;

/** The five co-located artifacts a primitive `<Name>` must carry. */
const artifactsFor = (name) => [
  `${name}.vue`,
  `${name}.test.ts`,
  `${name}Demo.vue`,
  `${name}.stories.ts`,
  `${name}.mdx`,
];

/**
 * Pure core: judges `trackedFiles` (repo-relative paths) and returns one
 * violation message per missing artifact. Injectable so the logic is
 * unit-testable without a real repo.
 */
export function findIncompletePrimitives(trackedFiles) {
  /** primitive directory → the file names it holds. */
  const dirs = new Map();
  for (const path of trackedFiles) {
    const match = PRIMITIVE_FILE_RE.exec(path);
    if (!match) continue;
    const dir = path.slice(0, -(match[2].length + 1));
    if (!dirs.has(dir)) dirs.set(dir, { name: match[1], files: new Set() });
    dirs.get(dir).files.add(match[2]);
  }

  const violations = [];
  for (const [dir, { name, files }] of [...dirs].sort(([a], [b]) => a.localeCompare(b))) {
    for (const artifact of artifactsFor(name)) {
      if (!files.has(artifact)) {
        violations.push(
          `${dir}: missing ${artifact} — every primitive is five co-located artifacts ` +
            `(shared/libs/core-ui/CLAUDE.md)`,
        );
      }
    }
  }
  return violations;
}

/**
 * CLI entry — scans the git index. `git ls-files` is cwd-relative, so this
 * works both from the repo root and from inside `core-ui` (its lint target) —
 * but only in an environment where cwd is what git resolves the repository from,
 * which is what `cwdGitEnv` guarantees (`git-env.mjs`). Returns a process exit
 * code.
 */
export function checkPrimitiveArtifacts() {
  const trackedFiles = execFileSync("git", ["ls-files"], {
    encoding: "utf8",
    env: cwdGitEnv(),
  })
    .split("\n")
    .filter(Boolean);
  const violations = findIncompletePrimitives(trackedFiles);
  for (const v of violations) console.error(v);
  return violations.length > 0 ? 1 : 0;
}
