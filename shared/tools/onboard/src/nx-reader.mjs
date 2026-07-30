#!/usr/bin/env node
/**
 * Deterministic reader of the current Nx project structure.
 *
 * Emits the Nx graph to JSON and extracts nodes + edges, grouped by
 * the repo's own taxonomy (scope/type/layer tags). Falls back to
 * parsing `project.json` files directly if `nx` is not available.
 *
 * Usage: node shared/tools/onboard/src/nx-reader.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { globSync } from "node:fs";

const GRAPH_FILE = "/tmp/onboard-graph.json";

/** Try to read the Nx graph via `nx graph --file`. */
function readNxGraph() {
  try {
    execFileSync("pnpm", ["nx", "graph", "--file", GRAPH_FILE], {
      stdio: "pipe",
      timeout: 30000,
    });
    const raw = JSON.parse(readFileSync(GRAPH_FILE, "utf8"));
    const g = raw.graph;
    const nodes = Object.entries(g.nodes).map(([name, n]) => ({
      name,
      root: n.data.root,
      tags: n.data.tags || [],
      scope: (n.data.tags || []).find((t) => t.startsWith("scope:"))?.slice(6) || "?",
      type: (n.data.tags || []).find((t) => t.startsWith("type:"))?.slice(5) || "?",
      layer: (n.data.tags || []).find((t) => t.startsWith("layer:"))?.slice(6) || null,
      license: (n.data.tags || []).find((t) => t.startsWith("license:"))?.slice(8) || "?",
    }));
    const edges = Object.entries(g.dependencies).flatMap(([src, ds]) =>
      ds
        .filter((d) => !d.target.startsWith("npm:"))
        .map((d) => ({
          from: src,
          to: d.target,
          type: d.type,
        })),
    );
    return { nodes, edges, source: "nx-graph" };
  } catch {
    return null;
  }
}

/** Fallback: read project.json files directly (no dependency edges). */
function readProjectJsonFallback() {
  const pattern = "**/project.json";
  const files = globSync(pattern, { ignore: "node_modules/**" });
  const nodes = [];
  for (const f of files) {
    try {
      const pj = JSON.parse(readFileSync(f, "utf8"));
      if (!pj.name) continue;
      const tags = pj.tags || [];
      nodes.push({
        name: pj.name,
        root: f.replace(/\/project\.json$/, ""),
        tags,
        scope: tags.find((t) => t.startsWith("scope:"))?.slice(6) || "?",
        type: tags.find((t) => t.startsWith("type:"))?.slice(5) || "?",
        layer: tags.find((t) => t.startsWith("layer:"))?.slice(6) || null,
        license: tags.find((t) => t.startsWith("license:"))?.slice(8) || "?",
      });
    } catch {
      // skip invalid
    }
  }
  return { nodes, edges: [], source: "project-json-fallback" };
}

function main() {
  const result = readNxGraph() || readProjectJsonFallback();

  // Group by scope
  const groups = {};
  for (const node of result.nodes) {
    const s = node.scope;
    if (!groups[s]) groups[s] = [];
    groups[s].push(node);
  }

  result.groups = groups;
  result.groupKeys = Object.keys(groups).sort();

  process.stdout.write(JSON.stringify(result, null, 2));
}

main();
