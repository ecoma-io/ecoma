/**
 * Flags roadmap/version/ticket markers in comments and test titles
 * (CLAUDE.md Rule 13 — durable names describe behavior, not the phase/review
 * round/ticket that produced it).
 * Pattern lives in journey-markers.config.json at the repo root — the single source shared with
 * shared/tools/dev-cli.
 */
import { readFileSync } from "node:fs";

import { resolveTestCallChain, TEST_CHAIN_MODIFIERS } from "./test-call-chain.mjs";

const MARKER_RE = new RegExp(
  JSON.parse(readFileSync(new URL("../../../journey-markers.config.json", import.meta.url), "utf8"))
    .pattern,
  "i",
);

const TITLE_CALLEES = new Set([
  "describe",
  "it",
  "test",
  "suite",
  "bench",
  "context",
  "xdescribe",
  "xit",
]);

function textOf(arg) {
  if (arg.type === "Literal" && typeof arg.value === "string") return arg.value;
  if (arg.type === "TemplateLiteral") return arg.quasis.map((q) => q.value.raw).join("");
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow roadmap/version/ticket journey markers in comments and test titles (CLAUDE.md Rule 13)",
    },
    schema: [],
    messages: {
      journeyMarker:
        "Journey marker '{{match}}' — name/describe the behavior, not the phase, review round, or ticket that produced it (CLAUDE.md Rule 13). Version context belongs in docs/content, not code.",
    },
  },
  create(context) {
    function check(node, text) {
      const match = text.match(MARKER_RE);
      if (match) {
        context.report({ node, messageId: "journeyMarker", data: { match: match[0] } });
      }
    }

    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          check(comment, comment.value);
        }
      },
      CallExpression(node) {
        const chain = resolveTestCallChain(node.callee);
        if (!chain || !TITLE_CALLEES.has(chain.root)) return;
        if (!chain.modifiers.every((m) => TEST_CHAIN_MODIFIERS.has(m.name))) return;
        const arg = node.arguments[0];
        if (!arg) return;
        const text = textOf(arg);
        if (text != null) check(arg, text);
      },
    };
  },
};
