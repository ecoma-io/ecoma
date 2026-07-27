/**
 * Blocks focused (`.only`) and disabled (`.skip`) tests from being committed
 * (CLAUDE.md — scaffold openly, never fake done). A `.only` silently narrows the
 * suite so the rest never run; a `.skip` disables a test that then rots or hides
 * a failure. For an intentionally pending test, use `.todo` — which reads as
 * "not written yet", not "turned off" — and is left alone by this rule.
 *
 * Only test *declarations* are flagged (the call's first argument is a title
 * string), so Playwright's runtime `test.skip(condition, reason)` and bare
 * `test.skip()` — legitimate conditional skips — are not touched.
 */
import { resolveTestCallChain } from "./test-call-chain.mjs";

const TEST_GLOBALS = new Set(["describe", "it", "test", "suite", "bench", "context"]);
const FLAGGED = { only: "focusedTest", skip: "skippedTest" };

function isTitle(arg) {
  return (
    (arg?.type === "Literal" && typeof arg.value === "string") || arg?.type === "TemplateLiteral"
  );
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow committed `.only`/`.skip` tests (CLAUDE.md — never fake done)",
    },
    schema: [],
    messages: {
      focusedTest:
        "Remove `.only` — a focused test silently narrows the suite so the others never run (CLAUDE.md — never fake done).",
      skippedTest:
        "Remove `.skip` — a disabled test rots and hides failures; use `.todo` for an intentionally pending test (CLAUDE.md — scaffold openly, never fake done).",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const chain = resolveTestCallChain(node.callee);
        if (!chain || !TEST_GLOBALS.has(chain.root)) return;
        if (!isTitle(node.arguments[0])) return; // declaration only, not a conditional skip
        for (const modifier of chain.modifiers) {
          const messageId = FLAGGED[modifier.name];
          if (messageId) context.report({ node: modifier, messageId });
        }
      },
    };
  },
};
