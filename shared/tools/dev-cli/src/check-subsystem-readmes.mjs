/**
 * Enforces the subsystem-root README contract: every top-level directory
 * holding tracked files (dot-dirs are workspace plumbing, not subsystems)
 * carries all 3 language variants (`README.md`, `README.vi.md`,
 * `README.zh.md` — root CLAUDE.md, Documentation), each opening with the
 * canonical frontmatter block, fixed order:
 *
 *   ---
 *   name: <directory name>
 *   lang: en | vi | zh
 *   description: <one line, 20–200 chars, in this file's own language>
 *   ---
 *
 * followed by the shared nav line and an `# H1` naming the directory
 * (`readme-schema.mjs`). The block is machine-read, not decoration:
 * `repo-care`'s `triage-issue` derives its area vocabulary and classifier
 * prompt from the English variant, so a missing or malformed block is a
 * triage outage, not a doc nit. The regex is duplicated in
 * `shared/tools/repo-care/src/triage-issue.mjs` on purpose — keep the two
 * identical (a cross-project source import would be an edge the Nx graph
 * cannot see).
 *
 * The repo root's own README is the one exception (root CLAUDE.md,
 * Documentation): it has no parent directory to name it and feeds no area
 * vocabulary, so it carries no frontmatter at all — `auditRootReadme` only
 * requires the 3 variants to exist and each to open with the nav line
 * cross-linking its two siblings. Technical-token parity still holds it,
 * though: that rule is about the 3 variants agreeing with each other, which
 * the missing parent directory has no bearing on.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { listTrackedFiles } from "./tracked-files.mjs";

import {
  auditDescription,
  auditNavLine,
  auditTitle,
  auditTokenParity,
  expectedNavLine,
  LANGS,
  readmeFilename,
} from "./readme-schema.mjs";

const SUBSYSTEM_FRONTMATTER_RE =
  /^---\r?\nname: (.+)\r?\nlang: (.+)\r?\ndescription: (.+)\r?\n---(?:\r?\n|$)/;

/** Subsystem roots: top-level non-dot directories that hold tracked files. */
export function deriveSubsystemRoots(trackedPaths) {
  const roots = new Set();
  for (const path of trackedPaths) {
    const top = path.split("/")[0];
    if (path.includes("/") && !top.startsWith(".")) roots.add(top);
  }
  return [...roots].sort();
}

/**
 * Errors for one subsystem root's one language variant (empty array =
 * compliant). `content` is null when that variant is missing entirely.
 */
export function auditSubsystemReadme(name, lang, content) {
  const file = `${name}/${readmeFilename(lang)}`;
  if (content === null) {
    return [`${file}: missing — every subsystem root declares its area in all 3 language variants`];
  }
  const m = SUBSYSTEM_FRONTMATTER_RE.exec(content);
  if (!m) {
    return [
      `${file}: must open with the canonical frontmatter block — ` +
        `"---\\nname: ${name}\\nlang: ${lang}\\ndescription: <one line>\\n---" (fixed order, nothing else inside)`,
    ];
  }
  const [, rawName, rawLang, rawDescription] = m;
  const parsedName = rawName.trim();
  const fileLang = rawLang.trim();
  const description = rawDescription.trim();
  const rest = content.slice(m[0].length);

  const errors = [];
  if (parsedName !== name) {
    errors.push(`${file}: frontmatter name is "${parsedName}" — must equal "${name}"`);
  }
  if (fileLang !== lang) {
    errors.push(
      `${file}: frontmatter lang is "${fileLang}" — must equal "${lang}" (its own filename)`,
    );
  }
  errors.push(...auditDescription(description).map((e) => `${file}: ${e}`));
  errors.push(...auditNavLine(lang, rest).map((e) => `${file}: ${e}`));
  errors.push(...auditTitle(name, rest).map((e) => `${file}: ${e}`));
  return errors;
}

/**
 * Errors for the repo root's one language variant (empty array = compliant).
 * No frontmatter, no title requirement — just existence and the
 * language-switcher nav line as the file's opening line.
 */
export function auditRootReadme(lang, content) {
  const file = readmeFilename(lang);
  if (content === null) {
    return [`${file}: missing — the repo root's README must exist in all 3 language variants`];
  }
  const normalized = content.replace(/\r\n/g, "\n");
  const expected = expectedNavLine(lang);
  if (!normalized.startsWith(`${expected}\n`)) {
    return [`${file}: must open with the language-switcher nav line: "${expected}"`];
  }
  return [];
}

/** Scans the repo root's + every subsystem root's README variants. Returns a process exit code. */
export function checkSubsystemReadmes() {
  const tracked = listTrackedFiles().join("\n").split("\n").filter(Boolean);
  const trackedSet = new Set(tracked);

  const errors = [];

  const rootBodies = {};
  for (const lang of LANGS) {
    const file = readmeFilename(lang);
    const content = trackedSet.has(file) ? readFileSync(file, "utf8") : null;
    errors.push(...auditRootReadme(lang, content));
    if (content !== null) rootBodies[lang] = content;
  }
  errors.push(...auditTokenParity(rootBodies));

  for (const name of deriveSubsystemRoots(tracked)) {
    const names = new Set();
    const bodies = {};
    for (const lang of LANGS) {
      const file = `${name}/${readmeFilename(lang)}`;
      const content = trackedSet.has(file) ? readFileSync(file, "utf8") : null;
      errors.push(...auditSubsystemReadme(name, lang, content));
      const m = content === null ? null : SUBSYSTEM_FRONTMATTER_RE.exec(content);
      if (m) {
        names.add(m[1].trim());
        bodies[lang] = content.slice(m[0].length);
      }
    }
    if (names.size > 1) {
      errors.push(
        `${name}: the 3 README variants disagree on frontmatter name (${[...names].sort().join(", ")}) — must be byte-identical`,
      );
    }
    errors.push(...auditTokenParity(bodies).map((e) => `${name}/${e}`));
  }

  for (const error of errors) console.error(error);
  return errors.length > 0 ? 1 : 0;
}
