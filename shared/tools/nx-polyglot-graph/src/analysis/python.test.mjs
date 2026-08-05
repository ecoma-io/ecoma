import { describe, expect, it } from "vitest";

import {
  analyzePython,
  collectDeclaredDependencies,
  normalizePackageName,
  parsePythonImportSites,
  parseRequirementName,
  pythonImportRoots,
  pythonModuleIndex,
  resolvePythonDependencies,
} from "./python.mjs";

describe("name normalization (PEP 503)", () => {
  it("collapses case and separator runs", () => {
    expect(normalizePackageName("Acme__Tool.Kit")).toBe("acme-tool-kit");
  });

  it("extracts the package name from a PEP 508 requirement string", () => {
    expect(parseRequirementName("acme-core>=1.2,<2")).toBe("acme-core");
    expect(parseRequirementName("Acme_Core[extra] ; python_version >= '3.12'")).toBe("acme-core");
    expect(parseRequirementName("")).toBeNull();
  });
});

describe("collectDeclaredDependencies", () => {
  it("gathers names across dependencies, optional groups, and dependency-groups", () => {
    // The parsed shape, written directly: this pins what `collect…` does with
    // a manifest, not how TOML gets turned into one (that is manifest-util's
    // own test). Keys are the literal TOML table names smol-toml produces.
    const manifest = {
      project: {
        name: "alpha",
        dependencies: ["acme-core>=1"],
        "optional-dependencies": { cli: ["click>=8"] },
      },
      "dependency-groups": { dev: ["pytest", { "include-group": "cli" }] },
    };
    expect(collectDeclaredDependencies(manifest).sort()).toEqual(["acme-core", "click", "pytest"]);
  });
});

describe("resolvePythonDependencies", () => {
  const projects = [
    { name: "alpha", root: "acme/libs/alpha" },
    { name: "beta", root: "acme/libs/beta" },
  ];
  const files = {
    alpha: ["acme/libs/alpha/pyproject.toml"],
    beta: ["acme/libs/beta/pyproject.toml"],
  };
  const filesOf = (name) => files[name] ?? [];
  const betaManifest = '[project]\nname = "acme-beta"\nversion = "0.1.0"\n';

  it("draws an edge only when tool.uv.sources routes the name to the workspace", () => {
    const contents = {
      "acme/libs/alpha/pyproject.toml": [
        "[project]",
        'name = "acme-alpha"',
        'version = "0.1.0"',
        'dependencies = ["acme-beta", "requests>=2"]',
        "[tool.uv.sources]",
        "acme-beta = { workspace = true }",
      ].join("\n"),
      "acme/libs/beta/pyproject.toml": betaManifest,
    };
    expect(resolvePythonDependencies(projects, filesOf, (p) => contents[p] ?? null)).toEqual([
      {
        source: "alpha",
        target: "beta",
        sourceFile: "acme/libs/alpha/pyproject.toml",
        type: "static",
      },
    ]);
  });

  it("resolves a path source against the declaring project's root", () => {
    const contents = {
      "acme/libs/alpha/pyproject.toml": [
        "[project]",
        'name = "acme-alpha"',
        'version = "0.1.0"',
        "[dependency-groups]",
        'dev = ["acme-beta"]',
        "[tool.uv.sources]",
        'acme_beta = { path = "../beta" }', // underscore spelling still matches
      ].join("\n"),
      "acme/libs/beta/pyproject.toml": betaManifest,
    };
    expect(resolvePythonDependencies(projects, filesOf, (p) => contents[p] ?? null)).toHaveLength(
      1,
    );
  });

  it("never edges on a bare name match — uv semantics, not string matching", () => {
    const contents = {
      "acme/libs/alpha/pyproject.toml": [
        "[project]",
        'name = "acme-alpha"',
        'version = "0.1.0"',
        'dependencies = ["acme-beta"]', // same name as the sibling, but no source entry
      ].join("\n"),
      "acme/libs/beta/pyproject.toml": betaManifest,
    };
    expect(resolvePythonDependencies(projects, filesOf, (p) => contents[p] ?? null)).toEqual([]);
  });
});

