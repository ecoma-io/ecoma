import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import { parseGoImports, parseGoModulePath, resolveGoDependencies } from "./go.mjs";

const modulePath = fc
  .array(fc.constantFrom(..."abcdefgh"), { minLength: 1, maxLength: 6 })
  .map((chars) => `example.com/${chars.join("")}`);
// The lines a .go file is made of, as this parser sees them: declarations it
// must read, quoted strings it must not, and the block punctuation that
// decides which is which.
const goLine = fc.oneof(
  fc.constantFrom(
    "package main",
    "import (",
    ")",
    "",
    "\tfmt.Println()",
    'var s = "example.com/not-an-import"',
    '// import "example.com/commented"',
  ),
  modulePath.map((path) => `import "${path}"`),
  modulePath.map((path) => `\t_ "${path}"`),
  modulePath.map((path) => `\talias "${path}"`),
);

describe("parseGoModulePath", () => {
  it("reads the module path and ignores directives around it", () => {
    expect(
      parseGoModulePath('module example.com/acme/tool\n\ngo 1.24\nrequire (\n\tx "v1"\n)'),
    ).toBe("example.com/acme/tool");
  });

  it("returns null when no module directive exists", () => {
    expect(parseGoModulePath("go 1.24\n")).toBeNull();
  });
});

describe("parseGoImports", () => {
  it("reads single-form imports, with and without alias forms", () => {
    const src = [
      'import "fmt"',
      'import alias "example.com/a"',
      'import _ "example.com/b"',
      'import . "example.com/c"',
    ].join("\n");
    expect(parseGoImports(src).sort()).toEqual([
      "example.com/a",
      "example.com/b",
      "example.com/c",
      "fmt",
    ]);
  });

  it("reads every path in a block import", () => {
    const src =
      'package x\n\nimport (\n\t"fmt"\n\tzz "example.com/y/sub"\n\t_ "example.com/z"\n)\n';
    expect(parseGoImports(src).sort()).toEqual(["example.com/y/sub", "example.com/z", "fmt"]);
  });

  it("does not read a quoted string outside an import declaration", () => {
    expect(parseGoImports('package x\nvar s = "example.com/not-an-import"')).toEqual([]);
  });

  // Two regexes stand in for a Go parser, over sources this plugin never gets
  // to choose. The invariant that keeps that honest is that every path it
  // reports is quoted somewhere in the file it read: an import the file does
  // not contain is an edge to a project it does not depend on, which makes
  // `nx affected` rebuild and re-review work that cannot have changed.
  test.prop([fc.array(goLine, { maxLength: 24 })])(
    "never reports an import path the source does not quote",
    (lines) => {
      const source = lines.join("\n");
      for (const imported of parseGoImports(source)) {
        expect(source).toContain(`"${imported}"`);
      }
    },
  );

  test.prop([fc.array(goLine, { maxLength: 12 }), modulePath, fc.array(goLine, { maxLength: 12 })])(
    "reads a single-form import wherever in the file it appears",
    (before, imported, after) => {
      const source = [...before, `import "${imported}"`, ...after].join("\n");
      expect(parseGoImports(source)).toContain(imported);
    },
  );
});

describe("resolveGoDependencies", () => {
  const projects = [
    { name: "alpha", root: "acme/libs/alpha" },
    { name: "beta", root: "acme/libs/beta" },
    { name: "web", root: "shared/libs/web" }, // not a Go project
  ];
  const files = {
    alpha: ["acme/libs/alpha/go.mod", "acme/libs/alpha/main.go"],
    beta: ["acme/libs/beta/go.mod", "acme/libs/beta/lib.go", "acme/libs/beta/lib_test.go"],
    web: ["shared/libs/web/project.json"],
  };
  const contents = {
    "acme/libs/alpha/go.mod": "module example.com/acme/alpha\n\ngo 1.24\n",
    "acme/libs/alpha/main.go":
      'package main\n\nimport (\n\t"fmt"\n\t"example.com/acme/beta/pkg"\n)\n',
    "acme/libs/beta/go.mod": "module example.com/acme/beta\n\ngo 1.24\n",
    "acme/libs/beta/lib.go": 'package beta\n\nimport "fmt"\n',
    "acme/libs/beta/lib_test.go": 'package beta\n\nimport "testing"\n',
  };
  const filesOf = (name) => files[name] ?? [];
  const readFile = (path) => contents[path] ?? null;

  it("draws an edge for an import under a sibling module path, attributed to the importing file", () => {
    expect(resolveGoDependencies(projects, filesOf, readFile)).toEqual([
      {
        source: "alpha",
        target: "beta",
        sourceFile: "acme/libs/alpha/main.go",
        type: "static",
      },
    ]);
  });

  it("draws nothing when the only imports are stdlib or the project's own module", () => {
    const selfImport = {
      ...contents,
      "acme/libs/alpha/main.go": 'package main\n\nimport "example.com/acme/alpha/internal"\n',
    };
    expect(resolveGoDependencies(projects, filesOf, (p) => selfImport[p] ?? null)).toEqual([]);
  });

  it("requires the module-path boundary — a prefix without a slash is not a match", () => {
    const lookalike = {
      ...contents,
      "acme/libs/alpha/main.go": 'package main\n\nimport "example.com/acme/betafake"\n',
    };
    expect(resolveGoDependencies(projects, filesOf, (p) => lookalike[p] ?? null)).toEqual([]);
  });
});
