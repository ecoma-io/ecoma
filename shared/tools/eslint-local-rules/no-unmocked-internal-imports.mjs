/**
 * In a unit test, every project-internal collaborator must be mocked: a unit
 * test isolates the file under test (the SUT) and verifies its own logic, not
 * the real behaviour of its dependencies — exercising real collaborators is an
 * integration test (`*.integration.test.ts`). Flags a project-internal import
 * (relative, or a workspace `@ecoma-io/*` package) that is neither the SUT nor
 * `vi.mock`'d in the same file.
 *
 * Scope is set in eslint.config.mjs (unit test files only). Third-party
 * packages and node builtins are left alone — mock collaborators, not pure
 * libraries; and type-only imports and asset imports carry no runtime behaviour
 * to mock, so they pass too.
 */
const TEST_INFRA = /^(vitest|@vitest\/|@vue\/test-utils|@testing-library\/|@storybook\/)/;
const ASSET_EXT = /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|json)$/;
const SUPPORT_DIR = /(^|\/)(__mocks__|__fixtures__|fixtures|test-utils|test-helpers)(\/|$)/;

const isInternal = (spec) => spec.startsWith(".") || spec.startsWith("@ecoma-io/");
const baseNoExt = (spec) => (spec.split("/").pop() ?? "").replace(/\.[^.]+$/, "");

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require project-internal collaborators to be mocked in unit tests (CLAUDE.md — unit tests isolate their dependencies)",
    },
    schema: [],
    messages: {
      unmockedImport:
        'Unit test imports project-internal `{{spec}}` without mocking it — add `vi.mock("{{spec}}")`, or rename this file to `*.integration.test.ts` if it is meant to exercise the real collaborator (CLAUDE.md — unit tests isolate their dependencies).',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    const sutBase = (filename.split("/").pop() ?? "").replace(/\.test\.[cm]?[jt]sx?$/, "");
    const mocked = new Set();
    const internalImports = [];

    // The SUT exemption takes only `./<sutBase>` (same directory, optionally
    // with an extension) — a same-basename file elsewhere (`../other/Foo`) is
    // a different module that happens to share the name, not the SUT.
    const isSut = (spec) =>
      spec.startsWith("./") && !spec.slice(2).includes("/") && baseNoExt(spec) === sutBase;

    const collectImport = (spec, node) => {
      if (typeof spec !== "string" || !isInternal(spec)) return;
      if (TEST_INFRA.test(spec) || ASSET_EXT.test(spec) || SUPPORT_DIR.test(spec)) return;
      if (isSut(spec)) return; // the SUT itself
      internalImports.push({ spec, node });
    };

    return {
      // Collect vi.mock("x") / vi.doMock("x") / vitest.mock("x").
      CallExpression(node) {
        const c = node.callee;
        if (
          c.type === "MemberExpression" &&
          c.object.type === "Identifier" &&
          (c.object.name === "vi" || c.object.name === "vitest") &&
          c.property.type === "Identifier" &&
          (c.property.name === "mock" || c.property.name === "doMock")
        ) {
          const arg = node.arguments[0];
          if (arg?.type === "Literal" && typeof arg.value === "string") mocked.add(arg.value);
        }
      },
      ImportDeclaration(node) {
        if (node.importKind === "type") return; // type-only: no runtime behaviour
        collectImport(node.source.value, node);
      },
      // Dynamic `import("...")` with a literal specifier is the same runtime
      // edge as a static import — without this, `await import("./collab")`
      // exercises a real collaborator lint-green. A non-literal argument can't
      // be judged statically and is left alone.
      ImportExpression(node) {
        if (node.source.type === "Literal") collectImport(node.source.value, node);
      },
      "Program:exit"() {
        for (const { spec, node } of internalImports) {
          if (!mocked.has(spec)) {
            context.report({ node, messageId: "unmockedImport", data: { spec } });
          }
        }
      },
    };
  },
};
