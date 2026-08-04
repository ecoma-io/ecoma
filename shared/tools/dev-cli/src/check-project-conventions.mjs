/**
 * Workspace-wide structural conventions that no per-file lint can see — each
 * one a cross-file invariant whose breakage is silent until something
 * downstream misbehaves:
 *
 *  - **required tag presence** — every project's tags must include one
 *    `type:*`, one `scope:*`, and one `license:*` (the same three axes
 *    `local/require-project-tags` names). `@nx/enforce-module-boundaries` keys
 *    every one of its constraints — the type axis (apps never import apps),
 *    the scope axis (leaf independence), the licence axis (`sul` never imports
 *    `ee`) — on a project matching a tag; a project with none of a given axis'
 *    tags matches no constraint on that axis and escapes it entirely, silently.
 *  - **scope tag ↔ directory** — a project's `scope:X` tag must equal its
 *    top-level directory, or a product-domain lib mistagged `scope:shared`
 *    would be importable from every leaf without any lint firing.
 *  - **e2e test placement** — `*.e2e.test.*` / `*_e2e_test.*` files live only
 *    in `type:e2e` projects (root CLAUDE.md test taxonomy: e2e is never
 *    co-located).
 *  - **licence tag ↔ directory** — the root `LICENSE` decides terms by path, so
 *    a project's `license:*` tag must equal what its own path implies; a
 *    mistagged Enterprise module would be importable from SUL code, which
 *    ships paid code to every self-hoster with no gate firing.
 *  - **carve-out directory carries its own LICENSE** — a `packages` or
 *    `enterprise` directory holding tracked files must contain the terms the
 *    root LICENSE says ship there. The carve-out is protective (it removes
 *    those files from the SUL grant), so the moment such a directory is born
 *    without its own terms, its files are published under no licence at all.
 *  - **manifest licence ↔ path** — every `package.json` declares the terms its
 *    path implies. npm has no field that means "ask the tree", so a manifest
 *    with no `license` reads as unlicensed to every tool that looks.
 *  - **coverage floor holds wherever tests exist** — a project with test files
 *    must run them under the workspace floor, whichever runner it uses: a
 *    vitest project's config reads the shared thresholds and turns coverage on
 *    (and may no longer keep `passWithNoTests`), a `node --test` project's
 *    target delegates to dev-cli's Node runner, and a Go project's target
 *    delegates to dev-cli's Go runner — both runners read the same file.
 *    These seams are scaffold state that is legitimate only while a project
 *    has no tests, and each fails silently by turning green: the flag keeps
 *    the target passing after every test is deleted, and a runner that never
 *    reads the floor reports coverage nobody set a bar for. Two exclusions,
 *    both stated rather than silent: the e2e tier — it drives built apps in a
 *    browser, where a module-graph coverage floor measures nothing — and
 *    Python's floor, which is not wired yet (its only rule today is the
 *    empty-suite-mask removal above; the floor arrives with the first Python
 *    project that has real tests).
 *  - **lib alias ↔ manifest pairing** — every `@ecoma-io/<x>` base alias in
 *    `tsconfig.base.json` points at a tracked file inside a project whose
 *    `package.json` carries that exact name, `private: true`, and no
 *    `dependencies`/`devDependencies` (third-party deps live in the root
 *    `package.json`); conversely every `type:lib` `package.json` named
 *    `@ecoma-io/*` has a base alias, or it is silently unimportable.
 *
 * Tag *vocabulary* (is this value one of the allowed slugs for its axis) stays
 * `local/require-project-tags`' job — lint-time, per file, opt-in via that
 * project's own `lint` target. This gate additionally judges tag *presence*
 * for all three required axes, and — where a value is derivable from the path
 * — the value too (`scope:*`, `license:*`; `type:*` has no path-derived
 * expected value, so only its presence is judged here). The lint path only
 * fires when a project actually wires `eslint project.json` into its `lint`
 * target, while this gate walks every tracked `project.json` unconditionally,
 * so it is the one place a missing required tag cannot go unnoticed — a
 * hand-written project can simply not wire up the opt-in lint path. Malformed
 * JSON is lint's problem and skipped here.
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
  rootLicenseSlug,
} from "./license-scope.mjs";

import {
  COVERAGE_CONFIG_FILE,
  PYTEST_EMPTY_SUITE_MASK,
  VITEST_EMPTY_SUITE_FLAG,
} from "./scaffold-lib.mjs";
import { RUN_GO_TESTS_COMMAND } from "./run-go-tests.mjs";
import { RUN_NODE_TESTS_COMMAND } from "./run-node-tests.mjs";

const BASE_ALIAS_RE = /^@ecoma-io\/[^/]+$/;
// Both suffix spellings the test taxonomy uses: `Foo.e2e.test.ts` (TS) and
// `foo_e2e_test.go` / `foo_e2e_test.py` (Go, Python) — including the bare
// `e2e_test.go`, which is what a package whose whole e2e suite is one file
// gets called, hence the `_`-or-path-separator boundary rather than a plain
// `_`. Rust has no filename marker — its e2e files are plain `tests/*.rs` —
// so a co-located Rust e2e test is invisible here and stays on review.
const E2E_FILE_RE = /(\.e2e\.test|(?:^|[/_])e2e_test)\.[^/.]+$/;
const PYTHON_TEST_FILE_RE = /(?:^|\/)[^/]*_test\.py$/;
const GO_TEST_FILE_RE = /(?:^|\/)[^/]*_test\.go$/;
const VITEST_CONFIG_RE = /(?:^|\/)vitest\.config\.[cm]?[jt]s$/;
// Both TS/JS tiers: `Foo.test.ts` and `foo.integration.test.mjs` alike end in
// the same `.test.<ext>` the vitest configs include.
const JS_TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/;
// Matched against the flag's ASSIGNMENT, not a mention of its name: the seam
// comment the scaffold emits names the flag in prose, and a gate that fired on
// the explanation of the rule would be unfixable without deleting the
// explanation.
const VITEST_EMPTY_SUITE_ASSIGNMENT_RE = new RegExp(`${VITEST_EMPTY_SUITE_FLAG}\\s*:\\s*true`);
const COVERAGE_ENABLED_RE = /\benabled\s*:\s*true\b/;
// A per-metric number in a project's own config is an override — importing the
// shared floor and then restating one metric reads as compliant and is not.
const COVERAGE_METRIC_LITERAL_RE = /\b(?:lines|functions|branches|statements)\s*:\s*\d/;

/**
 * Every shell command a project's `<name>` target runs, across the shapes
 * `nx:run-commands` accepts — `options.command` (one string) and
 * `options.commands` (strings, or `{ command }` records). Flattened so a rule
 * can ask what a target actually invokes without depending on which shape its
 * author chose.
 */
