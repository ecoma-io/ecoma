import { describe, expect, it } from "vitest";

import { resolveRustDependencies } from "./rust.mjs";

describe("resolveRustDependencies", () => {
  const projects = [
    { name: "alpha", root: "acme/libs/alpha" },
    { name: "beta", root: "acme/libs/beta" },
  ];
  const files = {
    alpha: ["acme/libs/alpha/Cargo.toml"],
    beta: ["acme/libs/beta/Cargo.toml"],
  };
  const filesOf = (name) => files[name] ?? [];

  it("draws an edge for a path dependency, from any dependency section", () => {
    const contents = {
      "acme/libs/alpha/Cargo.toml": [
        '[package]\nname = "alpha"\nversion = "0.1.0"',
        '[dev-dependencies]\nbeta = { path = "../beta" }',
        '[dependencies]\nserde = "1"',
      ].join("\n\n"),
      "acme/libs/beta/Cargo.toml": '[package]\nname = "beta"\nversion = "0.1.0"\n',
    };
    expect(resolveRustDependencies(projects, filesOf, (p) => contents[p] ?? null)).toEqual([
      {
        source: "alpha",
        target: "beta",
        sourceFile: "acme/libs/alpha/Cargo.toml",
        type: "static",
      },
    ]);
  });

  it("resolves `workspace = true` through the nearest ancestor [workspace] manifest", () => {
    const contents = {
      "acme/Cargo.toml": [
        "[workspace]",
        'members = ["libs/alpha", "libs/beta"]',
        "[workspace.dependencies]",
        'beta = { path = "libs/beta" }',
      ].join("\n"),
      "acme/libs/alpha/Cargo.toml": [
        '[package]\nname = "alpha"\nversion = "0.1.0"',
        "[dependencies]\nbeta = { workspace = true }",
      ].join("\n\n"),
      "acme/libs/beta/Cargo.toml": '[package]\nname = "beta"\nversion = "0.1.0"\n',
    };
    expect(resolveRustDependencies(projects, filesOf, (p) => contents[p] ?? null)).toEqual([
      {
        source: "alpha",
        target: "beta",
        sourceFile: "acme/libs/alpha/Cargo.toml",
        type: "static",
      },
    ]);
  });

  it("ignores registry dependencies and workspace-only manifests", () => {
    const contents = {
      "acme/libs/alpha/Cargo.toml": [
        '[package]\nname = "alpha"\nversion = "0.1.0"',
        '[dependencies]\nserde = "1"\ntokio = { version = "1", features = ["full"] }',
      ].join("\n\n"),
      "acme/libs/beta/Cargo.toml": "[workspace]\nmembers = []\n", // no [package]
    };
    expect(resolveRustDependencies(projects, filesOf, (p) => contents[p] ?? null)).toEqual([]);
  });

  it("draws target-specific dependencies too", () => {
    const contents = {
      "acme/libs/alpha/Cargo.toml": [
        '[package]\nname = "alpha"\nversion = "0.1.0"',
        '[target."cfg(unix)".dependencies]\nbeta = { path = "../beta" }',
      ].join("\n\n"),
      "acme/libs/beta/Cargo.toml": '[package]\nname = "beta"\nversion = "0.1.0"\n',
    };
    expect(resolveRustDependencies(projects, filesOf, (p) => contents[p] ?? null)).toHaveLength(1);
  });
});
