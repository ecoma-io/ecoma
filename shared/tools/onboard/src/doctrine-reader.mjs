#!/usr/bin/env node
/**
 * Deterministic reader of the published doctrine tree.
 *
 * Reads `shared/libs/doctrine/` documents and extracts the end-state
 * architecture, roadmap, and known gaps. Pure — no side effects besides
 * reading files. Outputs JSON to stdout.
 *
 * Usage: node shared/tools/onboard/src/doctrine-reader.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DOCTRINE_ROOT = "shared/libs/doctrine";

/** Read a file relative to the repo root, return its text. */
function read(path) {
  return readFileSync(resolve(DOCTRINE_ROOT, path), "utf8");
}

/** Parse frontmatter `key: value` lines at the top of a markdown file. */
function frontmatter(text) {
  const fm = {};
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return fm;
  for (const line of match[1].split("\n")) {
    const [, k, v] = line.match(/^(\w+):\s*(.+)$/) || [];
    if (k) fm[k] = v;
  }
  return fm;
}

/** Extract table rows as arrays of cell strings from a section of text. */
function tableRows(text, sectionHeading) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(sectionHeading));
  if (start === -1) return [];
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.every((c) => /^-+$/.test(c))) continue;
    rows.push(cells);
  }
  return rows;
}

/** Extract the canonical glossary from overview/index.md. */
function parseGlossary(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## Canonical glossary"));
  if (start === -1) return [];
  const section = lines.slice(start + 1).join("\n");
  const gloss = [];
  for (const match of section.matchAll(/\*\*([^*]+)\*\*\s*(?:\u2014|--|:|=)\s*([^;.\n]+)/g)) {
    gloss.push({ term: match[1].trim(), definition: match[2].trim() });
  }
  return gloss;
}

/** Extract end-state architecture from north-star/platform.md. */
function parseEndState(text) {
  const lines = text.split("\n");
  const result = {};

  const esStart = lines.findIndex((l) => l.startsWith("## The end state"));
  if (esStart !== -1) {
    const esSection = lines.slice(esStart + 1).join("\n");
    const esMatch = esSection.match(/^[\s\S]*?\*\*([\s\S]+?)\*\*/);
    if (esMatch) result.vision = esMatch[1];
  }

  const principles = [];
  const pStart = lines.findIndex((l) => l.startsWith("## The four mechanism principles"));
  if (pStart !== -1) {
    let current = "";
    for (const line of lines.slice(pStart + 1)) {
      if (line.startsWith("## ")) break;
      const m = line.match(/^(\d+)\.\s+(.+)/);
      if (m) {
        if (current) principles.push(current);
        current = m[2].replace(/\*\*/g, "");
      } else if (current && line.trim()) {
        current += " " + line.trim();
      }
    }
    if (current) principles.push(current);
  }
  result.principles = principles;

  const invariants = [];
  const iStart = lines.findIndex((l) => l.startsWith("## The five invariants"));
  if (iStart !== -1) {
    let current = "";
    for (const line of lines.slice(iStart + 1)) {
      if (line.startsWith("## ")) break;
      const m = line.match(/^(\d+)\.\s+(.+)/);
      if (m) {
        if (current) invariants.push(current);
        current = m[2].replace(/\*\*/g, "");
      } else if (current && line.trim()) {
        current += " " + line.trim();
      }
    }
    if (current) invariants.push(current);
  }
  result.invariants = invariants;

  const primitives = [];
  const primStart = lines.findIndex((l) => l.startsWith("## The primitives"));
  if (primStart !== -1) {
    const primSection = text.split("\n").slice(primStart).join("\n");
    for (const row of tableRows(primSection, "| Specification")) {
      if (row.length >= 2) {
        const name = row[0]
          .replace(/\[(.+?)\]\([^)]+\)/g, "$1")
          .replace(/`/g, "")
          .trim();
        primitives.push({ name, purpose: row[1] });
      }
    }
  }
  result.primitives = primitives;

  const layers = [];
  const lStart = lines.findIndex((l) => l.startsWith("## Product architecture"));
  if (lStart !== -1) {
    const lSection = text.split("\n").slice(lStart).join("\n");
    for (const row of tableRows(lSection, "| Layer")) {
      const layerNum = parseInt(row[0], 10);
      if (!isNaN(layerNum) && row.length >= 3) {
        layers.push({ layer: layerNum, name: row[1], contents: row[2] });
      }
    }
  }
  result.layers = layers;

  return result;
}

/** Extract system shape from overview/index.md. */
function parseSystemShape(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## System shape"));
  if (start === -1) return null;
  const block = lines.slice(start + 1).join("\n");
  const m = block.match(/```[\s\S]*?```/);
  if (m) return m[0].replace(/```/g, "").trim();
  return null;
}

/** Extract milestones from method/roadmap.md. */
function parseMilestones(text) {
  const milestones = [];
  for (const match of text.matchAll(/^###\s+(M\d)\s+—\s+(.+?)\s+_(.+?)_\s*$/gm)) {
    milestones.push({ id: match[1], name: match[2].trim(), condition: match[3].trim() });
  }
  return milestones;
}

/** Extract known gaps from overview/index.md. */
function parseGaps(text) {
  const gaps = [];
  let inSection = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("## Known gaps")) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith("## ")) break;
    if (inSection && line.startsWith("|") && !line.includes("---")) {
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.length >= 3 && !cells[0].startsWith("Gap")) {
        gaps.push({ item: cells[0], kind: cells[1], reason: cells[2] });
      }
    }
  }
  return gaps;
}

export {
  frontmatter,
  tableRows,
  parseGlossary,
  parseEndState,
  parseSystemShape,
  parseMilestones,
  parseGaps,
};

function main() {
  const overview = read("overview/index.md");
  const platform = read("north-star/platform.md");
  const roadmap = read("method/roadmap.md");

  const output = {
    status: frontmatter(overview).status || "unknown",
    systemShape: parseSystemShape(overview),
    endState: parseEndState(platform),
    milestones: parseMilestones(roadmap),
    gaps: parseGaps(overview),
    glossary: parseGlossary(overview),
  };

  process.stdout.write(JSON.stringify(output, null, 2));
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  main();
}
