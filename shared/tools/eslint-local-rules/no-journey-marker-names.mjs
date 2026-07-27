/**
 * Flags journey-marker tokens (`v2`, `wip`, a trailing `-new`/`-old`/`-temp`,
 * `phase-3`, dates, ticket IDs) in EXPORTED declaration names — the
 * durable-name half of CLAUDE.md Rule 13. Only export declarations are
 * checked, never usages, so a bad name reports once where it is coined, not at
 * every call site.
 *
 * Pattern (`namePattern`) lives in journey-markers.config.json at the repo
 * root — the single source shared with shared/tools/dev-cli, which applies the
 * same pattern to file/directory names and Nx target names. Names are matched
 * in kebab-normalized form (camelCase split, non-alphanumeric runs to '-',
 * lowercased — the contract documented in the config), so word boundaries
 * hold: `renewal`, `stepId`, `newValue`, `uuidv4` never match.
 */
import { readFileSync } from "node:fs";

const NAME_RE = new RegExp(
  JSON.parse(readFileSync(new URL("../../../journey-markers.config.json", import.meta.url), "utf8"))
    .namePattern,
);

/** Kebab-normalizes a name per the contract in journey-markers.config.json. */
function normalizeName(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow journey-marker tokens (v2, wip, trailing new/old/temp, phase-N, dates, ticket IDs) in exported declaration names (CLAUDE.md Rule 13)",
    },
    schema: [],
    messages: {
      journeyName:
        "Journey marker '{{match}}' in exported name '{{name}}' — name for the end state, not the phase, version, or ticket that produced it (CLAUDE.md Rule 13).",
    },
  },
  create(context) {
    function check(node, name) {
      const match = normalizeName(name).match(NAME_RE);
      if (match) {
        context.report({
          node,
          messageId: "journeyName",
          data: { match: match[0].replace(/^-/, ""), name },
        });
      }
    }

    /** Walks a binding pattern (destructuring) down to the bound identifiers. */
    function checkBindingTargets(target) {
      if (!target) return;
      switch (target.type) {
        case "Identifier":
          check(target, target.name);
          break;
        case "ObjectPattern":
          for (const prop of target.properties) {
            checkBindingTargets(prop.type === "Property" ? prop.value : prop.argument);
          }
          break;
        case "ArrayPattern":
          for (const element of target.elements) checkBindingTargets(element);
          break;
        case "AssignmentPattern":
          checkBindingTargets(target.left);
          break;
        case "RestElement":
          checkBindingTargets(target.argument);
          break;
      }
    }

    /** The public name of an `export { local as exported }` / `export * as ns` node. */
    function exportedNameOf(exported) {
      if (exported.type === "Identifier") return exported.name;
      if (typeof exported.value === "string") return exported.value; // export { x as "string name" }
      return null;
    }

    return {
      ExportNamedDeclaration(node) {
        const declaration = node.declaration;
        if (!declaration) return; // specifier form handled by ExportSpecifier
        if (declaration.type === "VariableDeclaration") {
          for (const declarator of declaration.declarations) {
            checkBindingTargets(declarator.id);
          }
        } else if (declaration.id?.type === "Identifier") {
          // function/class and TS type alias/interface/enum/module declarations
          check(declaration.id, declaration.id.name);
        }
      },
      ExportDefaultDeclaration(node) {
        // Only a *named* default export coins a durable name.
        if (node.declaration.id?.type === "Identifier") {
          check(node.declaration.id, node.declaration.id.name);
        }
      },
      ExportSpecifier(node) {
        const name = exportedNameOf(node.exported);
        if (name != null) check(node.exported, name);
      },
      ExportAllDeclaration(node) {
        if (node.exported) {
          const name = exportedNameOf(node.exported);
          if (name != null) check(node.exported, name);
        }
      },
    };
  },
};
