/**
 * Shared schema/audit helpers for the README governance contract (root
 * CLAUDE.md, Documentation): every subsystem-root and subproject README
 * exists in 3 language variants (`README.md` = English/canonical,
 * `README.vi.md`, `README.zh.md`), cross-referencing each other by filename
 * convention alone (no "points-to-sibling" frontmatter field — a total
 * function beats a driftable path). Consumed by both
 * `check-subsystem-readmes.mjs` and
 * `check-subproject-readmes.mjs` so the two gates can never disagree on what
 * a "variant", a nav line, or a section marker is. Each frontmatter's own
 * shape (which fields, what order) stays in its owning gate — this module
 * only covers what both kinds share: language, nav line, title, description
 * bounds, technical-token parity, and (for subprojects) the fixed section
 * markers.
 */

import { createRequire } from "node:module";

// The triad is a workspace-level value, not this gate's own: repo-care's
// thread translation names the same languages, so both read one root config
// (Rule 14 rung 2) instead of each declaring a copy — see that file's
// `$comment` for why it sits at the root rather than in either tool.
//
// Loaded via `createRequire`, deliberately neither a static import nor
// `node:fs`: the config sits outside this Nx project, so a relative import is
// an edge the project graph cannot see (`@nx/enforce-module-boundaries` rejects
// it), while this module's unit-test callers mock `node:fs` wholesale to
// exercise path handling — a static config must not become the reason those
// mocks have to know about it.
const languagesConfig = createRequire(import.meta.url)("../../../../languages.config.json");

export const LANGS = languagesConfig.languages.map((l) => l.code);

const LANG_LABELS = Object.fromEntries(languagesConfig.languages.map((l) => [l.code, l.label]));

const DESCRIPTION_MIN = 20;
const DESCRIPTION_MAX = 200;

export const SUBPROJECT_SECTIONS = [
  "<!-- readme:why -->",
  "<!-- readme:consumers -->",
  "<!-- readme:ecosystem -->",
  "<!-- readme:boundary -->",
  "<!-- readme:status -->",
];

function assertKnownLang(lang) {
  if (!LANGS.includes(lang)) {
    throw new Error(`readme-schema: unknown lang "${lang}" — expected one of ${LANGS.join(", ")}`);
  }
}

/** The canonical filename for a language variant (`en` is the un-suffixed `README.md`). */
export function readmeFilename(lang) {
  assertKnownLang(lang);
  return lang === "en" ? "README.md" : `README.${lang}.md`;
}

/**
 * The exact language-switcher nav line a variant must open its body with —
 * `lang`'s own segment is bold and unlinked, the other two link to their
 * sibling filename. Fixed per language, so there is no 3x3 translation
 * matrix to keep in sync — only 3 constants.
 */
export function expectedNavLine(lang) {
  assertKnownLang(lang);
  const segments = LANGS.map((l) =>
    l === lang ? `**${LANG_LABELS[l]}**` : `[${LANG_LABELS[l]}](./${readmeFilename(l)})`,
  );
  return `> 🌐 ${segments.join(" · ")}`;
}

/**
 * Audits the nav line for a variant. `rest` is the file content starting
 * immediately after the frontmatter's closing `---` line (i.e. what the
 * caller's own frontmatter regex left unmatched).
 */
export function auditNavLine(lang, rest) {
  const expected = expectedNavLine(lang);
  const normalized = rest.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`\n${expected}\n`)) {
    return [`must open with a blank line then the language-switcher nav line: "${expected}"`];
  }
  return [];
}

