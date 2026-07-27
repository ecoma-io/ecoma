/**
 * Shared resolver for test-declaration callee chains, so every local rule sees
 * the same shapes: `it("t")`, `it.only("t")`, `it.each(cases)("t")`,
 * `it.only.each(cases)("t")`, and the tagged-template form `it.each` + table +
 * `("t")`. A parametrized declaration chains an extra call (or tagged template)
 * into the callee position, so a resolver that only understands `Identifier` /
 * `MemberExpression` never inspects it — both consuming rules resolve through
 * this module so they always recognize the same set of shapes.
 */

/** Chain members that are themselves called/tagged before the title call. */
const PARAMETRIZERS = new Set(["each", "for", "runIf", "skipIf"]);

/** Every member a test framework chains between the global and the title call. */
export const TEST_CHAIN_MODIFIERS = new Set([
  "only",
  "skip",
  "todo",
  "fails",
  "failing",
  "concurrent",
  "sequential",
  "shuffle",
  ...PARAMETRIZERS,
]);

/**
 * Resolves the callee of a candidate test-declaration call into its leading
 * identifier plus the member chain after it. Handles a single parametrizer
 * wrapper — `x.each(cases)("t")` / `x.each` tagged template / `x.runIf(c)("t")`
 * — by unwrapping to the inner chain, but only when the chain actually ends in
 * a parametrizer (so `foo()("t")` stays unrecognized).
 *
 * @param {import("estree").Node} callee - `node.callee` of a CallExpression.
 * @returns {{ root: string, modifiers: import("estree").Identifier[] } | null}
 *   Leading identifier name and the property nodes chained after it (in source
 *   order), or null when the callee is not a plain (optionally wrapped) chain.
 */
export function resolveTestCallChain(callee) {
  let cur = callee;
  let wrapped = false;
  if (cur.type === "CallExpression") {
    cur = cur.callee;
    wrapped = true;
  } else if (cur.type === "TaggedTemplateExpression") {
    cur = cur.tag;
    wrapped = true;
  }
  const modifiers = [];
  while (cur.type === "MemberExpression") {
    if (cur.computed || cur.property.type !== "Identifier") return null;
    modifiers.unshift(cur.property);
    cur = cur.object;
  }
  if (cur.type !== "Identifier") return null;
  if (wrapped) {
    const last = modifiers[modifiers.length - 1];
    if (!last || !PARAMETRIZERS.has(last.name)) return null;
  }
  return { root: cur.name, modifiers };
}
