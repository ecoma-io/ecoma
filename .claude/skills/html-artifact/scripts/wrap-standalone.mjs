#!/usr/bin/env node
// Wrap an Artifact-format HTML file (body content only) into a full standalone document
// for SendUserFile / saving to disk. Deterministic transform — never hand-write the skeleton.
// Usage: node wrap-standalone.mjs <artifact.html> <out.html>
import { readFileSync, writeFileSync } from "node:fs";

const [inFile, outFile] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!inFile || !outFile) {
  console.error("usage: node wrap-standalone.mjs <artifact.html> <out.html>");
  process.exit(2);
}

const src = readFileSync(inFile, "utf8").replace(/^\uFEFF/, "");
if (/^\uFEFF?\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s|<html[\s>])/i.test(src)) {
  console.error(`${inFile} already has a document skeleton — nothing to wrap`);
  process.exit(1);
}

const title = (/<title>([\s\S]*?)<\/title>/i.exec(src)?.[1] ?? "").trim();
const body = src.replace(/<title>[\s\S]*?<\/title>\s*/gi, "");

if (/class=["'][^"']*\bmermaid\b/.test(src)) {
  console.error(
    "WARN: mermaid blocks render only in the Artifact viewer — in a standalone file they show as raw text; replace them with inline SVG first",
  );
}

writeFileSync(
  outFile,
  `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
</head>
<body>
${body}
</body>
</html>
`,
);
console.log(
  `wrote ${outFile}${title ? ` (title: ${title})` : ""} — validate: node check.mjs ${outFile} --standalone`,
);
