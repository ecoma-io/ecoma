import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import {
  analyzeGo,
  parseGoImports,
  parseGoImportSites,
  parseGoModulePath,
  resolveGoDependencies,
} from "./go.mjs";

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

describe("parseGoImportSites", () => {
  const source = [
    "package main", // 1
    "", // 2
    "import (", // 3
    '\t"fmt"', // 4
    '\t_ "example.com/acme/beta/pkg"', // 5
    ")", // 6
    "", // 7
    'import "example.com/acme/gamma"', // 8
  ].join("\n");

  it("keeps one entry per written import, with the offset of its quoted path", () => {
    expect(
      parseGoImportSites(source).map((site) => [site.specifier, source.slice(site.offset)[0]]),
    ).toEqual([
      ["fmt", '"'],
      ["example.com/acme/beta/pkg", '"'],
      ["example.com/acme/gamma", '"'],
    ]);
  });

  it("returns sites in source order, not block-form after single-form", () => {
    // The single-form import is written last but sits after the block; a
    // parser that appended one regex's matches to the other's would report a
    // record order that contradicts `contract.md`'s source-order promise.
    const offsets = parseGoImportSites(source).map((site) => site.offset);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });

  it("is the single parse both layers read — `parseGoImports` is its deduped view", () => {
    const doubled = 'package x\n\nimport "fmt"\nimport "fmt"\n';
    expect(parseGoImportSites(doubled)).toHaveLength(2);
    expect(parseGoImports(doubled)).toEqual(["fmt"]);
  });
});

describe("analyzeGo", () => {
  const workspace = {
    root: "/w",
    projects: [
      { name: "alpha", root: "acme/libs/alpha" },
      { name: "beta", root: "acme/libs/beta" },
      { name: "beta-nested", root: "acme/libs/beta/nested" },
    ],
    filesOf: (name) =>
      ({
        alpha: ["acme/libs/alpha/go.mod", "acme/libs/alpha/main.go"],
        beta: ["acme/libs/beta/go.mod"],
        "beta-nested": ["acme/libs/beta/nested/go.mod"],
      })[name] ?? [],
    readFile: (path) =>
      ({
        "acme/libs/alpha/go.mod": "module example.com/acme/alpha\n",
        "acme/libs/beta/go.mod": "module example.com/acme/beta\n",
        "acme/libs/beta/nested/go.mod": "module example.com/acme/beta/nested\n",
      })[path] ?? null,
  };
  const analyze = (text, sourceFile = "acme/libs/alpha/main.go") =>
    analyzeGo({ sourceFile, text, workspace });

  it("names the project, the line, the column and the raw path an import crosses to", () => {
    // The whole reason this layer exists: an Nx edge says only that alpha
    // depends on beta. This is the record a reader can act on.
    const text = 'package main\n\nimport (\n\t"fmt"\n\t"example.com/acme/beta/store"\n)\n';
    const { imports, failures } = analyze(text);
    expect(failures).toEqual([]);
    expect(imports[1]).toEqual({
      sourceFile: "acme/libs/alpha/main.go",
      line: 5,
      column: 2,
      specifier: "example.com/acme/beta/store",
      kind: "static",
      spelling: { path: false, relative: false },
      resolved: { target: "beta", file: null, external: false, packageName: null },
    });
  });

  it("calls no Go import a path and none of them relative, its own module included", () => {
    // Both answers are the language's rather than a default. Go rejects
    // `import "./x"` in modules mode, so an import path is never resolved
    // against the file's own directory; and Go has no relative form at all, so
    // there is nothing `relative` could be true for. The analyzer's header
    // records what the second answer costs a project that imports its own
    // module — no file in this workspace does.
    const text = 'package main\n\nimport (\n\t"fmt"\n\t"example.com/acme/alpha/store"\n)\n';
    const { imports } = analyze(text);
    expect(imports.map((record) => [record.specifier, record.spelling])).toEqual([
      ["fmt", { path: false, relative: false }],
      ["example.com/acme/alpha/store", { path: false, relative: false }],
    ]);
    expect(imports[1].resolved.target).toBe("alpha");
  });

  it("resolves to the innermost module when one module path nests inside another", () => {
    // `example.com/acme/beta/nested` lives under `example.com/acme/beta`. A
    // first-match answer names the parent project and the nested project's
    // every dependency disappears into it.
    const { imports } = analyze('package main\n\nimport "example.com/acme/beta/nested/x"\n');
    expect(imports[0].resolved.target).toBe("beta-nested");
  });

  it("emits an import of the file's own module rather than dropping it", () => {
    // `contract.md` keeps intra-project imports: a rule about a project
    // reaching itself through its public path cannot be written without them.
    const { imports } = analyze('package main\n\nimport "example.com/acme/alpha/internal"\n');
    expect(imports[0].resolved).toEqual({
      target: "alpha",
      file: null,
      external: false,
      packageName: null,
    });
  });

  it("marks a stdlib or proxy import external and carries its whole path as the package", () => {
    // Where a module path ends inside `github.com/aws/aws-sdk-go-v2/service/s3`
    // is knowable only to the module proxy, so the full path stands in and a
    // `bannedExternalImports` glob matches it the same way.
    const { imports } = analyze(
      'package main\n\nimport (\n\t"net/http"\n\t"github.com/aws/aws-sdk-go-v2/service/s3"\n)\n',
    );
    expect(imports.map((record) => record.resolved)).toEqual([
      { target: null, file: null, external: true, packageName: "net/http" },
      {
        target: null,
        file: null,
        external: true,
        packageName: "github.com/aws/aws-sdk-go-v2/service/s3",
      },
    ]);
  });

  it("finds a module nested below the project root, which the edge resolver does not model", () => {
    // A crate or module in a subdirectory still belongs to the project whose
    // directory contains it. Analysis attributes a file, so it can see one.
    const nested = {
      ...workspace,
      projects: [{ name: "app", root: "apps/thing" }],
      filesOf: () => ["apps/thing/go/go.mod", "apps/thing/go/main.go"],
      readFile: (path) => (path === "apps/thing/go/go.mod" ? "module example.com/thing\n" : null),
    };
    const { imports } = analyzeGo({
      sourceFile: "apps/thing/go/main.go",
      text: 'package main\n\nimport "example.com/thing/sub"\n',
      workspace: nested,
    });
    expect(imports[0].resolved.target).toBe("app");
  });

  it("returns an envelope rather than throwing when the workspace misbehaves", () => {
    const hostile = {
      ...workspace,
      filesOf: () => {
        throw new Error("graph unavailable");
      },
    };
    const result = analyzeGo({ sourceFile: "a/b.go", text: 'import "fmt"', workspace: hostile });
    expect(result.imports).toEqual([]);
    expect(result.failures[0].reason).toMatch(/graph unavailable/);
  });
});
