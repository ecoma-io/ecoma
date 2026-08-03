import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deriveGoVersion,
  scaffoldLib,
  withAlias,
  withCargoMember,
  withGitignoreLines,
  withGoWorkUse,
  withUvMember,
} from "./scaffold-lib.mjs";

const errors = () => vi.spyOn(console, "error").mockImplementation(() => {});

// Fixed tracked-paths stand-in for deriveSubsystemRoots — mirrors the old
// hardcoded DOMAINS vocabulary (shared, connectors) without shelling to git.
const listPaths = () => ["shared/libs/x/src/index.ts", "connectors/libs/y/src/index.ts"];

afterEach(() => vi.restoreAllMocks());

describe("withAlias", () => {
  it("registers the alias while preserving existing paths", () => {
    const out = withAlias(
      JSON.stringify({ compilerOptions: { paths: { "@ecoma-io/hash": ["x"] } } }),
      "@ecoma-io/thing",
      "shared/libs/thing/src/index.ts",
    );
    expect(JSON.parse(out).compilerOptions.paths).toEqual({
      "@ecoma-io/hash": ["x"],
      "@ecoma-io/thing": ["shared/libs/thing/src/index.ts"],
    });
  });

  it("refuses to clobber an existing alias", () => {
    const base = JSON.stringify({ compilerOptions: { paths: { "@ecoma-io/thing": ["x"] } } });
    expect(() => withAlias(base, "@ecoma-io/thing", "y")).toThrow(/already exists/);
  });
});

describe("scaffoldLib argument validation", () => {
  const fsNever = new Proxy({}, { get: () => vi.fn() });

  it.each([
    [[], "name must be kebab-case"],
    [["MyLib", "--subsystem", "shared"], "name must be kebab-case"],
    [["thing"], "--subsystem must be an existing top-level subsystem"],
    [["thing", "--subsystem", "acme"], "--subsystem must be an existing top-level subsystem"],
    [["thing", "--subsystem", "shared", "--layer", "ui"], "--layer must be one of"],
    [["thing", "--subsystem", "shared", "--lang", "java"], "--lang must be one of"],
  ])("rejects %j with usage guidance", (args, message) => {
    const error = errors();
    expect(scaffoldLib(args, fsNever, listPaths)).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(message));
  });

  it("rejects a subsystem that does not exist in the tracked file tree", () => {
    // The vocabulary is derived from deriveSubsystemRoots against the
    // tracked file tree, never hardcoded — a subsystem absent there must
    // be rejected, or the generator scaffolds a project that silently
    // escapes the dependency boundary.
    const error = errors();
    expect(scaffoldLib(["thing", "--subsystem", "vider"], fsNever, listPaths)).toBe(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("--subsystem must be an existing top-level subsystem"),
    );
  });

  it("never overwrites an existing directory", () => {
    const error = errors();
    const fs = { existsSync: () => true };
    expect(scaffoldLib(["thing", "--subsystem", "shared"], fs, listPaths)).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("never overwrites"));
  });
});

