/**
 * Runs a Go project's co-located test tiers (`_test.go`,
 * `_integration_test.go` — `go test ./...` collects both) under the workspace
 * coverage floor.
 *
 * Exists for the same reason as `run-node-tests`: an `nx:run-commands` string
 * cannot read JSON, so without this command a Go test target either runs bare
 * `go test ./...` with no floor at all — the silent exemption
 * `check-project-conventions` exists to reject — or restates the numbers in
 * `project.json`, the forked config the single source removes (Rule 14).
 *
 * **Go measures one metric: statement coverage.** The floor applied is the
 * shared `statements` threshold; `lines`/`functions`/`branches` have no Go
 * consumer. That is the same honest narrowing as the Node runner enforcing
 * three of the four — the residue is stated here rather than dropped.
 *
 * **The floor binds exactly when coverage is measurable.** `go test ./...
 * -coverprofile` instruments only packages that have test files, and a
 * package with no statements contributes no profile entries — so a type-free
 * skeleton (doc.go seams, TODO-only contract files) yields an empty profile
 * and passes, which is its honest state. The first real statement under test
 * brings the floor with it. A project whose test files are deleted entirely
 * leaves this command's jurisdiction and is caught by
 * `check-project-conventions`' has-tests key instead.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

import { COVERAGE_CONFIG_FILE } from "./scaffold-lib.mjs";

/**
 * The subcommand's own name, exported because `check-project-conventions`
 * requires a Go project's test target to name it — one spelling, three
 * consumers (this module, the `COMMANDS` registry, the gate), the same
 * contract `RUN_NODE_TESTS_COMMAND` carries for the Node-runner half.
 */
export const RUN_GO_TESTS_COMMAND = "run-go-tests";

/** Reads the workspace floor. Lazy, so importing this module has no side effect. */
const loadThresholds = () =>
  createRequire(import.meta.url)(`../../../../${COVERAGE_CONFIG_FILE}`).thresholds;

/**
 * True when the profile carries at least one statement entry — the condition
 * under which Go coverage is a measurement rather than 0/0. A profile is its
 * `mode:` header plus one line per statement block.
 */
export function profileHasStatements(profileText) {
  return profileText.split("\n").some((line) => line && !line.startsWith("mode:"));
}

/**
 * Extracts the total statement percentage from `go tool cover -func` output
 * (its last line: `total:  (statements)  NN.N%`). Returns null when absent.
 */
export function totalStatementCoverage(funcOutput) {
  const m = funcOutput.match(/^total:\s+\(statements\)\s+([\d.]+)%/m);
  return m ? Number(m[1]) : null;
}

/**
 * Runs `go test ./...` with a coverage profile and holds the total against the
 * shared `statements` floor. Returns a process exit code.
 *
 * @param {string[]} args - forwarded verbatim to `go test` after `./...`.
 * @param {{ thresholds?: Record<string, number>, exec?: typeof execFileSync }} [deps]
 *   injectable floor and spawner, for tests.
 */
export function runGoTests(args = [], { thresholds = loadThresholds(), exec = execFileSync } = {}) {
  const floor = thresholds?.statements;
  if (typeof floor !== "number") {
    console.error(
      `${RUN_GO_TESTS_COMMAND}: ${COVERAGE_CONFIG_FILE}: 'thresholds' declares no number for ` +
        `statements — the one metric Go coverage measures`,
    );
    return 1;
  }

  const tmp = mkdtempSync(join(tmpdir(), "go-cover-"));
  const profilePath = join(tmp, "coverage.out");
  try {
    try {
      exec("go", ["test", "./...", `-coverprofile=${profilePath}`, ...args], {
        stdio: "inherit",
      });
    } catch {
      return 1; // the suite itself failed; go test already reported it
    }

    let profile;
    try {
      profile = readFileSync(profilePath, "utf8");
    } catch {
      profile = "";
    }
    if (!profileHasStatements(profile)) {
      console.log(
        `${RUN_GO_TESTS_COMMAND}: no instrumented statements — the floor binds with the first ` +
          `statement under test`,
      );
      return 0;
    }

    const funcOutput = exec("go", ["tool", "cover", `-func=${profilePath}`], {
      encoding: "utf8",
    });
    const total = totalStatementCoverage(funcOutput);
    if (total === null) {
      console.error(
        `${RUN_GO_TESTS_COMMAND}: 'go tool cover -func' printed no total — cannot judge the floor`,
      );
      return 1;
    }
    if (total < floor) {
      console.error(
        `${RUN_GO_TESTS_COMMAND}: statement coverage ${total}% is below the workspace floor ` +
          `${floor}% (${COVERAGE_CONFIG_FILE})`,
      );
      return 1;
    }
    console.log(`${RUN_GO_TESTS_COMMAND}: statement coverage ${total}% (floor ${floor}%)`);
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
