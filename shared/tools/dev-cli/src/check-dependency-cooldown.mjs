/**
 * Fails when the two halves of the dependency cooldown state different
 * durations.
 *
 * A cooldown — refusing to install a release until it has been public long
 * enough for scanners and researchers to have read it — has to be declared
 * twice here, and the split is not redundancy. Renovate holds back the DIRECT
 * updates it proposes (`.github/renovate.json5`), and it says of itself that it
 * "does not currently manage any transitive dependencies"; pnpm holds back
 * everything a lock file resolves, transitive packages included
 * (`pnpm-workspace.yaml`). Delete either and a whole class of package walks
 * straight in — which is the class the npm supply-chain attacks travelled by.
 *
 * Neither tool can read the other's file, so Rule 14's rungs 1 and 2 are both
 * out: there is no source to derive from and no shared config either consumer
 * would load. What is left is the rung the workspace already uses when two
 * tools must agree on one number and cannot share a parser — a gate that reads
 * both and refuses the drift (the same shape as repo-care reading
 * `timeout-minutes` out of the workflow that imposes it).
 *
 * Only Renovate's `<n> days` spelling is accepted. Renovate parses far more
 * duration formats than that, but every extra spelling is a conversion this
 * gate could get wrong, and one spelling costs the author nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MINUTES_PER_DAY = 1440;

// Resolved from this module's own location, never the working directory: the
// gate runs from lefthook, from CI, and from an nx target whose cwd is a
// project root, and it must read the same two files in all three.
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

export const RENOVATE_CONFIG = ".github/renovate.json5";
export const PNPM_CONFIG = "pnpm-workspace.yaml";

const RENOVATE_RE = /minimumReleaseAge:\s*"(\d+)\s+days?"/;
const PNPM_RE = /^minimumReleaseAge:\s*(\d+)\s*$/m;

/**
 * Renovate's cooldown in minutes, or null when the file declares none in the
 * one accepted spelling. Pure — the caller supplies the file text.
 */
export function readRenovateCooldown(text) {
  const m = RENOVATE_RE.exec(text);
  return m ? Number(m[1]) * MINUTES_PER_DAY : null;
}

/** pnpm's cooldown in minutes (its own unit), or null when it declares none. */
export function readPnpmCooldown(text) {
  const m = PNPM_RE.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * The faults in one pair of readings: a missing half is as much a fault as a
 * mismatched one, because half a cooldown reads as a cooldown. Pure, so the
 * whole judgment is testable without the filesystem.
 */
export function findCooldownFaults(renovateMinutes, pnpmMinutes) {
  const faults = [];
  if (renovateMinutes === null) {
    faults.push(
      `${RENOVATE_CONFIG}: no \`minimumReleaseAge: "<n> days"\` — Renovate would propose a release published minutes ago`,
    );
  }
  if (pnpmMinutes === null) {
    faults.push(
      `${PNPM_CONFIG}: no \`minimumReleaseAge: <minutes>\` — nothing holds back a transitive dependency, which Renovate does not manage`,
    );
  }
  if (renovateMinutes !== null && pnpmMinutes !== null && renovateMinutes !== pnpmMinutes) {
    faults.push(
      `the two halves disagree: ${RENOVATE_CONFIG} says ${renovateMinutes / MINUTES_PER_DAY} days ` +
        `(${renovateMinutes} minutes), ${PNPM_CONFIG} says ${pnpmMinutes} minutes ` +
        `(${pnpmMinutes / MINUTES_PER_DAY} days) — the shorter one is the real cooldown`,
    );
  }
  return faults;
}

/** CLI entry: 0 when both halves agree, 1 otherwise. */
export function checkDependencyCooldown(deps = {}) {
  const { read = (path) => readFileSync(REPO_ROOT + path, "utf8") } = deps;
  let faults;
  try {
    faults = findCooldownFaults(
      readRenovateCooldown(read(RENOVATE_CONFIG)),
      readPnpmCooldown(read(PNPM_CONFIG)),
    );
  } catch (err) {
    console.error(`check-dependency-cooldown: ${err.message}`);
    return 1;
  }
  for (const fault of faults) console.error(`check-dependency-cooldown: ${fault}`);
  return faults.length > 0 ? 1 : 0;
}
