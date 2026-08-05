/**
 * The workspace's boundary law, read by a process that outlives edits to it.
 *
 * `../config.mjs` already loads and validates that file, and this module reuses
 * both halves of it — the filename and `findBoundaryConfigViolations`. What it
 * does NOT reuse is `loadBoundaryConfig`, and the reason is one line of ESM
 * semantics: `import()` memoises a module URL for the life of the process. A
 * CLI run imports the config once and exits, so memoisation is invisible there.
 * A language server runs for hours across edits to that very file, and a second
 * `import()` of the same URL would hand back the constraint table as it was
 * when the editor opened — the editor would then re-diagnose every file against
 * a config that no longer exists, which is precisely the failure re-diagnosing
 * on a config change is meant to prevent.
 *
 * So the URL carries a revision the caller controls. Reusing the validation
 * rather than restating it keeps one answer to "is this table well-formed"; the
 * revision is the only thing added.
 */
import { pathToFileURL } from "node:url";

import { findBoundaryConfigViolations, MODULE_BOUNDARIES_CONFIG_FILE } from "../config.mjs";

/**
 * Loads and validates the boundary config at `workspaceRoot`.
 *
 * @param {string} workspaceRoot Absolute path of the tree being judged — never
 *   derived from this file's own location, for the reason `../config.mjs`
 *   states: under a pinned harness clone the tool's directory and the
 *   workspace's root are in different trees.
 * @param {string|number} revision Anything that changes when the file should be
 *   re-read. Two calls with the same revision return the same module; two with
 *   different revisions re-execute the file.
 * @returns {Promise<{depConstraints: object[], options: object}>}
 * @throws {Error} when the file is missing, unloadable, or malformed — the same
 *   contract `loadBoundaryConfig` has, for the same reason: an enforcer that
 *   starts with no rules enforces nothing and says nothing.
 */
export async function readBoundaryConfig(workspaceRoot, revision) {
  const path = `${workspaceRoot.replace(/\/$/, "")}/${MODULE_BOUNDARIES_CONFIG_FILE}`;
  const url = `${pathToFileURL(path).href}?revision=${encodeURIComponent(String(revision))}`;
  let module;
  try {
    module = await import(url);
  } catch (cause) {
    throw new Error(`nx-polyglot-graph: cannot load ${path}: ${cause?.message ?? cause}`, {
      cause,
    });
  }
  const violations = findBoundaryConfigViolations(module);
  if (violations.length > 0) {
    throw new Error(`nx-polyglot-graph: ${path} is malformed:\n  ${violations.join("\n  ")}`);
  }
  return { depConstraints: module.depConstraints, options: module.moduleBoundaryOptions };
}
