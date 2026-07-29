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
 * What a `package.json` must declare for each licence slug. Only Apache has an
 * SPDX identifier; the Sustainable Use License has none, so npm's documented
 * escape hatch (`SEE LICENSE IN <file>`) is the honest value rather than an
 * invented identifier that tooling would silently mis-resolve.
 */
export const MANIFEST_LICENSE = {
  sul: "SEE LICENSE IN LICENSE",
  apache: "Apache-2.0",
  ee: "LicenseRef-Ecoma-Enterprise",
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
