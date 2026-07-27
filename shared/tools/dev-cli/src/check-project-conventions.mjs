/**
 * Workspace-wide structural conventions that no per-file lint can see — each
 * one a cross-file invariant whose breakage is silent until something
 * downstream misbehaves:
 *
 *  - **scope tag ↔ directory** — a project's `scope:X` tag must equal its
 *    top-level directory. `@nx/enforce-module-boundaries` constrains a project
 *    only through its tags, so a product-domain lib mistagged `scope:shared`
 *    would be importable from every leaf without any lint firing.
 *  - **e2e test placement** — `*.e2e.test.*` / `*_e2e_test.*` files live only
 *    in `type:e2e` projects (root CLAUDE.md test taxonomy: e2e is never
 *    co-located).
 *  - **lib alias ↔ manifest pairing** — every `@ecoma-io/<x>` base alias in
 *    `tsconfig.base.json` points at a tracked file inside a project whose
 *    `package.json` carries that exact name, `private: true`, and no
 *    `dependencies`/`devDependencies` (third-party deps live in the root
 *    `package.json`); conversely every `type:lib` `package.json` named
 *    `@ecoma-io/*` has a base alias, or it is silently unimportable.
 *
 * Tag presence/vocabulary is `local/require-project-tags`' job (lint-time,
 * per file); malformed JSON is likewise lint's problem and skipped here.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { PYTEST_EMPTY_SUITE_MASK } from "./scaffold-lib.mjs";

const BASE_ALIAS_RE = /^@ecoma-io\/[^/]+$/;
// Both suffix spellings the test taxonomy uses: `Foo.e2e.test.ts` (TS) and
// `foo_e2e_test.go` / `foo_e2e_test.py` (Go, Python) — including the bare
// `e2e_test.go`, which is what a package whose whole e2e suite is one file
// gets called, hence the `_`-or-path-separator boundary rather than a plain
// `_`. Rust has no filename marker — its e2e files are plain `tests/*.rs` —
// so a co-located Rust e2e test is invisible here and stays on review.
const E2E_FILE_RE = /(\.e2e\.test|(?:^|[/_])e2e_test)\.[^/.]+$/;
const PYTHON_TEST_FILE_RE = /(?:^|\/)[^/]*_test\.py$/;

const parseOrNull = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * Deepest project whose root contains `path`, or null. Deliberately not the
 * `ownerOf` from `check-commit-scope.mjs`: that one falls back to a subsystem/
 * workspace owner and returns a `{ kind, name }` tag, whereas this check needs
 * the project record itself (for its `tags`) and treats "no project" as a
 * distinct case the callers handle.
 */
const ownerOf = (path, projects) =>
  projects.reduce(
    (best, p) =>
      (path === p.root || path.startsWith(`${p.root}/`)) &&
      (!best || p.root.length > best.root.length)
        ? p
        : best,
    null,
  );

/**
 * Pure core: judges `trackedFiles` (repo-relative paths) with file contents
 * supplied by `readFile`. Returns violation messages; injectable for tests.
 */
