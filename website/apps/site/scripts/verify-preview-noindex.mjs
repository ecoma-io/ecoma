// Deterministic gate for the true half of the preview-noindex contract
// (site/CLAUDE.md): a NUXT_PUBLIC_PREVIEW=true build must put the robots
// noindex meta in every prerendered page, and the default build must carry
// none. Three `nuxt generate` passes — default, preview, default — so dist/
// is restored to its production state when the script exits.
//
// The e2e suite pins the false half against the built artifact; this target
// pins the true half, which would need a second build the suite does not run.

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const siteDir = fileURLToPath(new URL("../", import.meta.url));
const nuxtCli = join(repoRoot, "node_modules/nuxt/bin/nuxt.mjs");

// 200.html/404.html are client-rendered fallbacks the head plugin never
// touches; the contract applies to the prerendered pages.
function prerenderedHtmlFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "200.html" || entry.name === "404.html") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) prerenderedHtmlFiles(full, files);
    else if (entry.name.endsWith(".html")) files.push(full);
  }
  return files;
}

const NOINDEX = 'name="robots" content="noindex, nofollow"';

function assertNoindex(expectNoindex) {
  const offenders = [];
  for (const file of prerenderedHtmlFiles(join(siteDir, "dist"))) {
    const has = readFileSync(file, "utf8").includes(NOINDEX);
    if (has !== expectNoindex) offenders.push(`${file}: noindex=${has}`);
  }
  if (offenders.length > 0) {
    throw new Error(
      `${expectNoindex ? "a preview build missing noindex" : "a default build carrying noindex"}:\n${offenders.join("\n")}`,
    );
  }
}

function generate(extraEnv) {
  const result = spawnSync(process.execPath, [nuxtCli, "generate"], {
    cwd: siteDir,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log("1/3 default build — must carry no noindex meta");
generate({});
assertNoindex(false);

console.log(
  "2/3 preview build (NUXT_PUBLIC_PREVIEW=true) — every prerendered page must be noindex",
);
generate({ NUXT_PUBLIC_PREVIEW: "true" });
assertNoindex(true);

console.log("3/3 rebuilding default so dist/ is back to its production state");
generate({});
assertNoindex(false);

console.log("preview-noindex contract holds");