/** Audits the `# H1` heading: must exist and name `name`, case-insensitively. */
export function auditTitle(name, rest) {
  const h1 = rest.split("\n").find((line) => /^#\s+/.test(line));
  if (!h1) return [`must contain a top-level "# " heading naming "${name}"`];
  if (!h1.toLowerCase().includes(name.toLowerCase())) {
    return [`top-level heading "${h1.trim()}" must contain "${name}" (case-insensitive)`];
  }
  return [];
}

/** Audits a frontmatter `description` value against the shared length bounds. */
export function auditDescription(description) {
  if (description.length < DESCRIPTION_MIN || description.length > DESCRIPTION_MAX) {
    return [
      `description must be ${DESCRIPTION_MIN}–${DESCRIPTION_MAX} chars (got ${description.length})`,
    ];
  }
  return [];
}

/**
 * Audits a subproject README body for the 5 fixed, ordered section markers.
 * Matched as literal strings (never translated heading prose), so the same
 * check holds across all 3 language variants.
 */
export function auditSectionMarkers(body) {
  const errors = [];
  let lastIndex = -1;
  for (const marker of SUBPROJECT_SECTIONS) {
    const index = body.indexOf(marker);
    if (index === -1) {
      errors.push(`missing required section marker ${marker}`);
      continue;
    }
    if (index < lastIndex) {
      errors.push(
        `section marker ${marker} is out of order — expected order: ${SUBPROJECT_SECTIONS.join(", ")}`,
      );
    }
    lastIndex = Math.max(lastIndex, index);
  }
  return errors;
}

/**
 * The set of inline code spans in a README body — its technical tokens.
 *
 * Normalized the way a renderer normalizes them, not the way they are typed:
 * CommonMark converts a line ending inside a code span to a space, so a
 * hyphenated name wrapped across two source lines renders as `repo- care`,
 * genuinely a different token than `repo-care`. Comparing rendered form is
 * what makes this catch that class of typo instead of forgiving it, while
 * still ignoring a wrap that changes nothing (`implicitDependencies:
 * ["core-ui"]` broken after the colon renders identically either way).
 *
 * Fenced blocks are stripped first: their content is a sample rather than a
 * token, and the inline scan would otherwise run across fence boundaries and
 * emit garbage. A set, not a multiset — how many times a translation repeats
 * a name is a prose decision, which of them it names is not.
 */
export function technicalTokens(body) {
  const withoutFences = body.replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1/gm, "\n");
  const tokens = new Set();
  for (const [, span] of withoutFences.matchAll(/`([^`]+)`/g)) {
    const token = span.replace(/\s+/g, " ").trim();
    if (token) tokens.add(token);
  }
  return tokens;
}

/**
 * Audits that every language variant names the same technical tokens as the
 * English canonical one. `bodiesByLang` maps a language to its README body
 * (post-frontmatter); a language absent from the map is skipped, since its
 * own variant audit already reported why.
 *
 * This is the machine-decidable half of the 3-variant agreement rule (root
 * CLAUDE.md, Documentation). Whether two prose paragraphs *mean* the same
 * thing is a judgment call and stays advisory with `repo-care`; whether they
 * name the same commands, paths and API names is not a judgment call at all,
 * and Rule 12 already draws that exact line — prose compresses, technical
 * tokens stay exact. The realistic failure it catches: a fact lands in
 * `README.md` and the two translations are left behind.
 */
export function auditTokenParity(bodiesByLang) {
  if (bodiesByLang.en === undefined) return [];
  const reference = technicalTokens(bodiesByLang.en);
  const errors = [];
  for (const lang of LANGS) {
    if (lang === "en" || bodiesByLang[lang] === undefined) continue;
    const tokens = technicalTokens(bodiesByLang[lang]);
    const missing = [...reference].filter((t) => !tokens.has(t)).sort();
    const extra = [...tokens].filter((t) => !reference.has(t)).sort();
    if (missing.length === 0 && extra.length === 0) continue;
    const parts = [];
    if (missing.length > 0) parts.push(`absent here: ${missing.map((t) => `\`${t}\``).join(", ")}`);
    if (extra.length > 0)
      parts.push(`absent from ${readmeFilename("en")}: ${extra.map((t) => `\`${t}\``).join(", ")}`);
    errors.push(
      `${readmeFilename(lang)}: technical tokens must match ${readmeFilename("en")} — ${parts.join("; ")}. ` +
        `Prose is translated, technical tokens are not (Rule 12); a token that differs only by a space is an inline code span wrapped across two source lines, which renders with that space in it.`,
    );
  }
  return errors;
}

/** Audits that the status section links to the project's own CLAUDE.md. */
export function auditClaudeMdPointer(body) {
  const statusIndex = body.indexOf("<!-- readme:status -->");
  if (statusIndex === -1) return []; // auditSectionMarkers already reports the missing marker
  if (!body.slice(statusIndex).includes("./CLAUDE.md")) {
    return ["the status section (<!-- readme:status -->) must link to ./CLAUDE.md"];
  }
  return [];
}
