import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitepress";

// The doctrine library is imported by RELATIVE PATH, which the workspace
// otherwise forbids, and the exemption is scoped to this one line.
//
// VitePress loads this file through Vite's config loader, which bundles it with
// rolldown under `tsconfig: false` and externalises every bare specifier it can
// resolve through Node. `@ecoma-io/doctrine` is a tsconfig `paths` alias and
// nothing else — there is no `node_modules/@ecoma-io/doctrine` in a
// single-package monorepo — so the alias form does not fail at type level, it
// fails at run time with ERR_MODULE_NOT_FOUND while the config is being loaded.
// A relative specifier is not externalised: rolldown resolves and bundles the
// library's TypeScript into the config, which is why this form works and the
// alias cannot. `design-system`'s `tailwind.config.js` carries the same
// exemption for the same class of reason (a tool that resolves neither tsconfig
// paths nor Vite aliases), and `project.json` still declares the graph edge.
// eslint-disable-next-line @nx/enforce-module-boundaries -- the config bundler cannot resolve the alias; see the paragraph above
import { buildNav, extractTitle, groupVariants } from "../../../libs/doctrine/src/index";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * The published tree, named once. VitePress wants it relative to this app and
 * the scan below wants it absolute; two spellings of one directory is how a
 * renderer starts reading somewhere its own navigation does not.
 */
const DOCTRINE_SRC_DIR = "../../libs/doctrine";
const DOCTRINE_ROOT = fileURLToPath(new URL(`../${DOCTRINE_SRC_DIR}/`, import.meta.url));

/**
 * The workspace's language triad, from the one file that holds it (see
 * `shared/CLAUDE.md`). The list is ordered and its first entry is the canonical
 * language, so the rest are exactly the suffixes a translation may carry.
 */
const { languages } = JSON.parse(
  readFileSync(join(REPO_ROOT, "languages.config.json"), "utf8"),
) as { languages: { code: string; label: string }[] };
const CANONICAL_LANG = languages[0].code;
const VARIANT_LANGS = languages.slice(1).map((language) => language.code);
const LANGUAGE_LABELS = new Map(languages.map((language) => [language.code, language.label]));

/**
 * Reading order — the order a reader should meet the sections in, which is a
 * content decision and the one thing here that is declared rather than derived.
 * Alphabetical would put `charter` ahead of `north-star`, which is not an order
 * anyone chose.
 *
 * Declaring it by hand is safe only because `buildNav` checks it in both
 * directions against the tree: a section the tree grows without a line here
 * fails the build, and so does a line here the tree no longer has. Remove that
 * check and this list silently starts hiding documents.
 */
const SECTION_ORDER = ["overview", "north-star", "spec", "charter", "method"];

/**
 * The tree has no document at its root — `buildNav` refuses one — so nothing
 * renders at the mount point itself, and the mount point must answer: the edge
 * router serves this site at `/doctrine/` and a reader who types that is owed a
 * page. The first section's own index is the front door, derived from the
 * reading order so that "the front door" and "the first thing to read" stay one
 * fact rather than two that can disagree.
 *
 * It is reached by a redirect emitted in `buildEnd`, deliberately NOT by
 * VitePress's `rewrites`. Rewriting this document to the site root moves the
 * directory its own relative links resolve against: `../north-star/platform.md`
 * becomes `./../north-star/platform`, which climbs out of the mount entirely.
 * Verified — the build reports it as a dead link. A rewrite here would make
 * "the tree's index may not link to its siblings the ordinary way" a rule of
 * this app, imposed on documents this app has no business constraining.
 */
const FRONT_DOOR = `${SECTION_ORDER[0]}/index.md`;

/**
 * The tree root holds the doctrine project's own convention files and no
 * document. They are excluded by NAME rather than by position on purpose: a
 * doctrine document misfiled at the root then still reaches `buildNav`, which
 * refuses it loudly, instead of being quietly dropped by this scan.
 */
const PROJECT_FILES = ["CLAUDE.md", "README.md", "README.*.md"];

