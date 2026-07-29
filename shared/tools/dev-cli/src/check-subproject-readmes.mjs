/**
 * Enforces the subproject README contract: every git-tracked `project.json`'s
 * directory carries all 3 language variants (`README.md`, `README.vi.md`,
 * `README.zh.md` — root CLAUDE.md, Documentation), each opening with the
 * canonical frontmatter block, fixed order:
 *
 *   ---
 *   name: <Nx project name, from the sibling project.json>
 *   subsystem: <top-level directory the project lives under>
 *   lang: en | vi | zh
 *   description: <one line, 20–200 chars, in this file's own language>
 *   ---
 *
 * followed by the shared nav line, an `# H1` naming the project, and the 5
 * fixed section markers (`readme-schema.mjs`) — the shape 4 of the 6
 * pre-existing subproject READMEs had already converged on informally
 * (why it exists / who consumes it / ecosystem position / boundary /
 * status). Existence + structure only; content quality stays on review, same
 * boundary as `check-claude-md`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { listTrackedFiles } from "./tracked-files.mjs";

import {
  auditClaudeMdPointer,
  auditDescription,
  auditNavLine,
  auditSectionMarkers,
  auditTitle,
  auditTokenParity,
  LANGS,
  readmeFilename,
} from "./readme-schema.mjs";

const SUBPROJECT_FRONTMATTER_RE =
  /^---\r?\nname: (.+)\r?\nsubsystem: (.+)\r?\nlang: (.+)\r?\ndescription: (.+)\r?\n---(?:\r?\n|$)/;

/**
 * Errors for one project's one language variant (empty array = compliant).
 * `content` is null when that variant is missing entirely. `projectName` is
 * the project's own `project.json` `name` (ground truth, not the directory
 * basename); `subsystem` is the top-level directory it lives under.
 */
export function auditSubprojectReadme(projectDir, subsystem, projectName, lang, content) {
  const file = `${projectDir}/${readmeFilename(lang)}`;
  if (content === null) {
    return [`${file}: missing — every Nx subproject carries a README in all 3 language variants`];
  }
  const m = SUBPROJECT_FRONTMATTER_RE.exec(content);
  if (!m) {
    return [
      `${file}: must open with the canonical frontmatter block — ` +
        `"---\\nname: ${projectName}\\nsubsystem: ${subsystem}\\nlang: ${lang}\\ndescription: <one line>\\n---" (fixed order, nothing else inside)`,
    ];
  }
  const [, rawName, rawSubsystem, rawLang, rawDescription] = m;
  const name = rawName.trim();
  const fileSubsystem = rawSubsystem.trim();
  const fileLang = rawLang.trim();
  const description = rawDescription.trim();
  const rest = content.slice(m[0].length);

  const errors = [];
  if (name !== projectName) {
    errors.push(
      `${file}: frontmatter name is "${name}" — must equal the project.json name ("${projectName}")`,
    );
  }
  if (fileSubsystem !== subsystem) {
    errors.push(`${file}: frontmatter subsystem is "${fileSubsystem}" — must equal "${subsystem}"`);
  }
  if (fileLang !== lang) {
    errors.push(
      `${file}: frontmatter lang is "${fileLang}" — must equal "${lang}" (its own filename)`,
    );
  }
  errors.push(...auditDescription(description).map((e) => `${file}: ${e}`));
  errors.push(...auditNavLine(lang, rest).map((e) => `${file}: ${e}`));
  errors.push(...auditTitle(name, rest).map((e) => `${file}: ${e}`));
  errors.push(...auditSectionMarkers(rest).map((e) => `${file}: ${e}`));
  errors.push(...auditClaudeMdPointer(rest).map((e) => `${file}: ${e}`));
  return errors;
}

/**
 * Audit errors for every project's 3 README variants, given the tracked
 * `project.json` paths and injectable file reader/existence check (kept
 * unit-testable without a real filesystem).
 */
export function findProjectReadmeIssues(
  projectFiles,
  readFile = readFileSync,
  exists = existsSync,
) {
  const errors = [];
  for (const projectFile of projectFiles) {
    const projectDir = dirname(projectFile);
    const subsystem = projectDir.split("/")[0];

    let projectName;
    try {
      projectName = JSON.parse(readFile(projectFile, "utf8")).name;
    } catch {
      continue; // malformed project.json is another gate's concern
    }
    if (!projectName) continue;

    const names = new Set();
    const bodies = {};
    for (const lang of LANGS) {
      const file = join(projectDir, readmeFilename(lang));
      const content = exists(file) ? readFile(file, "utf8") : null;
      errors.push(...auditSubprojectReadme(projectDir, subsystem, projectName, lang, content));
      const m = content === null ? null : SUBPROJECT_FRONTMATTER_RE.exec(content);
      if (m) {
        names.add(m[1].trim());
        bodies[lang] = content.slice(m[0].length);
      }
    }
    if (names.size > 1) {
      errors.push(
        `${projectDir}: the 3 README variants disagree on frontmatter name (${[...names].sort().join(", ")}) — must be byte-identical`,
      );
    }
    errors.push(...auditTokenParity(bodies).map((e) => `${projectDir}/${e}`));
  }
  return errors;
}

/** Scans every git-tracked project.json's subproject README triad. Returns a process exit code. */
export function checkSubprojectReadmes() {
  const files = listTrackedFiles(["*project.json"])
    .join("\n")
    .split("\n")
    .filter((f) => basename(f) === "project.json");

  const errors = findProjectReadmeIssues(files);
  for (const error of errors) console.error(error);
  return errors.length > 0 ? 1 : 0;
}
