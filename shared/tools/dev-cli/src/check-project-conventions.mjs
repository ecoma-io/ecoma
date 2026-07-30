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
 *  - **licence tag ↔ directory** — the root `LICENSE` decides terms by path, so
 *    a project's `license:*` tag must equal what its own path implies. The tag
 *    is what `@nx/enforce-module-boundaries` keys the licence constraints on;
 *    a mistagged Enterprise module would be importable from SUL code, which
 *    ships paid code to every self-hoster with no gate firing.
 *  - **carve-out directory carries its own LICENSE** — a `packages` or
 *    `enterprise` directory holding tracked files must contain the terms the
 *    root LICENSE says ship there. The carve-out is protective (it removes
 *    those files from the SUL grant), so the moment such a directory is born
 *    without its own terms, its files are published under no licence at all.
 *  - **manifest licence ↔ path** — every `package.json` declares the terms its
 *    path implies. npm has no field that means "ask the tree", so a manifest
 *    with no `license` reads as unlicensed to every tool that looks.
 *  - **lib alias ↔ manifest pairing** — every `@ecoma-io/<x>` base alias in
 *    `tsconfig.base.json` points at a tracked file inside a project whose
 *    `package.json` carries that exact name, `private: true`, and no
 *    `dependencies`/`devDependencies` (third-party deps live in the root
 *    `package.json`); conversely every `type:lib` `package.json` named
 *    `@ecoma-io/*` has a base alias, or it is silently unimportable.
 *
 * Tag vocabulary (and, for `scope:*`, presence too) is `local/require-project-tags`'
 * job (lint-time, per file, opt-in via that project's own `lint` target).
 * `license:*` presence is judged here as well, alongside its value: the lint
 * path only fires when a project actually wires `eslint project.json` into its
 * `lint` target, while this gate runs unconditionally over every tracked
 * project, so it is the one place a missing licence tag cannot go unnoticed.
 * Malformed JSON is lint's problem and skipped here.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { listTrackedFiles } from "./tracked-files.mjs";
import {
  CARVE_OUT_DIRS,
  CARVE_OUT_LICENSE_MARKER,
  MANIFEST_LICENSE,
  ROOT_LICENSE_FILE,
  licenseForPath,
} from "./license-scope.mjs";

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

  for (const p of projects) {
    const licenseTag = p.tags.find((t) => typeof t === "string" && t.startsWith("license:"));
    const expected = licenseForPath(p.root);
    if (!licenseTag) {
      violations.push(
        `${p.path}: no 'license:*' tag — expected 'license:${expected}' for this path ` +
          `(root LICENSE, SCOPE) — module boundaries key the licence constraints on this tag, ` +
          `so a project with none ships under terms nobody chose`,
      );
    } else if (licenseTag.slice("license:".length) !== expected) {
      violations.push(
        `${p.path}: tag '${licenseTag}' does not match the terms its path implies ` +
          `('license:${expected}' — root LICENSE, SCOPE) — module boundaries key the licence ` +
          `constraints on this tag, so the mismatch ships the project under terms nobody chose`,
      );
    }
  }

  // Workspace-scope, so it asks first whether it is looking at the workspace —
  // the same shape the alias rules below use with `tsconfig.base.json`. The
  // root manifest is the marker: fixtures and subtrees that exercise the
  // subproject rules carry no root `package.json` and are not workspaces, and
  // a gate that fired on them would be judging a tree it was never given.
  if (tracked.has("package.json")) {
    if (!tracked.has(ROOT_LICENSE_FILE) || !(readFile(ROOT_LICENSE_FILE) ?? "").trim()) {
      violations.push(
        `${ROOT_LICENSE_FILE}: missing or empty — every manifest in this workspace declares terms ` +
          `this file states, and every carve-out below is written as an exception to it`,
      );
    }
  }

  const carveOutRoots = new Map();
  for (const path of trackedFiles) {
    const segments = path.split("/");
    // `length > 2` keeps a two-segment path — a subsystem's own top-level file,
    // or a submodule gitlink — from registering a carve-out that has no files.
    if (segments.length > 2 && CARVE_OUT_DIRS[segments[1]]) {
      carveOutRoots.set(`${segments[0]}/${segments[1]}`, segments[1]);
    }
  }
  for (const [root, dirName] of [...carveOutRoots].sort()) {
    const licensePath = `${root}/${ROOT_LICENSE_FILE}`;
    if (!tracked.has(licensePath)) {
      violations.push(
        `${licensePath}: missing — the root LICENSE removes this directory from the SUL grant, ` +
          `so until its own terms ship beside it these files carry no licence at all`,
      );
      continue;
    }
    const marker = CARVE_OUT_LICENSE_MARKER[dirName];
    if (!(readFile(licensePath) ?? "").includes(marker)) {
      violations.push(
        `${licensePath}: does not name the '${marker}' the root LICENSE says ships here — ` +
          `an empty file, or the SUL text copied into a carve-out, satisfies mere existence ` +
          `while leaving these files under terms nobody granted`,
      );
    }
  }

  for (const path of trackedFiles) {
    if (path !== "package.json" && !path.endsWith("/package.json")) continue;
    const pkg = parseOrNull(readFile(path));
    if (!pkg) continue;
    const expected = MANIFEST_LICENSE[licenseForPath(path)];
    if (pkg.license !== expected) {
      violations.push(
        `${path}: "license" is ${JSON.stringify(pkg.license ?? null)}, expected ` +
          `${JSON.stringify(expected)} for this path (root LICENSE, SCOPE)`,
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
  // exact fake-green the practice bans — and "remove it later" is not a plan
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

/**
 * CLI entry — scans the git index. Returns a process exit code.
 *
 * The reader returns null for a file the index lists but the working tree no
 * longer has, rather than throwing: deleting a tracked file is exactly the
 * state several rules here exist to catch, and a stack trace reports it as a
 * tool crash instead of as the violation it is.
 */
export function checkProjectConventions() {
  const trackedFiles = listTrackedFiles().join("\n").split("\n").filter(Boolean);
  const readFile = (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  const violations = findConventionViolations(trackedFiles, readFile);
  for (const v of violations) console.error(v);
  return violations.length > 0 ? 1 : 0;
}