/** Every Markdown file under `dir`, as paths relative to it. */
function listMarkdown(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listMarkdown(join(dir, entry.name), path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

/**
 * Order within a section: a section's own index first, then alphabetical.
 *
 * Deliberately not a declared list, unlike the section order above. A reading
 * order over twenty-odd sibling specifications would have to be hand-kept, and
 * nothing checks it — a document added to the tree would simply be missing from
 * it. Alphabetical is not a reading order, and it does not pretend to be one:
 * the tree states its own reading order in prose, in `overview/index.md`.
 */
function byReadingOrder(a: string, b: string): number {
  if (dirname(a) !== dirname(b)) return dirname(a) < dirname(b) ? -1 : 1;
  if (basename(a) === "index.md") return -1;
  if (basename(b) === "index.md") return 1;
  return basename(a) < basename(b) ? -1 : 1;
}

const documentPaths = listMarkdown(DOCTRINE_ROOT)
  .filter(
    (path) =>
      dirname(path) !== "." || !PROJECT_FILES.some((glob) => matchesGlob(basename(path), glob)),
  )
  .sort(byReadingOrder);

const sources = new Map(
  documentPaths.map((path) => [path, readFileSync(join(DOCTRINE_ROOT, path), "utf8")]),
);

const canonicals = groupVariants(documentPaths, VARIANT_LANGS);

if (!documentPaths.includes(FRONT_DOOR)) {
  throw new Error(
    `doctrine-site: the mount point redirects to ${FRONT_DOOR}, which the tree does not have`,
  );
}

/** A document's URL: `spec/role.md` → `/spec/role`, `x/index.md` → `/x/`. */
function link(path: string): string {
  if (basename(path) === "index.md") return `/${dirname(path)}/`;
  return `/${path.slice(0, -".md".length)}`;
}

/** `north-star` → `North Star`. A section's label, derived rather than mapped. */
function sectionLabel(id: string): string {
  return id
    .split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * A document's own language. Declared in its frontmatter while the tree is
 * mid-conversion; absent means the canonical language. Read from the document
 * rather than assumed, so the switcher never labels a page in a language it is
 * not written in.
 */
function declaredLang(path: string): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(sources.get(path) ?? "");
  return /^lang:\s*(\S+)\s*$/m.exec(frontmatter?.[1] ?? "")?.[1] ?? CANONICAL_LANG;
}

/**
 * The language switcher, as page data rather than nav: a translation is the
 * same document, so it belongs on the page it translates and never in the
 * sidebar. Every page of one document — canonical and translations alike —
 * carries the same list, so the switch works in both directions.
 */
const languagesByPath = new Map<string, { lang: string; label: string; link: string }[]>();
for (const canonical of canonicals) {
  if (canonical.variants.length === 0) continue;
  const choices = [
    { lang: declaredLang(canonical.path), path: canonical.path },
    ...canonical.variants,
  ].map((choice) => ({
    lang: choice.lang,
    label: LANGUAGE_LABELS.get(choice.lang) ?? choice.lang,
    link: link(choice.path),
  }));
  for (const choice of [canonical.path, ...canonical.variants.map((v) => v.path)]) {
    languagesByPath.set(choice, choices);
  }
}

const sidebar = buildNav(
  canonicals.map(({ path }) => ({
    path,
    title: extractTitle(sources.get(path) as string, path),
  })),
  SECTION_ORDER,
).map((section) => ({
  text: sectionLabel(section.id),
  collapsed: false,
  items: section.docs.map((doc) => ({ text: doc.title, link: link(doc.path) })),
}));

export default defineConfig({
  title: "Ecoma Doctrine",
  description:
    "The design ecoma commits to: North Stars, specifications, charters and the review rubric.",
  // Mounted as a path on the one domain, beside /design and /hub — the edge
  // router owns the mount, this only has to agree with it (Website Charter).
  base: "/doctrine/",
  srcDir: DOCTRINE_SRC_DIR,
  outDir: "dist",
  cleanUrls: true,
  srcExclude: PROJECT_FILES,
  buildEnd({ outDir }) {
    const target = `.${link(FRONT_DOOR)}`;
    writeFileSync(
      join(outDir, "index.html"),
      `<!doctype html>
<meta charset="utf-8" />
<title>Ecoma Doctrine</title>
<link rel="canonical" href="${target}" />
<meta http-equiv="refresh" content="0; url=${target}" />
<p><a href="${target}">Ecoma Doctrine</a></p>
`,
    );
  },
  transformPageData(pageData) {
    const choices = languagesByPath.get(pageData.relativePath);
    if (!choices) return;
    return { frontmatter: { ...pageData.frontmatter, languages: choices } };
  },
  themeConfig: { sidebar },
});