describe("import roots derived from the layout", () => {
  it("reads a src layout, a flat layout and a single module the way Python does", () => {
    // Not from the manifest: setuptools, hatchling, poetry, pdm and flit each
    // declare packages differently, and the tree already states the answer all
    // five are trying to describe.
    expect(
      pythonImportRoots("libs/alpha", [
        "libs/alpha/pyproject.toml",
        "libs/alpha/src/alpha/__init__.py",
        "libs/alpha/src/alpha/service.py",
        "libs/alpha/conftest.py",
      ]),
    ).toEqual(["alpha", "conftest"]);

    expect(pythonImportRoots("libs/beta", ["libs/beta/beta/__init__.py"])).toEqual(["beta"]);
    expect(pythonImportRoots("libs/gamma", ["libs/gamma/gamma.py"])).toEqual(["gamma"]);
  });

  it("indexes a src-layout package under src, never also as `src.<pkg>`", () => {
    const index = pythonModuleIndex("libs/alpha", ["libs/alpha/src/alpha/service.py"]);
    expect([...index.keys()]).toEqual(["alpha.service", "alpha"]);
  });

  it("records a directory with no __init__.py, because PEP 420 still makes it importable", () => {
    const index = pythonModuleIndex("libs/alpha", ["libs/alpha/src/ns/alpha/thing.py"]);
    expect(index.get("ns")).toEqual({ file: null, namespace: true });
    expect(index.get("ns.alpha.thing")).toEqual({
      file: "libs/alpha/src/ns/alpha/thing.py",
      namespace: false,
    });
  });

  it("prefers a real __init__.py over the namespace entry regardless of file order", () => {
    const forward = ["libs/a/src/pkg/__init__.py", "libs/a/src/pkg/mod.py"];
    for (const files of [forward, [...forward].reverse()]) {
      expect(pythonModuleIndex("libs/a", files).get("pkg")).toEqual({
        file: "libs/a/src/pkg/__init__.py",
        namespace: false,
      });
    }
  });

  it("ignores a directory Python cannot spell in an import", () => {
    expect(pythonImportRoots("libs/a", ["libs/a/src/my-pkg/thing.py"])).toEqual([]);
  });
});

describe("parsePythonImportSites", () => {
  it("reads both statement forms, and one record per name on a shared line", () => {
    const source = "import os, alpha.service as svc\nfrom beta.store import Thing\n";
    expect(
      parsePythonImportSites(source).map((site) => [
        site.specifier,
        source.slice(site.offset, site.offset + 3),
      ]),
    ).toEqual([
      ["os", "os,"],
      ["alpha.service", "alp"],
      ["beta.store", "bet"],
    ]);
  });

  it("reads every relative spelling, keeping the dots as written", () => {
    expect(
      parsePythonImportSites(
        [
          "from . import x",
          "from .. import y",
          "from .mod import z",
          "from ..pkg.sub import w",
        ].join("\n"),
      ).map((site) => site.specifier),
    ).toEqual([".", "..", ".mod", "..pkg.sub"]);
  });

  it("reads an indented import, which is what catches TYPE_CHECKING and function-local ones", () => {
    const source = [
      "if TYPE_CHECKING:",
      "    from alpha.model import Task",
      "",
      "def f():",
      "    import beta",
    ].join("\n");
    expect(parsePythonImportSites(source).map((site) => site.specifier)).toEqual([
      "alpha.model",
      "beta",
    ]);
  });

  it("does not read a commented-out import", () => {
    expect(parsePythonImportSites("# import fake\n#from fake import x\n")).toEqual([]);
  });

  it("reads a dynamic import and marks whether its argument was a literal", () => {
    const source = [
      'importlib.import_module("alpha.service")',
      "importlib.import_module(name)",
      '__import__("beta")',
    ].join("\n");
    expect(
      parsePythonImportSites(source).map((site) => [site.kind, site.specifier, site.literal]),
    ).toEqual([
      ["dynamic", "alpha.service", true],
      ["dynamic", "name", false],
      ["dynamic", "beta", true],
    ]);
  });
});

