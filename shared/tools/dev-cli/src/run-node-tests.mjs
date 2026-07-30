/**
 * Runs a project's suite on Node's built-in test runner under the workspace
 * coverage floor.
 *
 * Every vitest project reads `coverage.config.json` from its own config, so the
 * floor is one edit and no project sits below it while looking compliant. A
 * project on `node --test` has no config file to read it from — the thresholds
 * are command-line flags — and an `nx:run-commands` string cannot read JSON.
 * Restating the numbers in `project.json` would recreate exactly the
 * duplication that single source removed (Rule 14 rung 3: a value copied across
 * two files was never a valid hardcode). So the reading happens here, in the
 * workspace's existing home for developer commands, and the target delegates.
 *
 * The child is spawned with an argv array under `process.execPath` — no shell,
 * so nothing here depends on POSIX word-splitting or globbing (Node expands the
 * positional test patterns itself, on Windows as well). Extra args are
 * forwarded verbatim after the coverage flags and the exit code is propagated.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { COVERAGE_CONFIG_FILE } from "./scaffold-lib.mjs";

/**
 * The subcommand's own name, exported because `check-project-conventions`
 * requires a `node --test` project's target to name it — one spelling, three
 * consumers (this module, the `COMMANDS` registry, the gate), the same contract
 * `VITEST_EMPTY_SUITE_FLAG` carries for the vitest half.
 */
export const RUN_NODE_TESTS_COMMAND = "run-node-tests";

/**
 * The coverage thresholds Node's runner exposes, mapped to their flags. Node's
 * CLI is a fixed external contract and this is the only place the mapping
 * appears, so the flag names are inline rather than derived (Rule 14 rubric:
 * intrinsic to an external contract, single site).
 *
 * **Node offers no `statements` threshold**, and the shared floor carries one.
 * The fourth number is therefore NOT enforced here — a suite run through this
 * command is held to three of the four, and that is the honest description of
 * it. Folding the value into `--test-coverage-lines` was rejected as a mapping:
 * measured on this workspace's own suites, vitest's v8 provider reports
 * statement coverage BELOW line coverage (`nx-polyglot-graph`: 96.25%
 * statements vs 98.55% lines), so the two are different measurements and a
 * statements number applied to lines would assert a bar nobody set.
 *
 * What `coverageThresholdFlags` does instead is keep the omission from going
 * silent. `statements` is a refinement of `lines` — the same executed lines,
 * counted per statement — so it can only ever sit at or below line coverage.
 * While the config asks no more of it than of `lines`, enforcing `lines` is the
 * closest this runner can come to honouring it; above that, the gap is real,
 * and the command refuses to run rather than report green against a bar it
 * never measured. The comparison is against `lines` specifically and not the
 * weakest enforced metric, so a deliberately lower `branches` floor — the
 * normal shape of a coverage config — does not trip a rule about statements.
 */
const NODE_COVERAGE_FLAGS = {
  lines: "--test-coverage-lines",
  branches: "--test-coverage-branches",
  functions: "--test-coverage-functions",
};

/** Reads the workspace floor. Lazy, so importing this module has no side effect. */
const loadThresholds = () =>
  createRequire(import.meta.url)(`../../../../${COVERAGE_CONFIG_FILE}`).thresholds;

/**
 * Builds the `--test-coverage-*` flags for `thresholds`. Throws when the shared
 * floor names a metric Node cannot enforce at a level above what it can, rather
 * than running a suite that would report green against a bar it never measured.
 *
 * @param {Record<string, number>} thresholds - the shared floor's `thresholds`.
 * @returns {string[]} coverage flags, in `NODE_COVERAGE_FLAGS` order.
 */
export function coverageThresholdFlags(thresholds) {
  const missing = Object.keys(NODE_COVERAGE_FLAGS).filter(
    (metric) => typeof thresholds?.[metric] !== "number",
  );
  if (missing.length) {
    throw new Error(
      `${COVERAGE_CONFIG_FILE}: 'thresholds' declares no number for ${missing.join(", ")} — ` +
        `Node's test runner needs one per metric it enforces`,
    );
  }

  const unenforceable = Object.entries(thresholds)
    .filter(([metric, value]) => !(metric in NODE_COVERAGE_FLAGS) && value > thresholds.lines)
    .map(([metric, value]) => `${metric}: ${value}`);
  if (unenforceable.length) {
    throw new Error(
      `${COVERAGE_CONFIG_FILE}: Node's test runner has no threshold for ${unenforceable.join(", ")}, ` +
        `above the 'lines: ${thresholds.lines}' it does enforce — a suite run here would report ` +
        `green against a floor it never measured. Bring those metrics down to the line floor, or ` +
        `move this project onto a runner that measures them`,
    );
  }

  return Object.entries(NODE_COVERAGE_FLAGS).map(
    ([metric, flag]) => `${flag}=${thresholds[metric]}`,
  );
}

/**
 * Runs `node --test` with coverage held to the workspace floor. Returns a
 * process exit code.
 *
 * @param {string[]} args - forwarded verbatim (test patterns, `--test-coverage-exclude=…`).
 * @param {{ thresholds?: Record<string, number> }} [deps] - injectable floor, for tests.
 */
export function runNodeTests(args = [], { thresholds = loadThresholds() } = {}) {
  let coverageFlags;
  try {
    coverageFlags = coverageThresholdFlags(thresholds);
  } catch (error) {
    console.error(`${RUN_NODE_TESTS_COMMAND}: ${error.message}`);
    return 1;
  }

  const result = spawnSync(
    process.execPath,
    ["--test", "--experimental-test-coverage", ...coverageFlags, ...args],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}