describe("scaffoldLib file emission", () => {
  it("writes every required file and registers the alias", () => {
    const written = new Map();
    const fs = {
      existsSync: () => false,
      readFileSync: () => JSON.stringify({ compilerOptions: { paths: {} } }),
      mkdirSync: vi.fn(),
      writeFileSync: (path, content) => written.set(path, content),
    };
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(
      scaffoldLib(["thing", "--subsystem", "shared", "--layer", "domain"], fs, listPaths),
    ).toBe(0);

    const project = JSON.parse(written.get("shared/libs/thing/project.json"));
    expect(project.tags).toEqual(["type:lib", "scope:shared", "license:sul", "layer:domain"]);
    expect(Object.keys(project.targets)).toEqual(["typecheck", "lint", "test"]);
    expect(project.sourceRoot).toBe("shared/libs/thing/src");

    const pkg = JSON.parse(written.get("shared/libs/thing/package.json"));
    expect(pkg).toMatchObject({
      name: "@ecoma-io/thing",
      private: true,
      main: "./src/index.ts",
      // Born declaring the terms its path implies — a lib scaffolded without
      // this arrives failing the very gate that scaffolded it.
      license: "LicenseRef-Ecoma-SustainableUse-1.0",
    });
    expect(pkg.dependencies).toBeUndefined();

    expect(written.get("shared/libs/thing/CLAUDE.md")).toContain("TODO");
    expect(JSON.parse(written.get("tsconfig.base.json")).compilerOptions.paths).toEqual({
      "@ecoma-io/thing": ["shared/libs/thing/src/index.ts"],
    });
  });

  it("emits each README variant in its own language, not three copies of the English one", () => {
    const written = new Map();
    const fs = {
      existsSync: () => false,
      readFileSync: () => JSON.stringify({ compilerOptions: { paths: {} } }),
      mkdirSync: vi.fn(),
      writeFileSync: (path, content) => written.set(path, content),
    };
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(scaffoldLib(["thing", "--subsystem", "shared"], fs, listPaths)).toBe(0);

    const variants = {
      en: written.get("shared/libs/thing/README.md"),
      vi: written.get("shared/libs/thing/README.vi.md"),
      zh: written.get("shared/libs/thing/README.zh.md"),
    };
    // Frontmatter identity is per-variant; the project it names is not.
    for (const [lang, content] of Object.entries(variants)) {
      expect(content).toContain(`lang: ${lang}`);
      expect(content).toContain("name: thing");
      expect(content).toContain("subsystem: shared");
      expect(content).toContain("./CLAUDE.md");
    }
    // The prose is genuinely translated — three files whose bodies matched
    // would satisfy every structural gate while shipping untranslated stubs.
    expect(variants.vi).toContain("## Tại sao nó tồn tại");
    expect(variants.zh).toContain("## 为什么存在");
    expect(variants.en).toContain("## Why it exists");
    expect(new Set(Object.values(variants)).size).toBe(3);
  });

  it("tells the caller to stage the scaffold before verifying, since check-project-conventions discovers projects from tracked project.json files", () => {
    const fs = {
      existsSync: () => false,
      readFileSync: () => JSON.stringify({ compilerOptions: { paths: {} } }),
      mkdirSync: vi.fn(),
      writeFileSync: () => {},
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    expect(scaffoldLib(["thing", "--subsystem", "shared"], fs, listPaths)).toBe(0);

    const printed = log.mock.calls.flat().join("\n");
    expect(printed).toContain("git add shared/libs/thing");
    // The staging step must come before the verification commands it unblocks.
    expect(printed.indexOf("git add shared/libs/thing")).toBeLessThan(
      printed.indexOf("check-project-conventions"),
    );
  });

  it("omits the layer tag when no layer is given", () => {
    const written = new Map();
    const fs = {
      existsSync: () => false,
      readFileSync: () => JSON.stringify({ compilerOptions: { paths: {} } }),
      mkdirSync: vi.fn(),
      writeFileSync: (path, content) => written.set(path, content),
    };
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(scaffoldLib(["thing", "--subsystem", "shared"], fs, listPaths)).toBe(0);
    expect(JSON.parse(written.get("shared/libs/thing/project.json")).tags).toEqual([
      "type:lib",
      "scope:shared",
      "license:sul",
    ]);
  });
});

describe("scaffoldLib polyglot emission", () => {
  const scaffold = (args) => {
    const written = new Map();
    const fs = {
      existsSync: () => false, // no lib dir, no root manifests yet
      readFileSync: () => {
        throw new Error("unexpected read");
      },
      mkdirSync: vi.fn(),
      writeFileSync: (path, content) => written.set(path, content),
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(scaffoldLib(args, fs, listPaths)).toBe(0);
    return written;
  };

  it("go: hand-written run-commands targets, go.mod, and a fresh go.work", () => {
    const written = scaffold(["runner", "--subsystem", "shared", "--lang", "go"]);
    const project = JSON.parse(written.get("shared/libs/runner/project.json"));
    expect(Object.keys(project.targets).sort()).toEqual(["build", "lint", "test", "typecheck"]);
    for (const target of Object.values(project.targets)) {
      expect(target.executor).toBe("nx:run-commands");
    }
    expect(project.targets.lint.options.command).toContain("check-gofmt");
    expect(project.targets.lint.options.command).toContain("golangci-lint run");
    expect(project.targets.lint.options.command).toContain("eslint project.json");
    expect(project.targets.lint.options.command).toContain("check-journey-markers");
    expect(written.get("shared/libs/runner/go.mod")).toContain("module ecoma.io/shared/runner");
    expect(written.get("go.work")).toContain("use (\n\t./shared/libs/runner\n)");
    expect(written.has("shared/libs/runner/package.json")).toBe(false);
    expect(written.has("tsconfig.base.json")).toBe(false);
  });

  it("points sourceRoot at the project root for a language whose sources are not under src/", () => {
    // A Go module's packages sit at the module root; `<root>/src` named a
    // directory the emitter never writes into.
    const go = JSON.parse(
      scaffold(["runner", "--subsystem", "shared", "--lang", "go"]).get(
        "shared/libs/runner/project.json",
      ),
    );
    expect(go.sourceRoot).toBe("shared/libs/runner");

    for (const [lang, project] of [
      ["rust", "engine"],
      ["python", "tool-kit"],
    ]) {
      const written = scaffold([project, "--subsystem", "shared", "--lang", lang]);
      expect(JSON.parse(written.get(`shared/libs/${project}/project.json`)).sourceRoot).toBe(
        `shared/libs/${project}/src`,
      );
    }
  });

  it("go: stamps go.mod with the version pinned by the repo's existing go.work (Rule 14)", () => {
    const written = new Map();
    const fs = {
      existsSync: (path) => path === "go.work",
      readFileSync: (path) => {
        if (path === "go.work") return "go 1.26.5\n\nuse (\n\t./shared/libs/other\n)\n";
        throw new Error(`unexpected read: ${path}`);
      },
      mkdirSync: vi.fn(),
      writeFileSync: (path, content) => written.set(path, content),
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(scaffoldLib(["runner", "--subsystem", "shared", "--lang", "go"], fs, listPaths)).toBe(0);
    expect(written.get("shared/libs/runner/go.mod")).toContain("go 1.26.5\n");
    // Existing use-block member survives the append, not just the new one.
    expect(written.get("go.work")).toContain("./shared/libs/other");
    expect(written.get("go.work")).toContain("./shared/libs/runner");
  });

  it("rust: crate manifest plus root workspace bootstrap and target/ ignore", () => {
    const written = scaffold(["engine", "--subsystem", "shared", "--lang", "rust"]);
    expect(written.get("shared/libs/engine/Cargo.toml")).toContain('name = "engine"');
    expect(written.get("Cargo.toml")).toBe(
      '[workspace]\nresolver = "3"\nmembers = ["shared/libs/engine"]\n',
    );
    expect(written.get(".gitignore")).toContain("target/");
    const project = JSON.parse(written.get("shared/libs/engine/project.json"));
    expect(project.targets.lint.options.command).toContain("cargo clippy");
    expect(project.targets.typecheck.options.command).toBe("cargo check --all-targets");
  });

  it("python: uv src-layout package plus workspace member and .venv ignore", () => {
    const written = scaffold(["tool-kit", "--subsystem", "shared", "--lang", "python"]);
    expect(written.get("shared/libs/tool-kit/pyproject.toml")).toContain('name = "tool-kit"');
    expect(written.get("shared/libs/tool-kit/src/tool_kit/__init__.py")).toContain('"""');
    expect(written.get("pyproject.toml")).toContain('members = ["shared/libs/tool-kit"]');
    expect(written.get(".gitignore")).toContain(".venv/");
    const project = JSON.parse(written.get("shared/libs/tool-kit/project.json"));
    expect(project.targets.lint.options.command).toContain("uv run ruff check");
    expect(project.targets.test.options.command).toBe("uv run pytest");
    expect(project.targets.build).toBeUndefined();
    // pytest exits 5 on an empty suite, so without this the scaffold's own
    // test target is red before a single test is written.
    expect(written.get("shared/libs/tool-kit/conftest.py")).toContain(
      "pytest.ExitCode.NO_TESTS_COLLECTED",
    );
    // Tests live inside src/, and uv_build ships everything under the module
    // root — without both excludes a distribution carries the test suite.
    expect(written.get("shared/libs/tool-kit/pyproject.toml")).toContain(
      '[tool.uv.build-backend]\nsource-exclude = ["**/*_test.py"]\nwheel-exclude = ["**/*_test.py"]',
    );
  });
});

describe("deriveGoVersion", () => {
  it("reads the go.work pin verbatim", () => {
    expect(deriveGoVersion("go 1.26.5\n\nuse (\n\t./shared/libs/a\n)\n")).toBe("1.26.5");
  });

  it("falls back to the bootstrap constant when go.work does not exist yet", () => {
    expect(deriveGoVersion(null)).toBe("1.26.5");
  });

  it("fails loud on a go.work with no `go X.Y.Z` line", () => {
    expect(() => deriveGoVersion("use (\n\t./shared/libs/a\n)\n")).toThrow(/go X\.Y\.Z/);
  });
});

describe("workspace bootstrap transforms", () => {
  it("go.work: creates, appends into the use block, and stays idempotent", () => {
    const fresh = withGoWorkUse(null, "shared/libs/a");
    expect(fresh).toContain("use (\n\t./shared/libs/a\n)");
    const appended = withGoWorkUse(fresh, "shared/libs/b");
    expect(appended).toContain("./shared/libs/a");
    expect(appended).toContain("./shared/libs/b");
    expect(withGoWorkUse(appended, "shared/libs/a")).toBe(appended);
  });

  it("go.work: detects an existing member on a CRLF-checked-out file", () => {
    const crlf = withGoWorkUse(null, "shared/libs/a").replace(/\n/g, "\r\n");
    expect(withGoWorkUse(crlf, "shared/libs/a")).toBe(crlf);
  });

  it("Cargo.toml: creates a workspace, appends members, and fails loud without [workspace]", () => {
    const fresh = withCargoMember(null, "shared/libs/a");
    const appended = withCargoMember(fresh, "shared/libs/b");
    expect(appended).toContain('members = ["shared/libs/a", "shared/libs/b"]');
    expect(withCargoMember(appended, "shared/libs/a")).toBe(appended);
    expect(() => withCargoMember('[package]\nname = "root"\n', "x")).toThrow(/no \[workspace\]/);
  });

  it("pyproject.toml: creates the uv workspace table, appends members, fails loud without it", () => {
    const fresh = withUvMember(null, "shared/libs/a");
    const appended = withUvMember(fresh, "shared/libs/b");
    expect(appended).toContain('members = ["shared/libs/a", "shared/libs/b"]');
    expect(() => withUvMember('[project]\nname = "root"\n', "x")).toThrow(/tool\.uv\.workspace/);
  });

  it(".gitignore: appends only the missing lines", () => {
    expect(withGitignoreLines("node_modules\n", ["target/"])).toBe("node_modules\ntarget/\n");
    expect(withGitignoreLines("node_modules\ntarget/\n", ["target/"])).toBe(
      "node_modules\ntarget/\n",
    );
  });

  it(".gitignore: detects an existing line on a CRLF-checked-out file", () => {
    expect(withGitignoreLines("node_modules\r\ntarget/\r\n", ["target/"])).toBe(
      "node_modules\r\ntarget/\r\n",
    );
  });
});