export function findConventionViolations(trackedFiles, readFile) {
  const violations = [];
  const tracked = new Set(trackedFiles);

  const projects = [];
  for (const path of trackedFiles) {
    if (!path.endsWith("/project.json")) continue; // a root project would own every path
    const json = parseOrNull(readFile(path));
    if (!json) continue;
    const root = path.slice(0, -"/project.json".length);
    projects.push({ path, root, tags: Array.isArray(json.tags) ? json.tags : [] });
  }

  for (const p of projects) {
    const scopeTag = p.tags.find((t) => typeof t === "string" && t.startsWith("scope:"));
    if (!scopeTag) continue; // presence is require-project-tags' job
    const scope = scopeTag.slice("scope:".length);
    const top = p.root.split("/")[0];
    if (scope !== top) {
      violations.push(
        `${p.path}: tag '${scopeTag}' does not match top-level directory '${top}' — ` +
          `module boundaries key on this tag, so the mismatch silently escapes the leaf boundary`,
      );
    }
  }

  for (const path of trackedFiles) {
    if (!E2E_FILE_RE.test(path)) continue;
    const owner = ownerOf(path, projects);
    if (!owner || !owner.tags.includes("type:e2e")) {
      violations.push(
        `${path}: e2e tests live only in a type:e2e project, never co-located ` +
          `(root CLAUDE.md test taxonomy)`,
      );
    }
  }

  // The scaffold's conftest.py maps pytest's empty-suite exit 5 to 0 so a
  // fresh Python lib is not born red. Once real tests exist that mask stops
  // being a seam and starts hiding a collection regression as a pass — the
  // exact fake-green the doctrine bans — and "remove it later" is not a plan
  // anyone executes, so the removal is enforced here instead.
  for (const p of projects) {
    const conftest = `${p.root}/conftest.py`;
    if (!tracked.has(conftest)) continue;
    if (!(readFile(conftest) ?? "").includes(PYTEST_EMPTY_SUITE_MASK)) continue;
    const hasTests = trackedFiles.some(
      (f) => f.startsWith(`${p.root}/`) && PYTHON_TEST_FILE_RE.test(f),
    );
    if (hasTests) {
      violations.push(
        `${conftest}: masks pytest's ${PYTEST_EMPTY_SUITE_MASK} but ${p.root} now has tests — ` +
          `delete the mask, or a regression that collects nothing reports green`,
      );
    }
  }

  const tsconfig = tracked.has("tsconfig.base.json")
    ? parseOrNull(readFile("tsconfig.base.json"))
    : null;
  const paths = tsconfig?.compilerOptions?.paths ?? {};
  const baseAliases = Object.keys(paths).filter((k) => BASE_ALIAS_RE.test(k));

  for (const alias of baseAliases) {
    const target = paths[alias]?.[0];
    if (!target || !tracked.has(target)) {
      violations.push(`tsconfig.base.json: alias '${alias}' points at missing file '${target}'`);
      continue;
    }
    const owner = ownerOf(target, projects);
    if (!owner) {
      violations.push(`tsconfig.base.json: alias '${alias}' target is outside every project`);
      continue;
    }
    const pkgPath = `${owner.root}/package.json`;
    const pkg = tracked.has(pkgPath) ? parseOrNull(readFile(pkgPath)) : null;
    if (!pkg) {
      violations.push(`${pkgPath}: missing or unparsable — required by alias '${alias}'`);
      continue;
    }
    if (pkg.name !== alias) {
      violations.push(`${pkgPath}: name '${pkg.name}' does not match its alias '${alias}'`);
    }
    if (pkg.private !== true) {
      violations.push(`${pkgPath}: libs are internal-only — must declare "private": true`);
    }
    for (const field of ["dependencies", "devDependencies"]) {
      if (field in pkg) {
        violations.push(
          `${pkgPath}: declares '${field}' — third-party deps live in the root package.json ` +
            `(single-package monorepo, root CLAUDE.md)`,
        );
      }
    }
  }

  const aliasSet = new Set(baseAliases);
  for (const p of projects) {
    if (!p.tags.includes("type:lib")) continue;
    const pkgPath = `${p.root}/package.json`;
    if (!tracked.has(pkgPath)) continue; // path-invoked tools carry no manifest
    const pkg = parseOrNull(readFile(pkgPath));
    if (pkg?.name?.startsWith("@ecoma-io/") && !aliasSet.has(pkg.name)) {
      violations.push(
        `${pkgPath}: '${pkg.name}' has no @ecoma-io base alias in tsconfig.base.json — ` +
          `the lib is silently unimportable`,
      );
    }
  }

  return violations;
}

/** CLI entry — scans the git index. Returns a process exit code. */
export function checkProjectConventions() {
  const trackedFiles = execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const violations = findConventionViolations(trackedFiles, (p) => readFileSync(p, "utf8"));
  for (const v of violations) console.error(v);
  return violations.length > 0 ? 1 : 0;
}
