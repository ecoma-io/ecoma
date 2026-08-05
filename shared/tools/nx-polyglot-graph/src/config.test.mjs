import { describe, expect, it } from "vitest";

import { findBoundaryConfigViolations } from "./config.mjs";

/** A minimal well-formed config; each test bends exactly one thing. */
const wellFormed = () => ({
  depConstraints: [{ sourceTag: "layer:domain", onlyDependOnLibsWithTags: ["layer:util"] }],
  moduleBoundaryOptions: {
    allow: [],
    buildTargets: ["build"],
    enforceBuildableLibDependency: false,
    allowCircularSelfDependency: false,
    checkDynamicDependenciesExceptions: [],
    ignoredCircularDependencies: [],
    banTransitiveDependencies: false,
    checkNestedExternalImports: false,
  },
});

const withOptions = (overrides) => ({
  ...wellFormed(),
  moduleBoundaryOptions: { ...wellFormed().moduleBoundaryOptions, ...overrides },
});

describe("findBoundaryConfigViolations", () => {
  it("accepts a well-formed table and passes every documented row shape", () => {
    expect(findBoundaryConfigViolations(wellFormed())).toEqual([]);
    expect(
      findBoundaryConfigViolations({
        ...wellFormed(),
        depConstraints: [
          { sourceTag: "layer:view", bannedExternalImports: ["@tauri-apps/*"] },
          { allSourceTags: ["scope:shared", "type:lib"], notDependOnLibsWithTags: ["type:app"] },
          { sourceTag: "license:apache", allowedExternalImports: ["*"] },
        ],
      }),
    ).toEqual([]);
  });

  // The failure this exists to catch is not a crash. A row matching no project
  // never errors — it approves every import the workspace makes, quietly.
  it("rejects a row that names no source, because such a row approves everything", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [{ onlyDependOnLibsWithTags: ["layer:util"] }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/depConstraints\[0\].*exactly one of 'sourceTag'/s);
  });

  it("rejects a row naming both source forms, which the rule schema cannot read", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [{ sourceTag: "type:lib", allSourceTags: ["type:lib", "scope:shared"] }],
    });
    expect(violations[0]).toMatch(/exactly one of 'sourceTag' or 'allSourceTags'/);
  });

  it("requires allSourceTags to name at least two tags, since one is the other form", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [{ allSourceTags: ["type:lib"] }],
    });
    expect(violations[0]).toMatch(/allSourceTags.*at least 2 strings/);
  });

  // A misspelt field is the expensive typo: the rule accepts the row, enforces
  // the half it recognises, and drops the ban entirely.
  it("rejects an unrecognised constraint field instead of silently dropping it", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [{ sourceTag: "layer:view", bannedExternalImport: ["@tauri-apps/*"] }],
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/bannedExternalImport: not a constraint field/);
  });

  it("requires every tag list to hold strings", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [{ sourceTag: "type:lib", onlyDependOnLibsWithTags: "type:lib" }],
    });
    expect(violations[0]).toMatch(/onlyDependOnLibsWithTags: must be an array of strings/);
  });

  it("reports the index of every bad row, so a long table names its offenders", () => {
    const violations = findBoundaryConfigViolations({
      ...wellFormed(),
      depConstraints: [{ sourceTag: "type:lib" }, {}, "type:app"],
    });
    expect(violations.some((v) => v.startsWith("depConstraints[1]"))).toBe(true);
    expect(violations.some((v) => v.startsWith("depConstraints[2]"))).toBe(true);
    expect(violations.some((v) => v.startsWith("depConstraints[0]"))).toBe(false);
  });

  it("rejects a table that is not an array", () => {
    expect(findBoundaryConfigViolations({ ...wellFormed(), depConstraints: undefined })[0]).toMatch(
      /depConstraints: must be an exported array/,
    );
  });

  // Defaulting a missing option would put a second copy of its value here, and
  // the two would answer differently the day the config changed.
  it("rejects a missing option rather than substituting a value of its own", () => {
    const config = wellFormed();
    delete config.moduleBoundaryOptions.banTransitiveDependencies;
    expect(findBoundaryConfigViolations(config)).toEqual([
      "moduleBoundaryOptions.banTransitiveDependencies: missing — every option is stated explicitly",
    ]);
  });

  it("holds each option to its own type", () => {
    expect(
      findBoundaryConfigViolations(withOptions({ banTransitiveDependencies: "false" }))[0],
    ).toMatch(/banTransitiveDependencies: must be boolean/);
    expect(findBoundaryConfigViolations(withOptions({ buildTargets: "build" }))[0]).toMatch(
      /buildTargets: must be string\[\]/,
    );
    expect(
      findBoundaryConfigViolations(
        withOptions({ ignoredCircularDependencies: [["a", "b", "c"]] }),
      )[0],
    ).toMatch(/ignoredCircularDependencies: must be pair\[\]/);
    expect(
      findBoundaryConfigViolations(withOptions({ ignoredCircularDependencies: [["a", "b"]] })),
    ).toEqual([]);
  });

  it("rejects an option the rule does not have, which would otherwise read as configured", () => {
    expect(
      findBoundaryConfigViolations(withOptions({ enforceBuildableLibDependencies: true }))[0],
    ).toMatch(/enforceBuildableLibDependencies: not an option/);
  });

  it("rejects anything that is not a module object", () => {
    expect(findBoundaryConfigViolations(null)[0]).toMatch(/expected a module object/);
    expect(findBoundaryConfigViolations([])[0]).toMatch(/expected a module object/);
  });

  it("rejects an options export that is not an object", () => {
    expect(findBoundaryConfigViolations({ ...wellFormed(), moduleBoundaryOptions: [] })[0]).toMatch(
      /moduleBoundaryOptions: must be an exported object/,
    );
  });
});
