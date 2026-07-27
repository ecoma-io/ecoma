/**
 * Flags relative Markdown links whose target file no longer exists — the drift
 * class where a doc points at a moved/renamed/never-created path (e.g. a nested
 * CLAUDE.md that was described but never added). Scans `*.md`/`*.mdx`.
 *
 * Only local links to a Markdown file (`.md`/`.mdx`) are checked — that is the
 * drift class worth catching, and the narrow target keeps false positives at
 * zero. External URLs (http, mailto, …), in-page anchors (`#section`),
 * root-absolute site routes (`/route`), directory links, and links to non-doc
 * files (images, `LICENSE`, …) are all left alone.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Inline links and images: [text](target) / ![alt](target), with an optional
// "title" and optional <angle-bracket> target.
const LINK_RE = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

// Not a local file reference: skip protocols, anchors, and root-absolute paths.
const NON_LOCAL_RE = /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i;

/**
 * Returns `[{ target, line }]` for every relative Markdown link in `text` whose
 * resolved target is absent. `exists` is injectable so the resolution logic is
 * unit-testable without a real filesystem.
 */
export function findBrokenLinks(text, filePath, exists = existsSync) {
  const base = dirname(filePath);
  const broken = [];
  for (const m of text.matchAll(LINK_RE)) {
    let target = m[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    target = target.replace(/[?#].*$/, ""); // drop query/fragment
    if (!target || NON_LOCAL_RE.test(target) || !/\.mdx?$/i.test(target)) continue;
    if (!exists(resolve(base, target))) {
      broken.push({ target, line: text.slice(0, m.index).split("\n").length });
    }
  }
  return broken;
}

/** Scans every git-tracked Markdown file in the repo. Returns a process exit code. */
export function checkDocLinks() {
  const files = execFileSync("git", ["ls-files", "--", "*.md", "*.mdx"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

  let failed = false;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const { target, line } of findBrokenLinks(text, file)) {
      failed = true;
      console.error(`${file}:${line}: broken link '${target}' — target does not exist`);
    }
  }
  return failed ? 1 : 0;
}
