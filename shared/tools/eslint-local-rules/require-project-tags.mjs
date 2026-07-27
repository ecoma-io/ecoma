/**
 * Every Nx `project.json` must carry exactly one `type:*` and one `scope:*` tag.
 * `@nx/enforce-module-boundaries` (root eslint.config.mjs) only constrains a
 * project through its tags, so an untagged or mis-tagged project silently
 * escapes the leaf-independence dependency boundary — this rule closes that gap.
 *
 * The allowed values mirror the `depConstraints` in eslint.config.mjs; a new
 * domain/scope must be added in both places in the same change. `type:e2e` has
 * no depConstraint there on purpose — an e2e project drives built apps, not
 * their source, so it needs no import-boundary of its own.
 */
const TYPES = new Set(["app", "lib", "e2e"]);
const SCOPES = new Set(["shared", "connectors"]);
// The hex-layer axis is optional (apps, e2e, and non-layered plumbing libs like
// core-tauri carry none) — but when a layer tag is present it must be from the
// vocabulary, and there can be at most one: a misspelled `layer:*` matches no
// depConstraint and silently escapes the layer boundary.
const LAYERS = new Set(["util", "domain", "port", "adapter", "view", "app"]);
// The surface axis is optional and currently single-valued: `surface:sdk`
// marks a lib as a cross-scope public contract (e.g. connector-sdk), which
// depConstraints both leaf-pin and expose to other scopes. Same silent-escape
// logic as layers: a misspelled surface tag matches no depConstraint.
const SURFACES = new Set(["sdk"]);

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require every project.json to declare exactly one type: and one scope: tag (CLAUDE.md — leaf-independence boundary)",
    },
    schema: [],
    messages: {
      noTags: "project.json must declare a `tags` array with a `type:` and a `scope:` tag.",
      typeCount:
        "project.json `tags` must contain exactly one `type:*` tag (found {{count}}); expected type:app or type:lib.",
      scopeCount:
        "project.json `tags` must contain exactly one `scope:*` tag (found {{count}}); expected one of scope:{shared,connectors}.",
      badType: "Unknown tag '{{tag}}' — type must be one of type:{app,lib,e2e}.",
      badScope: "Unknown tag '{{tag}}' — scope must be one of scope:{shared,connectors}.",
      layerCount: "project.json `tags` must contain at most one `layer:*` tag (found {{count}}).",
      badLayer:
        "Unknown tag '{{tag}}' — layer must be one of layer:{util,domain,port,adapter,view,app}.",
      surfaceCount:
        "project.json `tags` must contain at most one `surface:*` tag (found {{count}}).",
      badSurface: "Unknown tag '{{tag}}' — surface must be one of surface:{sdk}.",
    },
  },
  create(context) {
    return {
      Program(node) {
        let data;
        try {
          data = JSON.parse(context.sourceCode.getText());
        } catch {
          return; // malformed JSON is another tool's concern
        }
        const tags = Array.isArray(data.tags)
          ? data.tags.filter((t) => typeof t === "string")
          : null;
        if (!tags) {
          context.report({ node, messageId: "noTags" });
          return;
        }

        const types = tags.filter((t) => t.startsWith("type:"));
        if (types.length !== 1) {
          context.report({ node, messageId: "typeCount", data: { count: types.length } });
        } else if (!TYPES.has(types[0].slice("type:".length))) {
          context.report({ node, messageId: "badType", data: { tag: types[0] } });
        }

        const scopes = tags.filter((t) => t.startsWith("scope:"));
        if (scopes.length !== 1) {
          context.report({ node, messageId: "scopeCount", data: { count: scopes.length } });
        } else if (!SCOPES.has(scopes[0].slice("scope:".length))) {
          context.report({ node, messageId: "badScope", data: { tag: scopes[0] } });
        }

        const layers = tags.filter((t) => t.startsWith("layer:"));
        if (layers.length > 1) {
          context.report({ node, messageId: "layerCount", data: { count: layers.length } });
        } else if (layers.length === 1 && !LAYERS.has(layers[0].slice("layer:".length))) {
          context.report({ node, messageId: "badLayer", data: { tag: layers[0] } });
        }

        const surfaces = tags.filter((t) => t.startsWith("surface:"));
        if (surfaces.length > 1) {
          context.report({ node, messageId: "surfaceCount", data: { count: surfaces.length } });
        } else if (surfaces.length === 1 && !SURFACES.has(surfaces[0].slice("surface:".length))) {
          context.report({ node, messageId: "badSurface", data: { tag: surfaces[0] } });
        }
      },
    };
  },
};
