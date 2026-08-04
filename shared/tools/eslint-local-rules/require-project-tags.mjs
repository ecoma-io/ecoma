/**
 * Every Nx `project.json` must carry exactly one `type:*`, one `scope:*` and
 * one `license:*` tag. `@nx/enforce-module-boundaries` (root eslint.config.mjs)
 * only constrains a project through its tags, so an untagged or mis-tagged
 * project silently escapes the leaf-independence dependency boundary — this
 * rule closes that gap.
 *
 * The allowed values mirror the `depConstraints` in eslint.config.mjs; a new
 * domain/scope must be added in both places in the same change. `type:e2e` has
 * no depConstraint there on purpose — an e2e project drives built apps, not
 * their source, so it needs no import-boundary of its own.
 */
const TYPES = new Set(["app", "lib", "e2e"]);
const SCOPES = new Set(["shared", "website", "platform", "rba"]);
// The licence axis, unlike `scope`, is enumerated in full before its values have
// projects — and the difference is not a lapse. A scope set is open-ended (one
// more per product domain nobody has named yet), so listing one early would be a
// claim about content that does not exist. The licence set is closed and already
// settled: `LICENSE` carves the tree into exactly these four, keyed by path.
// Enumerating them here is what lets `check-project-conventions` demand the
// right tag the moment a carve-out directory is born — a vocabulary missing
// `ee` would reject the very tag the gate requires, and the contributor would
// be caught between two checks. Every value is named by a depConstraint in
// eslint.config.mjs, so none is the silent escape this rule exists to close.
const LICENSES = new Set(["sul", "ee", "apache", "proprietary"]);
// The hex-layer axis is optional (apps, e2e, and non-layered plumbing libs like
// core-tauri carry none) — but when a layer tag is present it must be from the
// vocabulary, and there can be at most one: a misspelled `layer:*` matches no
// depConstraint and silently escapes the layer boundary.
const LAYERS = new Set(["util", "domain", "port", "adapter", "view", "app"]);
// The surface axis carries no value today. It held `surface:sdk`, which marked
// a lib as a cross-scope public contract, but the only depConstraint naming it
// belonged to a scope with no project. A tag no depConstraint mentions is the
// silent escape this rule exists to close, so the axis stays empty until a
// published package needs it — the vocabulary describes what the workspace has,
// not what it plans.
const SURFACES = new Set();

/**
 * Renders an axis vocabulary for an error message, so the message can never
 * name a value the Set no longer holds — the axes above are the one source
 * (Rule 14). An empty axis says so rather than printing `surface:{}`, which
 * reads as a formatting bug instead of as the deliberate state it is.
 */
const vocabulary = (axis, values) =>
  values.size === 0
    ? `none — the ${axis} axis is currently empty`
    : `${axis}:{${[...values].sort().join(",")}}`;

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
        "project.json `tags` must contain exactly one `type:*` tag (found {{count}}); expected one of {{allowed}}.",
      scopeCount:
        "project.json `tags` must contain exactly one `scope:*` tag (found {{count}}); expected one of {{allowed}}.",
      badType: "Unknown tag '{{tag}}' — type must be one of {{allowed}}.",
      badScope: "Unknown tag '{{tag}}' — scope must be one of {{allowed}}.",
      licenseCount:
        "project.json `tags` must contain exactly one `license:*` tag (found {{count}}); expected one of {{allowed}}.",
      badLicense: "Unknown tag '{{tag}}' — license must be one of {{allowed}}.",
      layerCount: "project.json `tags` must contain at most one `layer:*` tag (found {{count}}).",
      badLayer: "Unknown tag '{{tag}}' — layer must be one of {{allowed}}.",
      surfaceCount:
        "project.json `tags` must contain at most one `surface:*` tag (found {{count}}).",
      badSurface: "Unknown tag '{{tag}}' — surface must be one of {{allowed}}.",
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
          context.report({
            node,
            messageId: "typeCount",
            data: { count: types.length, allowed: vocabulary("type", TYPES) },
          });
        } else if (!TYPES.has(types[0].slice("type:".length))) {
          context.report({
            node,
            messageId: "badType",
            data: { tag: types[0], allowed: vocabulary("type", TYPES) },
          });
        }

        const scopes = tags.filter((t) => t.startsWith("scope:"));
        if (scopes.length !== 1) {
          context.report({
            node,
            messageId: "scopeCount",
            data: { count: scopes.length, allowed: vocabulary("scope", SCOPES) },
          });
        } else if (!SCOPES.has(scopes[0].slice("scope:".length))) {
          context.report({
            node,
            messageId: "badScope",
            data: { tag: scopes[0], allowed: vocabulary("scope", SCOPES) },
          });
        }

        const licenses = tags.filter((t) => t.startsWith("license:"));
        if (licenses.length !== 1) {
          context.report({
            node,
            messageId: "licenseCount",
            data: { count: licenses.length, allowed: vocabulary("license", LICENSES) },
          });
        } else if (!LICENSES.has(licenses[0].slice("license:".length))) {
          context.report({
            node,
            messageId: "badLicense",
            data: { tag: licenses[0], allowed: vocabulary("license", LICENSES) },
          });
        }

        const layers = tags.filter((t) => t.startsWith("layer:"));
        if (layers.length > 1) {
          context.report({ node, messageId: "layerCount", data: { count: layers.length } });
        } else if (layers.length === 1 && !LAYERS.has(layers[0].slice("layer:".length))) {
          context.report({
            node,
            messageId: "badLayer",
            data: { tag: layers[0], allowed: vocabulary("layer", LAYERS) },
          });
        }

        const surfaces = tags.filter((t) => t.startsWith("surface:"));
        if (surfaces.length > 1) {
          context.report({ node, messageId: "surfaceCount", data: { count: surfaces.length } });
        } else if (surfaces.length === 1 && !SURFACES.has(surfaces[0].slice("surface:".length))) {
          context.report({
            node,
            messageId: "badSurface",
            data: { tag: surfaces[0], allowed: vocabulary("surface", SURFACES) },
          });
        }
      },
    };
  },
};
