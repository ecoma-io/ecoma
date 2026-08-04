/**
 * The root `LICENSE`'s SCOPE section, as code — the single place this workspace
 * answers "which terms govern this path?".
 *
 * The licence carves the tree by path rather than by filename marker precisely
 * so this derivation can exist: there is one place to read the answer from, and
 * it is the path itself (Rule 14). Two consumers depend on that being one
 * function and not two opinions — `check-project-conventions` judges what the
 * tree already declares, and `scaffold-lib` decides what a new project is born
 * declaring. If those ever disagreed, every scaffolded project would arrive
 * failing the gate that scaffolded it.
 *
 * It lives in its own module rather than inside either consumer because
 * `check-project-conventions` already imports from `scaffold-lib`; putting it
 * in the gate would close that edge into a cycle.
 */

/**
 * Keyed by the directory name directly beneath a subsystem root — `packages`
 * holds what a third party needs to plug INTO Ecoma, `enterprise` what it must
 * buy. Everything else runs the system and is SUL.
 */
export const CARVE_OUT_DIRS = { packages: "apache", enterprise: "ee" };

/**
 * A phrase each carve-out's own LICENSE must contain, so the gate judges terms
 * rather than a filename. Checking only that the path exists let a zero-byte
 * file satisfy it — and, worse, let a copy of the SUL text sit in a `packages`
 * directory whose whole purpose is to NOT be under those terms. The phrase is
 * the cheapest evidence that the file is the licence the root LICENSE promised
 * would be there; it does not verify the full text, and no string match could.
 */
export const CARVE_OUT_LICENSE_MARKER = {
  packages: "Apache License",
  enterprise: "Enterprise License",
};

/** The root licence, named once so the gate and its message cannot disagree. */
export const ROOT_LICENSE_FILE = "LICENSE";

/**
 * The marker naming the root licence itself — the mirror, for the tree's own
 * terms, of `CARVE_OUT_LICENSE_MARKER` for a carve-out's. It exists because
 * this gate no longer judges only this workspace: the private cloud workspace
 * consumes it as part of the harness (delivery playbook §6, round 31), and its
 * root LICENSE is an all-rights-reserved notice, not the SUL text. Deriving
 * the root slug from the LICENSE a tree actually ships lets one gate judge
 * both geometries without either tree carrying a copy of the rule.
 */
export const ROOT_LICENSE_MARKER = "Sustainable Use License";

/** The licence slug a tree's own root LICENSE text declares. */
export function rootLicenseSlug(licenseText) {
  return (licenseText ?? "").includes(ROOT_LICENSE_MARKER) ? "sul" : "proprietary";
}

/**
 * What a `package.json` must declare for each licence slug.
 *
 * Every value is a valid SPDX expression. Only Apache has a registered
 * identifier; SPDX's `LicenseRef-<idstring>` form exists for the rest, and its
 * grammar (`1*(ALPHA / DIGIT / "-" / "." )`) admits both names below.
 *
 * npm's other documented escape hatch, `SEE LICENSE IN <file>`, is deliberately
 * NOT used, and the reason is a defect it caused here. npm resolves that string
 * against the file at the *package* root — so in `shared/libs/doctrine`, whose
 * package root holds the CC BY-SA licence covering its documents, the manifest
 * declared the TypeScript modules beside them to be under a ShareAlike copyleft.
 * Four other packages carried the same string with no such file at all, leaving
 * a dangling pointer. A `LicenseRef-` names the terms directly, so it cannot
 * resolve to the wrong file or to no file, and SBOM tooling parses it instead of
 * escalating it to a human as "unknown".
 *
 * **Both `LicenseRef-` names carry their document's version**, for the reason
 * the form exists: an unversioned reference names a moving target, and a reader
 * holding the tree cannot tell which text governed it. Each licence document
 * lets the licensor publish a later version without touching a licence already
 * granted, so the version is exactly what distinguishes them. A version bump is
 * one edit here rather than one per manifest, which is the whole point of this
 * constant.
 */
export const MANIFEST_LICENSE = {
  sul: "LicenseRef-Ecoma-SustainableUse-1.0",
  apache: "Apache-2.0",
  ee: "LicenseRef-Ecoma-Enterprise-1.0",
  proprietary: "UNLICENSED",
};

/**
 * The licence slug governing a repo-relative path.
 *
 * `shared/libs/doctrine` resolves to `sul` and that is not an oversight: the
 * root LICENSE's third carve-out covers the *prose* in that directory, while
 * the `src/` modules beside it are ordinary SUL code. This axis names the tag
 * that constrains imports, and prose has no imports.
 */
export function licenseForPath(path) {
  const segments = path.split("/");
  if (segments[0] === "cloud") return "proprietary";
  if (segments.length > 1 && CARVE_OUT_DIRS[segments[1]]) return CARVE_OUT_DIRS[segments[1]];
  return "sul";
}
