import { describe, expect, it } from "vitest";

import { CARVE_OUT_DIRS, licenseForPath, MANIFEST_LICENSE } from "./license-scope.mjs";

describe("licenseForPath", () => {
  it("reads the terms off the path the way the root LICENSE's SCOPE section does", () => {
    expect(licenseForPath("package.json")).toBe("sul");
    expect(licenseForPath("shared/libs/core-ui")).toBe("sul");
    expect(licenseForPath("rpa/packages/driver-api")).toBe("apache");
    expect(licenseForPath("hub/enterprise/sso")).toBe("ee");
    expect(licenseForPath("cloud/apps/control-plane")).toBe("proprietary");
  });

  it("keeps the doctrine tree on SUL, because this axis governs imports and not prose", () => {
    // The root LICENSE's third carve-out puts the *documents* under CC BY-SA
    // 4.0 while the modules beside them stay SUL. Resolving this path to a
    // prose licence would demand a tag no depConstraint could use.
    expect(licenseForPath("shared/libs/doctrine/src/index.ts")).toBe("sul");
    expect(licenseForPath("shared/libs/doctrine/spec/task.md")).toBe("sul");
  });

  it("carves out only a subsystem's own packages directory, never one nested deeper", () => {
    // `<area>/packages/` is the published boundary. A `packages` folder buried
    // inside a lib is an implementation detail, and treating it as a carve-out
    // would silently drop those files out of the SUL grant.
    expect(licenseForPath("shared/libs/core-ui/packages/thing.ts")).toBe("sul");
    expect(licenseForPath("shared/libs/enterprise/thing.ts")).toBe("sul");
  });

  it("gives every carve-out and every licence slug a manifest value", () => {
    // A slug with no manifest value would make the gate compare against
    // `undefined`, which every manifest satisfies by having no `license` field.
    for (const slug of [...Object.values(CARVE_OUT_DIRS), "sul", "proprietary"]) {
      expect(MANIFEST_LICENSE[slug]).toBeTypeOf("string");
    }
  });
});
