import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import { CARVE_OUT_DIRS, licenseForPath, MANIFEST_LICENSE } from "./license-scope.mjs";

// Path segments from an alphabet that can spell neither `cloud` nor either
// carve-out directory, so a generated segment never accidentally becomes the
// one the path rule is keyed on.
const segment = fc
  .array(fc.constantFrom(..."abdefgh"), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(""));
const carveOut = fc.constantFrom(...Object.keys(CARVE_OUT_DIRS));

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

  // Every path in the tree passes through here, and the answer decides which
  // terms ship with a file — so the examples above are a sample of a space the
  // properties below have to hold across: an unrecognised answer would compare
  // against an undefined manifest value, and a carve-out read at the wrong
  // depth silently moves files out of (or into) the grant.
  test.prop([fc.array(segment, { minLength: 1, maxLength: 5 })])(
    "answers with a licence slug the manifest map declares, for any path in the tree",
    (segments) => {
      expect(Object.keys(MANIFEST_LICENSE)).toContain(licenseForPath(segments.join("/")));
    },
  );

  test.prop([segment, carveOut, fc.array(segment, { maxLength: 4 })])(
    "carves out a subsystem's own packages/enterprise directory, however deep the file sits",
    (subsystem, dir, rest) => {
      expect(licenseForPath([subsystem, dir, ...rest].join("/"))).toBe(CARVE_OUT_DIRS[dir]);
    },
  );

  test.prop([segment, segment, carveOut, fc.array(segment, { maxLength: 3 })])(
    "reads a carve-out directory only directly beneath a subsystem root, never nested deeper",
    (subsystem, inner, dir, rest) => {
      expect(licenseForPath([subsystem, inner, dir, ...rest].join("/"))).toBe("sul");
    },
  );

  test.prop([carveOut, fc.array(segment, { maxLength: 3 })])(
    "keeps the private cloud tree proprietary even where a carve-out directory name sits inside it",
    (dir, rest) => {
      expect(licenseForPath(["cloud", dir, ...rest].join("/"))).toBe("proprietary");
    },
  );
});
