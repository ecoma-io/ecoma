/**
 * The editor configuration checked against the server it configures.
 *
 * A `.lsp.json`-style manifest cannot import anything — it is data an editor
 * reads before any of this code runs — so the list of extensions it routes here
 * is a second copy of a fact `../analysis/analyze.mjs` already owns. Rule 14
 * allows that only when something keeps the copy honest, which is this file:
 * the same arrangement `../rules/messages.mjs` has with
 * `../rules/upstream.integration.test.mjs`.
 *
 * What goes wrong without it is quiet. A language arrives, registers in
 * `LANGUAGE_BY_EXTENSION`, gets an analyzer and a rule pass — and the editor
 * never sends it a file, so every project written in it keeps showing no
 * boundary problems. That reads exactly like a clean tree.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LANGUAGE_BY_EXTENSION } from "../analysis/analyze.mjs";
import { MODULE_BOUNDARIES_CONFIG_FILE } from "../config.mjs";

/**
 * The workspace root, found by walking up to the boundary config rather than by
 * counting directories — the tool's own directory sits at a different depth
 * when it runs from a pinned harness clone (`../config.mjs`).
 */
function workspaceRootFrom(start) {
  let current = start;
  for (;;) {
    if (existsSync(join(current, MODULE_BOUNDARIES_CONFIG_FILE))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `no ${MODULE_BOUNDARIES_CONFIG_FILE} above ${start} — this test needs the workspace it ` +
          `configures, and finding none means it is judging the wrong tree, not that it passed`,
      );
    }
    current = parent;
  }
}

const ROOT = workspaceRootFrom(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = join(ROOT, ".claude/plugins/nx-polyglot-graph/.claude-plugin/plugin.json");
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const [server] = Object.values(manifest.lspServers);

describe("the Claude Code plugin that routes files to this server", () => {
  it("launches the server that exists, at the path it is actually installed at", () => {
    // A renamed entry point is otherwise found by a developer, not by CI: the
    // plugin loads, the process fails to start, and Claude Code reports it in
    // a tab nobody opens.
    const entry = server.args.at(-1).replace("${CLAUDE_PROJECT_DIR}/", "");

    expect(server.command).toBe("node");
    expect(existsSync(join(ROOT, entry))).toBe(true);
  });

  it("routes every language that has no other boundary enforcement in this workspace", () => {
    // Go, Rust, Python and Vue: the four the tool exists for, where a
    // `layer:`/`scope:`/`license:` tag has no mechanism behind it today.
    // A fifth language landing in the analyzer registry and not here would be
    // analyzed by the CLI and never by an editor.
    const unenforced = Object.entries(LANGUAGE_BY_EXTENSION)
      .filter(([, language]) => language !== "typescript")
      .map(([extension]) => extension);

    expect(Object.keys(server.extensionToLanguage).sort()).toEqual(unenforced.sort());
  });

  it("leaves JS and TS to the enforcer that already covers them", () => {
    // Claude Code gives ONE server per extension — the first registered wins
    // and the rest never start. Claiming `.ts` would displace whichever
    // TypeScript server the developer actually needs, to re-answer a question
    // `@nx/enforce-module-boundaries` already answers through ESLint.
    const typescriptExtensions = Object.entries(LANGUAGE_BY_EXTENSION)
      .filter(([, language]) => language === "typescript")
      .map(([extension]) => extension);

    for (const extension of typescriptExtensions) {
      expect(server.extensionToLanguage).not.toHaveProperty(extension);
    }
  });

  it("names an analyzer-backed extension for every route it declares", () => {
    // The other direction: a route for an extension nothing can analyze would
    // send the editor a file this server answers nothing useful about.
    for (const extension of Object.keys(server.extensionToLanguage)) {
      expect(LANGUAGE_BY_EXTENSION).toHaveProperty(extension);
    }
  });
});