const targetCommands = (targets, name) => {
  const options = targets?.[name]?.options ?? {};
  const declared = Array.isArray(options.commands) ? options.commands : [];
  return [options.command, ...declared]
    .map((c) => (typeof c === "string" ? c : c?.command))
    .filter((c) => typeof c === "string");
};

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
    projects.push({
      path,
      root,
      tags: Array.isArray(json.tags) ? json.tags : [],
      targets: json.targets ?? {},
    });
  }

  for (const p of projects) {
    const scopeTag = p.tags.find((t) => typeof t === "string" && t.startsWith("scope:"));
    const top = p.root.split("/")[0];
    if (!scopeTag) {
      violations.push(
        `${p.path}: no 'scope:*' tag — expected 'scope:${top}' for this path — ` +
          `module boundaries key on this tag, so a project with none silently escapes the leaf boundary`,
      );
    } else if (scopeTag.slice("scope:".length) !== top) {
      violations.push(
        `${p.path}: tag '${scopeTag}' does not match top-level directory '${top}' — ` +
          `module boundaries key on this tag, so the mismatch silently escapes the leaf boundary`,
      );
    }
  }

  for (const p of projects) {
    if (!p.tags.some((t) => typeof t === "string" && t.startsWith("type:"))) {
      violations.push(
        `${p.path}: no 'type:*' tag — module boundaries key the type-axis constraints ` +
          `(app/lib/e2e) on this tag, so a project with none escapes them entirely`,
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

  // The root manifest's terms come from the LICENSE the tree ships, not from
  // the path map: `licenseForPath` knows this workspace's geometry, but the
  // gate also judges the private cloud workspace (delivery playbook §6),
  // whose root is all-rights-reserved. Nested manifests keep the
  // path map — their homes are the geometry the map describes. A missing or
  // empty LICENSE yields no expectation at all: that state already carries
  // its own violation above, and a second finding derived from an absence
  // would be noise dressed as signal.
  const rootLicense = tracked.has(ROOT_LICENSE_FILE)
    ? (readFile(ROOT_LICENSE_FILE) ?? "").trim()
    : "";
  const rootSlug = rootLicense ? rootLicenseSlug(rootLicense) : null;
  for (const path of trackedFiles) {
    if (path !== "package.json" && !path.endsWith("/package.json")) continue;
    if (path === "package.json" && !rootSlug) continue;
    const pkg = parseOrNull(readFile(path));
    if (!pkg) continue;
    const expected = MANIFEST_LICENSE[path === "package.json" ? rootSlug : licenseForPath(path)];
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

  // The JS/TS twin of the conftest rule above, keyed the same way — on the
  // project having tests, because every seam below is legitimate until then. A
  // vitest scaffold ships `passWithNoTests` so the gate passes against no tests,
  // and coverage off so a floor is not measured against none; once test files
  // exist, the flag turns "every test deleted" into a pass and disabled coverage
  // leaves the project below a floor it never measures. Neither failure is loud,
  // which is why removal is enforced rather than remembered.
  //
  // A project on Node's own test runner reaches the same floor by a different
  // road — flags, not a config file — and a Go project by a third (dev-cli's
  // Go runner, below): the branch is on which runner the project has, never on
  // which project it is. The exclusions are the two the header states — e2e,
  // and Python's not-yet-wired floor — nothing else.
  for (const p of projects) {
    // The floor covers the two co-located tiers and not e2e: an e2e suite drives
    // a built app in a browser, where there is no instrumented module graph to
    // measure. Keyed on the tier's own filename suffix — the same one the
    // placement rule above reads — rather than on the `type:e2e` tag, so a
    // misplaced e2e file is judged by the tier it belongs to either way.
    const hasTests = trackedFiles.some(
      (f) => f.startsWith(`${p.root}/`) && JS_TEST_FILE_RE.test(f) && !E2E_FILE_RE.test(f),
    );
    if (!hasTests) continue;

    const configPath = trackedFiles.find(
      (f) => f.startsWith(`${p.root}/`) && VITEST_CONFIG_RE.test(f.slice(p.root.length)),
    );
    if (configPath) {
      const config = readFile(configPath) ?? "";
      if (VITEST_EMPTY_SUITE_ASSIGNMENT_RE.test(config)) {
        violations.push(
          `${configPath}: keeps '${VITEST_EMPTY_SUITE_FLAG}: true' but ${p.root} now has tests — ` +
            `delete it, or deleting every test file still reports green`,
        );
      }
      if (
        !config.includes(COVERAGE_CONFIG_FILE) ||
        !COVERAGE_ENABLED_RE.test(config) ||
        COVERAGE_METRIC_LITERAL_RE.test(config)
      ) {
        violations.push(
          `${configPath}: ${p.root} has tests but this config does not hold the workspace ` +
            `coverage floor — it must read 'thresholds' from the repo-root ${COVERAGE_CONFIG_FILE}, ` +
            `set coverage 'enabled: true', and declare no per-metric number of its own ` +
            `(a local number overrides the shared floor while still looking compliant)`,
        );
      }
      continue;
    }

    // Keyed on the delegation, not on a command line: any target invoking the
    // shared runner reads the floor from `coverage.config.json` by construction,
    // whatever globs, flags or `&&` chain surround it. Spelling the whole
    // command here would break on the next flag anyone adds, and matching
    // `node --test` instead would accept the hardcoded thresholds this rule
    // exists to reject.
    if (!targetCommands(p.targets, "test").some((c) => c.includes(RUN_NODE_TESTS_COMMAND))) {
      violations.push(
        `${p.path}: ${p.root} has tests but nothing holds them to the workspace coverage floor — ` +
          `its 'test' target must run them through dev-cli's '${RUN_NODE_TESTS_COMMAND}', which ` +
          `reads 'thresholds' from the repo-root ${COVERAGE_CONFIG_FILE}, or the project must ` +
          `carry a vitest config that reads the same file (restating the numbers in project.json ` +
          `is the duplication that single source exists to prevent)`,
      );
    }
  }

  // The Go leg of the same rule, keyed the same way — on the project having
  // `_test.go` files (both co-located tiers end that way; e2e's `_e2e_test.go`
  // is excluded like the JS tier's). `go test ./...` run bare measures no
  // coverage at all, so the target must delegate to dev-cli's Go runner, which
  // reads the shared floor and applies the one metric Go measures. The runner
  // itself passes an empty profile — a type-free skeleton's honest state — so
  // requiring the delegation early costs nothing and arms the floor before the
  // first real statement lands.
  for (const p of projects) {
    const hasGoTests = trackedFiles.some(
      (f) => f.startsWith(`${p.root}/`) && GO_TEST_FILE_RE.test(f) && !E2E_FILE_RE.test(f),
    );
    if (!hasGoTests) continue;
    if (!targetCommands(p.targets, "test").some((c) => c.includes(RUN_GO_TESTS_COMMAND))) {
      violations.push(
        `${p.path}: ${p.root} has Go tests but nothing holds them to the workspace coverage ` +
          `floor — its 'test' target must run them through dev-cli's '${RUN_GO_TESTS_COMMAND}', ` +
          `which reads 'thresholds' from the repo-root ${COVERAGE_CONFIG_FILE} (bare 'go test' ` +
          `measures no coverage, and restating the numbers in project.json is the duplication ` +
          `that single source exists to prevent)`,
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
    if (!target || readFile(target) === null) {
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
    // A publishable manifest (`private: false`) is consumed through the
    // registry, not the graph: it exists so `nx release` can version and
    // publish the unit for downstream workspaces (delivery
    // playbook §6), and a tsconfig alias for it would be wiring nobody imports
    // through. The pairing rule keeps guarding what it was written for —
    // internal lib manifests, which stay `private: true` and alias-paired.
    if (pkg?.private === false) continue;
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
