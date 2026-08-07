/**
 * The three files that have to agree before this project's language server
 * reaches a Claude Code session, held to each other.
 *
 * A plugin is enabled by a string — `<plugin>@<marketplace>` in
 * `.claude/settings.json` — that names two things declared elsewhere: the
 * plugin's own `plugin.json` and the catalogue's `marketplace.json`. Rename
 * either and the string still parses, the settings file still loads, and the
 * plugin simply never starts. There is no error, because nothing looked.
 *
 * The version is the same shape of copy. It is written twice, once in each
 * manifest, and the plugin's own note says they must match — which is a
 * constraint stated in prose beside two values nothing compares (Rule 14: a
 * value copied across two files was never a valid hardcode). An installed
 * plugin is cached per version, so a mismatch is not cosmetic: Claude Code and
 * the catalogue disagree about which build a session is running.
 *
 * What this deliberately does NOT check is the manifest version against the
 * project's `package.json`. They are different facts wearing one word. The
 * manifest version keys Claude Code's plugin cache and moves when the manifest
 * moves; `package.json`'s version is the tool's own and is what the server
 * announces as `serverInfo`. Tying them would force a manifest bump on every
 * release of code the manifest does not contain.
 *
 * `src/lsp/editor-config.integration.test.mjs` owns the other half — that the
 * routed extensions match the analyzer registry and that the entry point
 * exists. Neither restates the other.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MODULE_BOUNDARIES_CONFIG_FILE } from "../config.mjs";

/**
 * The workspace root, found by walking up to the boundary config rather than by
 * counting directories — this project sits at a different depth when it runs
 * from a pinned harness clone (`../config.mjs`).
 */
function workspaceRootFrom(start) {
  let current = start;
  for (;;) {
    if (existsSync(join(current, MODULE_BOUNDARIES_CONFIG_FILE))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `no ${MODULE_BOUNDARIES_CONFIG_FILE} above ${start} — this test needs the workspace it ` +
          `judges, and finding none means it is judging the wrong tree, not that it passed`,
      );
    }
    current = parent;
  }
}

const ROOT = workspaceRootFrom(dirname(fileURLToPath(import.meta.url)));
const CATALOGUE = join(ROOT, ".claude/plugins");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const marketplace = readJson(join(CATALOGUE, ".claude-plugin/marketplace.json"));
const settings = readJson(join(ROOT, ".claude/settings.json"));

describe("the plugin catalogue this repository hosts for its own sessions", () => {
  it("lists an entry whose manifest is where the entry says it is", () => {
    // The `source` is a path Claude Code follows. A directory renamed under it
    // leaves an entry pointing at nothing, which reads as a plugin that exists.
    for (const entry of marketplace.plugins) {
      const manifestPath = join(CATALOGUE, entry.source, ".claude-plugin/plugin.json");
      expect(existsSync(manifestPath), `${entry.name} -> ${entry.source}`).toBe(true);
      expect(readJson(manifestPath).name).toBe(entry.name);
    }
  });

  it("gives every entry the version its own manifest declares", () => {
    for (const entry of marketplace.plugins) {
      const manifest = readJson(join(CATALOGUE, entry.source, ".claude-plugin/plugin.json"));
      expect(entry.version, `${entry.name} in marketplace.json`).toBe(manifest.version);
    }
  });

  it("enables each plugin under the name the two manifests actually spell", () => {
    // `enabledPlugins` is the only place the two names are joined, and it is a
    // string: a rename on either side leaves it pointing at nothing.
    //
    // Scoped to the keys naming THIS marketplace, in both directions. The file
    // also enables plugins from other marketplaces (litmus), which are not this
    // catalogue's business — but a `@ecoma` key with no entry behind it is, so
    // the comparison is an equality over that suffix rather than a subset check
    // that a stale rename would slip through.
    const suffix = `@${marketplace.name}`;
    const expected = marketplace.plugins.map((entry) => `${entry.name}${suffix}`);
    const enabled = Object.keys(settings.enabledPlugins ?? {}).filter((key) =>
      key.endsWith(suffix),
    );

    expect(enabled.sort()).toEqual([...expected].sort());
    for (const key of expected) expect(settings.enabledPlugins[key]).toBe(true);
  });

  it("keeps the catalogue inside this repository, where a session reads it from one commit", () => {
    // A `source` climbing out of the catalogue would make a session's plugins
    // come from somewhere the pull request that changes them cannot review.
    for (const entry of marketplace.plugins) {
      const resolved = resolve(CATALOGUE, entry.source);
      expect(resolved.startsWith(`${CATALOGUE}/`), `${entry.name} -> ${entry.source}`).toBe(true);
    }
  });
});
