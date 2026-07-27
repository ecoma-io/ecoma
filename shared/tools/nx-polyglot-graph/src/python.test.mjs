import { describe, expect, it } from "vitest";

import {
  collectDeclaredDependencies,
  normalizePackageName,
  parseRequirementName,
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