describe("analyzePython", () => {
  const workspace = {
    root: "/w",
    projects: [
      { name: "alpha", root: "libs/alpha" },
      { name: "beta", root: "libs/beta" },
    ],
    filesOf: (name) =>
      ({
        alpha: [
          "libs/alpha/pyproject.toml",
          "libs/alpha/src/alpha/__init__.py",
          "libs/alpha/src/alpha/service.py",
          "libs/alpha/src/alpha/deep/__init__.py",
          "libs/alpha/src/alpha/deep/thing.py",
        ],
        beta: [
          "libs/beta/pyproject.toml",
          "libs/beta/src/beta/__init__.py",
          "libs/beta/src/beta/store.py",
        ],
      })[name] ?? [],
    readFile: () => null,
  };
  const analyze = (text, sourceFile = "libs/alpha/src/alpha/service.py") =>
    analyzePython({ sourceFile, text, workspace });

  it("sees the cross-project import the manifest view cannot", () => {
    // The false negative this rewrite exists to close. Neither project
    // declares the other in `[tool.uv.sources]`, so the manifest resolver
    // draws nothing — yet the import works at runtime, both packages being on
    // sys.path in a uv workspace, and the boundary was crossed.
    expect(resolvePythonDependencies(workspace.projects, workspace.filesOf, () => null)).toEqual(
      [],
    );
    const { imports, failures } = analyze("from beta.store import Thing\n");
    expect(failures).toEqual([]);
    expect(imports[0]).toEqual({
      sourceFile: "libs/alpha/src/alpha/service.py",
      line: 1,
      column: 6,
      specifier: "beta.store",
      kind: "static",
      spelling: { path: false, relative: false },
      resolved: {
        target: "beta",
        file: "libs/beta/src/beta/store.py",
        external: false,
        packageName: null,
      },
    });
  });

  it("emits an import that never leaves the project", () => {
    const { imports } = analyze("import alpha.deep.thing\n");
    expect(imports[0].resolved).toEqual({
      target: "alpha",
      file: "libs/alpha/src/alpha/deep/thing.py",
      external: false,
      packageName: null,
    });
  });

  it("marks a stdlib or PyPI module external, named as the source spells it", () => {
    // `import PIL` ships as the distribution `pillow`; only the import name is
    // knowable from a source file, so that is what a glob must be written for.
    const { imports } = analyze("import os\nfrom PIL import Image\n");
    expect(imports.map((record) => record.resolved)).toEqual([
      { target: null, file: null, external: true, packageName: "os" },
      { target: null, file: null, external: true, packageName: "PIL" },
    ]);
  });

  it("keeps a TYPE_CHECKING import as a real static import of the project it names", () => {
    // Erased at runtime, but a runtime conditional is not a declaration that
    // the dependency is absent — the module is named and the boundary is
    // crossed. Marking it type-only would let a rule that exempts erased
    // imports exempt it, which is the bypass this tool closes.
    const { imports } = analyze(
      [
        "from typing import TYPE_CHECKING",
        "",
        "if TYPE_CHECKING:",
        "    from beta.store import Thing",
      ].join("\n"),
    );
    expect(imports[1]).toMatchObject({ line: 4, kind: "static", specifier: "beta.store" });
    expect(imports[1].resolved.target).toBe("beta");
  });

  it("resolves a relative import against the file's own package", () => {
    const { imports } = analyze("from . import deep\nfrom .deep import thing\n");
    expect(imports.map((record) => [record.specifier, record.resolved.file])).toEqual([
      [".", "libs/alpha/src/alpha/__init__.py"],
      [".deep", "libs/alpha/src/alpha/deep/__init__.py"],
    ]);
  });

  it("calls every leading-dot form relative, and none of them a path", () => {
    // Python's `./x` and `../x` — and the two the rules layer's old
    // JavaScript-shaped predicate got wrong in both directions: `.deep` and
    // `..beta` read as package names to it, while a bare `.` read as a
    // filesystem path, which is what `noRelativeOrAbsoluteExternals` is about
    // and a dotted module name is not.
    const { imports } = analyze(
      "from . import deep\nfrom .deep import thing\nfrom ..beta import store\nimport beta.store\n",
    );
    expect(imports.map((record) => [record.specifier, record.spelling])).toEqual([
      [".", { path: false, relative: true }],
      [".deep", { path: false, relative: true }],
      ["..beta", { path: false, relative: true }],
      ["beta.store", { path: false, relative: false }],
    ]);
  });

  it("still calls a relative import relative when it resolved to nothing", () => {
    // `from ... import escape` climbs out of the project and resolves to
    // nothing. The record is still spelled relatively, so nothing downstream
    // may call it a path: the honest output is the analysis failure, not a
    // violation about a path nobody wrote.
    const { imports, failures } = analyze("from ... import escape\n");
    expect(imports[0].spelling).toEqual({ path: false, relative: true });
    expect(imports[0].resolved).toBeNull();
    expect(failures).toHaveLength(1);
  });

  it("anchors a relative import in an __init__.py at its own package, not its parent", () => {
    // `pkg/__init__.py` IS `pkg`, so `from . import x` inside it means `pkg`.
    // Dropping `__init__` before taking the parent climbs one level too far
    // and resolves every relative import in every package one level wrong.
    const { imports } = analyze("from . import service\n", "libs/alpha/src/alpha/__init__.py");
    expect(imports[0].resolved.file).toBe("libs/alpha/src/alpha/__init__.py");
  });

  it("catches a relative import that climbs out of the project", () => {
    // `..` past the top-level package leaves the import root entirely, which
    // Python rejects too. Guessing a target for it is how a boundary gets
    // crossed by counting dots.
    const { imports, failures } = analyze("from ... import escape\n");
    expect(imports[0].resolved).toBeNull();
    expect(failures[0].reason).toMatch(/climbs past the top-level package/);
    expect(failures[0].line).toBe(1);
  });

  it("resolves a relative import that climbs sideways into another project", () => {
    // Two projects contributing to one namespace: `..` out of `ns.alpha` into
    // `ns.beta` is a real cross-project import, spelled with dots.
    const shared = {
      ...workspace,
      filesOf: (name) =>
        ({
          alpha: ["libs/alpha/src/ns/alpha/service.py"],
          beta: ["libs/beta/src/ns/beta/store.py"],
        })[name] ?? [],
    };
    const { imports } = analyzePython({
      sourceFile: "libs/alpha/src/ns/alpha/service.py",
      text: "from ..beta.store import Thing\n",
      workspace: shared,
    });
    expect(imports[0].resolved).toMatchObject({
      target: "beta",
      file: "libs/beta/src/ns/beta/store.py",
    });
  });

  it("resolves a namespace package by longest dotted prefix, not by its shared top level", () => {
    const shared = {
      ...workspace,
      filesOf: (name) =>
        ({
          alpha: ["libs/alpha/src/ns/alpha/thing.py"],
          beta: ["libs/beta/src/ns/beta/other.py"],
        })[name] ?? [],
    };
    const { imports, failures } = analyzePython({
      sourceFile: "libs/alpha/src/ns/alpha/thing.py",
      text: "import ns.beta.other\n",
      workspace: shared,
    });
    expect(failures).toEqual([]);
    expect(imports[0].resolved.target).toBe("beta");
  });

  it("reports a shared namespace as ambiguous rather than picking a project", () => {
    // Python resolves this by sys.path order, which no static reader can know.
    const shared = {
      ...workspace,
      filesOf: (name) =>
        ({
          alpha: ["libs/alpha/src/ns/alpha/thing.py"],
          beta: ["libs/beta/src/ns/beta/other.py"],
        })[name] ?? [],
    };
    const { imports, failures } = analyzePython({
      sourceFile: "libs/alpha/src/ns/alpha/thing.py",
      text: "import ns\n",
      workspace: shared,
    });
    expect(imports[0].resolved).toBeNull();
    expect(failures[0].reason).toMatch(/namespace package 'ns'.*alpha and beta/);
  });

  it("resolves a dynamic import with a literal argument like any other", () => {
    const { imports } = analyze('importlib.import_module("beta.store")\n');
    expect(imports[0]).toMatchObject({ kind: "dynamic", specifier: "beta.store" });
    expect(imports[0].resolved.target).toBe("beta");
  });

  it("records a dynamic import of a variable as unresolvable instead of guessing", () => {
    const { imports, failures } = analyze("importlib.import_module(plugin_name)\n");
    expect(imports[0]).toMatchObject({ kind: "dynamic", specifier: "plugin_name", resolved: null });
    expect(failures[0].reason).toMatch(/non-literal argument/);
  });

  it("returns an envelope rather than throwing when the workspace misbehaves", () => {
    const hostile = {
      ...workspace,
      filesOf: () => {
        throw new Error("graph unavailable");
      },
    };
    const result = analyzePython({ sourceFile: "a/b.py", text: "import os", workspace: hostile });
    expect(result.imports).toEqual([]);
    expect(result.failures[0].reason).toMatch(/graph unavailable/);
  });
});
