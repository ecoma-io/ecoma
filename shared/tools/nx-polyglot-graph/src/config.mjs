/**
 * Reads the workspace's module-boundary law and refuses to run on a malformed
 * one.
 *
 * The law itself lives in `module-boundaries.config.mjs` at the workspace root,
 * where ESLint also reads it (that file's header says why it moved out of
 * `eslint.config.mjs`). This module is the second reader's side of that seam:
 * it loads the file and checks its shape, so a typo fails here, once, naming
 * the offending row — rather than downstream as a rule that silently matches
 * nothing. A constraint that matches nothing does not error; it approves.
 *
 * **The path is derived from the workspace root handed in, never from this
 * file's own location.** This tool runs in two trees: this repository, and the
 * private control-plane workspace that consumes it through a pinned reference
 * clone at `.harness/`. There the tool's own directory sits under `.harness/`
 * while the config it must read is at the consumer's root, so a
 * `../../../../` relative import would resolve to the harness's copy — the
 * wrong tree's rules, silently. Same reason nothing here assumes a project
 * name, an area, or a tag value: everything comes from the graph and the
 * config.
 *
 * Validation is shape only. Whether `layer:adapter` should be allowed to reach
 * `layer:domain` is the workspace's decision, stated in that config with its
 * reasoning; this module has no opinion on the values and must not grow one.
 */
import { pathToFileURL } from "node:url";

/**
 * The config's filename, named once. Every consumer that has to look for the
 * file — the CLI's diagnostics, a future language server's watcher — imports
 * this instead of spelling it again (Rule 14: a value copied across two files
 * was never a valid hardcode).
 */
export const MODULE_BOUNDARIES_CONFIG_FILE = "module-boundaries.config.mjs";

/** The eight non-table options, with the type each must have. */
const OPTION_TYPES = {
  allow: "string[]",
  buildTargets: "string[]",
  enforceBuildableLibDependency: "boolean",
  allowCircularSelfDependency: "boolean",
  checkDynamicDependenciesExceptions: "string[]",
  ignoredCircularDependencies: "pair[]",
  banTransitiveDependencies: "boolean",
  checkNestedExternalImports: "boolean",
};

/**
 * The keys a constraint row may carry, per `@nx/enforce-module-boundaries`'
 * own schema. Two row shapes share one list of lists: a row keys on either one
 * `sourceTag` or an `allSourceTags` array, and both then take the same four
 * optional list fields.
 */
const ROW_LIST_KEYS = [
  "onlyDependOnLibsWithTags",
  "notDependOnLibsWithTags",
  "allowedExternalImports",
  "bannedExternalImports",
];

const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isTagPairArray = (value) =>
  Array.isArray(value) && value.every((pair) => isStringArray(pair) && pair.length === 2);

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One row's problems, prefixed with its index so a report names the offender. */
function constraintRowViolations(row, index) {
  const at = `depConstraints[${index}]`;
  if (!isPlainObject(row)) return [`${at}: must be an object, got ${describe(row)}`];

  const violations = [];
  const hasSourceTag = "sourceTag" in row;
  const hasAllSourceTags = "allSourceTags" in row;
  if (hasSourceTag === hasAllSourceTags) {
    violations.push(
      `${at}: must carry exactly one of 'sourceTag' or 'allSourceTags' — ` +
        `a row with neither matches no project and silently approves everything`,
    );
  }
  if (hasSourceTag && (typeof row.sourceTag !== "string" || row.sourceTag === "")) {
    violations.push(`${at}.sourceTag: must be a non-empty string, got ${describe(row.sourceTag)}`);
  }
  if (hasAllSourceTags && (!isStringArray(row.allSourceTags) || row.allSourceTags.length < 2)) {
    violations.push(
      `${at}.allSourceTags: must be an array of at least 2 strings, got ${describe(row.allSourceTags)}`,
    );
  }
  for (const key of ROW_LIST_KEYS) {
    if (key in row && !isStringArray(row[key])) {
      violations.push(`${at}.${key}: must be an array of strings, got ${describe(row[key])}`);
    }
  }
  // Rejected rather than ignored: an unknown key is almost always a
  // misspelling of one above (`bannedExternalImport`), and the rule would
  // accept the row, enforce the half it understood, and drop the ban.
  for (const key of Object.keys(row)) {
    if (key === "sourceTag" || key === "allSourceTags" || ROW_LIST_KEYS.includes(key)) continue;
    violations.push(
      `${at}.${key}: not a constraint field — expected one of ` +
        `sourceTag, allSourceTags, ${ROW_LIST_KEYS.join(", ")}`,
    );
  }
  return violations;
}

