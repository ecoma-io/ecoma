import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The tree the site under test renders, and the site itself.
 *
 * Naming the tree here is the point of this suite rather than a shortcut around
 * it: what these tests prove is that the pages a browser opens come from these
 * documents and from no copy kept beside the app. A test that only read the
 * built output could not tell the two apart.
 */
const DOCTRINE_ROOT = fileURLToPath(new URL("../../../libs/doctrine/", import.meta.url));
const SITE_ROOT = fileURLToPath(new URL("../../doctrine-site/", import.meta.url));
const VITEPRESS_CLI = fileURLToPath(
  new URL("../../../../node_modules/vitepress/bin/vitepress.js", import.meta.url),
);

/** A document's location in the tree, given its path relative to the root. */
export function documentPath(relativePath: string): string {
  return join(DOCTRINE_ROOT, relativePath);
}

/**
 * A document's own `# H1` — the text the site is expected to show for it.
 *
 * Read at run time rather than written into the test, deliberately: a literal
 * copied out of a document is a second place the wording lives, and it would go
 * on passing after the document changed underneath it.
 */
export function headingOf(relativePath: string): string {
  const source = readFileSync(documentPath(relativePath), "utf8");
  const heading = /^#\s+(.+?)\s*$/m.exec(source);
  if (!heading) throw new Error(`${relativePath} has no H1 for the site to show`);
  return heading[1];
}

/**
 * Rebuilds the site in place, so the preview server serving `dist` picks the
 * result up on its next request.
 *
 * Building here rather than through the Nx target on purpose: the target caches
 * on its inputs, and a test that changes the tree needs the build that follows
 * that change, not the one Nx already has.
 */
export function rebuildSite(): void {
  execFileSync(process.execPath, [VITEPRESS_CLI, "build", "."], { cwd: SITE_ROOT, stdio: "pipe" });
}
