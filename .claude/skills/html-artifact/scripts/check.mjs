#!/usr/bin/env node
// Static checks for standalone HTML artifacts (see ../SKILL.md).
// Usage: node check.mjs <file.html> [--standalone]
//   default:      Artifact-tool format (body content only, no document skeleton)
//   --standalone: full self-contained file (skeleton + viewport meta required)
import { readFileSync } from "node:fs";
import vm from "node:vm";

const args = process.argv.slice(2);
const standalone = args.includes("--standalone");
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: node check.mjs <file.html> [--standalone]");
  process.exit(2);
}

const src = readFileSync(file, "utf8");
const findings = [];
const lineOf = (i) => src.slice(0, i).split("\n").length;
const add = (sev, line, msg) => findings.push({ sev, line, msg });
const scan = (re, sev, msg) => {
  for (const m of src.matchAll(re)) add(sev, lineOf(m.index), msg);
};

// --- file format ---
const startsWithSkeleton =
  /^\uFEFF?\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s|<html[\s>]|<head[\s>]|<body[\s>])/i.test(src);
if (standalone) {
  if (!startsWithSkeleton)
    add("ERROR", 1, "standalone file must start with <!doctype html> and a full skeleton");
  if (!/<meta\b(?=[^>]*name=["']viewport["'])[^>]*\bwidth\s*=\s*device-width/i.test(src)) {
    add("ERROR", 1, 'missing <meta name="viewport" content="width=device-width, initial-scale=1">');
  }
} else if (startsWithSkeleton) {
  add(
    "ERROR",
    1,
    "Artifact files are body-content only — remove <!doctype>/<html>/<head>/<body> (the Artifact tool adds the skeleton); use --standalone if this file is self-hosted instead",
  );
}

// --- leftover template markers ---
scan(/TODO_REPLACE/g, "ERROR", "template placeholder TODO_REPLACE still present");

// --- external / missing resources (the Artifact CSP blocks external; relative has no siblings) ---
// Text-pattern scans run on a masked copy with <pre>/<code> contents blanked so displayed code
// samples don't trip build-blocking errors. Tag scans stay on the real source (an unescaped
// <script src> inside <pre> still executes).
const masked = src.replace(/<(pre|code)\b[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, " "));
const scanMasked = (re, sev, msg) => {
  for (const m of masked.matchAll(re)) add(sev, lineOf(m.index), msg);
};
scan(
  /<(?:script|img|iframe|video|audio|source|embed|object|track)\b[^>]*\b(?:src|srcset|data|poster)\s*=\s*["']?\s*(?:https?:)?\/\//gi,
  "ERROR",
  "external resource load — CSP blocks it; inline it or use a data: URI",
);
scan(
  /<(?:script|img|iframe|video|audio|source|embed|object|track)\b[^>]*\b(?:src|poster)\s*=\s*["'](?!\s*(?:data:|about:|https?:|\/\/))[^"']+["']/gi,
  "ERROR",
  "relative asset reference — an artifact is a single file with no siblings; inline it as a data: URI",
);
scan(
  /<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//gi,
  "ERROR",
  "external <link> — CSP blocks it; inline the stylesheet/asset",
);
scan(
  /<link\b[^>]*\bhref\s*=\s*["'](?!\s*(?:data:|https?:|\/\/))[^"']+["']/gi,
  "ERROR",
  "relative <link> href — an artifact is a single file with no siblings; inline it",
);
scanMasked(
  /@import\b[^;{\n]*\/\//g,
  "ERROR",
  "@import of external CSS — CSP blocks it; inline the styles",
);
scanMasked(
  /url\(\s*["']?\s*(?:https?:)?\/\//gi,
  "ERROR",
  "external url() in CSS — CSP blocks it; use a data: URI",
);
scanMasked(
  /url\(\s*["']?(?!\s*["')]|\s*(?:data:|#|https?:|\/\/))[^"')]+/gi,
  "ERROR",
  "relative url() in CSS — an artifact is a single file with no siblings; use a data: URI",
);
scanMasked(
  /\bfetch\s*\(\s*["'`]\s*(?:https?:)?\/\//g,
  "ERROR",
  "fetch() to an external host — CSP blocks it",
);
scanMasked(/new\s+WebSocket\s*\(/g, "ERROR", "WebSocket — CSP blocks external connections");
scanMasked(
  /\bimport\s*(?:[\w${}\s,*]*\bfrom\s*)?\(?\s*["'`]\s*(?:https?:)?\/\//g,
  "ERROR",
  "ES module import from an external URL — CSP blocks it; inline the code as a classic script",
);
// Markup-position scan only: an iframe assembled inside a <script> string gets its srcdoc from JS.
const scriptMasked = masked.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (m) =>
  m.replace(/[^\n]/g, " "),
);
for (const m of scriptMasked.matchAll(/<iframe\b(?![^>]*\bsrcdoc\s*=)[^>]*>/gi)) {
  add(
    "WARN",
    lineOf(m.index),
    "iframe without srcdoc — the artifact CSP blocks external pages; inline the content or split it into a separate artifact",
  );
}

// --- inline script syntax (a parse error kills every script on the page silently) ---
for (const m of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const attrs = m[1] || "";
  if (/\bsrc\s*=/i.test(attrs)) continue; // external/relative src handled above
  const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1] || "").toLowerCase();
  if (type && !["text/javascript", "application/javascript"].includes(type)) continue; // module/JSON/templates
  const code = m[2];
  if (!code.trim()) continue;
  try {
    new vm.Script(code, { filename: "inline" });
  } catch (e) {
    const inner = +(String(e.stack).match(/^inline:(\d+)/)?.[1] || 1);
    add(
      "ERROR",
      lineOf(m.index) + inner - 1,
      `inline <script> does not parse — ${e.message} (a syntax error disables all interactivity on the page)`,
    );
  }
}

// --- theming ---
const hasPrefers = /prefers-color-scheme/.test(src);
const hasThemeAttr = /\[data-theme=/.test(src);
if (hasPrefers && !hasThemeAttr) {
  add(
    "WARN",
    1,
    "has @media (prefers-color-scheme) but no :root[data-theme=…] overrides — the viewer theme toggle will not win",
  );
}
if (hasThemeAttr && !hasPrefers) {
  add(
    "WARN",
    1,
    "has :root[data-theme=…] overrides but no @media (prefers-color-scheme) — the OS preference will not apply before the viewer toggle is touched",
  );
}
if (!hasPrefers && !hasThemeAttr) {
  add(
    "WARN",
    1,
    "no dark/light handling found — single-theme must be a deliberate choice, not an omission",
  );
}

// --- responsive red flags ---
const tableAt = src.search(/<table\b/i);
if (tableAt !== -1 && !/overflow-x/.test(src)) {
  add(
    "WARN",
    lineOf(tableAt),
    "tables present but no overflow-x container — wide tables will overflow the page on phones",
  );
}
scan(/100vw/g, "WARN", "100vw includes the scrollbar and causes horizontal overflow — use 100%");
scan(/100vh/g, "WARN", "100vh breaks under the mobile URL bar — use 100svh");
for (const m of src.matchAll(/(?<![-\w])(?<!\(\s*)width\s*:\s*(\d+)px/g)) {
  if (+m[1] >= 500)
    add(
      "WARN",
      lineOf(m.index),
      `fixed width ${m[1]}px — must live inside an overflow-x:auto container or scale down on phones`,
    );
}
for (const m of src.matchAll(/(?<!\(\s*)\bmin-width\s*:\s*(\d+)px/g)) {
  if (+m[1] >= 500)
    add(
      "WARN",
      lineOf(m.index),
      `min-width ${m[1]}px forces horizontal overflow on phones — needs an overflow-x:auto ancestor or a smaller floor`,
    );
}
for (const m of src.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/g)) {
  if (+m[1] < 12) add("WARN", lineOf(m.index), `font-size ${m[1]}px is below the 12px floor`);
}
for (const m of src.matchAll(/font-size\s*:\s*(\d*\.?\d+)(r?em)/g)) {
  if (+m[1] < 0.75)
    add(
      "WARN",
      lineOf(m.index),
      `font-size ${m[1]}${m[2]} is below the 12px floor at the default 16px root`,
    );
}
scan(
  /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?:\.0)?\b/gi,
  "ERROR",
  "zoom disabled — never block pinch-zoom (responsive contract: hard rule, not a preference)",
);

// --- misc ---
if (standalone && /class=["'][^"']*\bmermaid\b/.test(src)) {
  add(
    "WARN",
    lineOf(src.search(/class=["'][^"']*\bmermaid\b/)),
    "mermaid renders only in the Artifact viewer — a standalone file shows raw text; use inline SVG instead",
  );
}
if (!/<title>/i.test(src))
  add("INFO", 1, "no <title> — the Artifact tab/gallery name falls back to the filename");
if (src.length > 300_000)
  add("INFO", 1, `file is ${Math.round(src.length / 1024)}KB — consider trimming embedded assets`);

// --- report ---
const rank = { ERROR: 0, WARN: 1, INFO: 2 };
findings.sort((a, b) => rank[a.sev] - rank[b.sev] || a.line - b.line);
for (const f of findings)
  console.log(`${f.sev.padEnd(5)} L${String(f.line).padStart(4)}  ${f.msg}`);
const errors = findings.filter((f) => f.sev === "ERROR").length;
const warns = findings.filter((f) => f.sev === "WARN").length;
console.log(`${errors ? "FAIL" : "OK"} — ${errors} error(s), ${warns} warning(s)`);
process.exit(errors ? 1 : 0);