/** A value's type, for an error message that shows what was actually there. */
function describe(value) {
  if (Array.isArray(value)) return `an array (${JSON.stringify(value)})`;
  if (value === null) return "null";
  return `${typeof value} (${JSON.stringify(value) ?? String(value)})`;
}

/**
 * Everything wrong with a loaded boundary config, as messages; empty when it
 * is well-formed. Pure, so a test drives it without a file on disk.
 *
 * @param {unknown} module The config module's exports.
 * @returns {string[]}
 */
export function findBoundaryConfigViolations(module) {
  if (!isPlainObject(module)) return [`config: expected a module object, got ${describe(module)}`];

  const violations = [];
  const { depConstraints, moduleBoundaryOptions } = module;

  if (!Array.isArray(depConstraints)) {
    violations.push(
      `depConstraints: must be an exported array, got ${describe(depConstraints)} — ` +
        `this is the constraint table both enforcers read`,
    );
  } else {
    depConstraints.forEach((row, index) => violations.push(...constraintRowViolations(row, index)));
  }

  if (!isPlainObject(moduleBoundaryOptions)) {
    violations.push(
      `moduleBoundaryOptions: must be an exported object, got ${describe(moduleBoundaryOptions)}`,
    );
    return violations;
  }
  for (const [key, type] of Object.entries(OPTION_TYPES)) {
    if (!(key in moduleBoundaryOptions)) {
      // Missing is rejected rather than defaulted. A default here would be a
      // second copy of a value the config file already states, and the two
      // would answer differently the day one of them changed.
      violations.push(`moduleBoundaryOptions.${key}: missing — every option is stated explicitly`);
      continue;
    }
    const value = moduleBoundaryOptions[key];
    const ok =
      type === "boolean"
        ? typeof value === "boolean"
        : type === "string[]"
          ? isStringArray(value)
          : isTagPairArray(value);
    if (!ok)
      violations.push(`moduleBoundaryOptions.${key}: must be ${type}, got ${describe(value)}`);
  }
  for (const key of Object.keys(moduleBoundaryOptions)) {
    if (!(key in OPTION_TYPES)) {
      violations.push(
        `moduleBoundaryOptions.${key}: not an option of @nx/enforce-module-boundaries — ` +
          `expected one of ${Object.keys(OPTION_TYPES).join(", ")}`,
      );
    }
  }
  return violations;
}

/**
 * Loads and validates the workspace's boundary config.
 *
 * @param {string} workspaceRoot Absolute path of the workspace root — the tree
 *   being judged, which is not this module's own tree when the tool runs from
 *   a pinned harness clone.
 * @returns {Promise<{ depConstraints: object[], options: object }>}
 * @throws {Error} when the file is missing, unloadable, or malformed. Loud on
 *   purpose: an enforcer that starts with no rules enforces nothing and says
 *   nothing, which is the failure this whole tool exists to end.
 */
export async function loadBoundaryConfig(workspaceRoot) {
  const path = `${workspaceRoot.replace(/\/$/, "")}/${MODULE_BOUNDARIES_CONFIG_FILE}`;
  let module;
  try {
    module = await import(pathToFileURL(path).href);
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
