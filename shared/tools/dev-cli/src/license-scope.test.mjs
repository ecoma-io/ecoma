import { fc, test } from "@fast-check/vitest";
import { describe, expect, it } from "vitest";

import {
  CARVE_OUT_DIRS,
  licenseForPath,
  MANIFEST_LICENSE,
  rootLicenseSlug,
} from "./license-scope.mjs";

// Path segments from an alphabet that cannot spell a carve-out directory, so a
// generated segment never accidentally becomes the one the path rule keys on.
const segment = fc
  .array(fc.constantFrom(..."abdefgh"), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(""));
const carveOut = fc.constantFrom(...Object.keys(CARVE_OUT_DIRS));

describe("rootLicenseSlug", () => {
  it("reads the terms a tree grants off its own LICENSE, not off any path", () => {
    expect(rootLicenseSlug("Sustainable Use License\n\nAcme grants…")).toBe("sul");
    expect(rootLicenseSlug("All rights reserved.")).toBe("proprietary");
  });

  it("treats an unreadable or absent LICENSE as granting nothing", () => {
    // The safe direction. A tree whose terms cannot be read must not be assumed
    // to grant the source licence — that assumption is the one that publishes
    // something by mistake, and it cannot be taken back.
    expect(rootLicenseSlug("")).toBe("proprietary");
    expect(rootLicenseSlug(undefined)).toBe("proprietary");
  });
});

describe("licenseForPath", () => {
  it("reads the terms off the path the way the root LICENSE's SCOPE section does", () => {
    expect(licenseForPath("package.json", "sul")).toBe("sul");
    expect(licenseForPath("shared/libs/core-ui", "sul")).toBe("sul");
    expect(licenseForPath("rpa/packages/driver-api", "sul")).toBe("apache");
  });

  it("lets the tree's own terms decide before any path rule runs", () => {
    // The load-bearing precedence, and the reason the old hard-coded `cloud/`
    // segment could go: a carve-out is a promise a tree makes about part of
    // itself, so a tree that grants nothing has nothing to carve out of. Read
    // the other way, an unpublished control plane's `packages` directory would
    // announce itself as Apache 2.0 — a grant of source nobody has published.
    expect(licenseForPath("saas/apps/control-plane", "proprietary")).toBe("proprietary");
    expect(licenseForPath("enterprise/packages/sso", "proprietary")).toBe("proprietary");
    expect(licenseForPath("shared/libs/doctrine", "proprietary")).toBe("proprietary");
  });

  it("keeps the doctrine tree on SUL, because this axis governs imports and not prose", () => {
    // The root LICENSE's carve-out for prose puts the *documents* under CC BY-SA
    // 4.0 while the modules beside them stay SUL. Resolving this path to a
    // prose licence would demand a tag no depConstraint could use.
    expect(licenseForPath("shared/libs/doctrine/src/index.ts", "sul")).toBe("sul");
    expect(licenseForPath("shared/libs/doctrine/spec/task.md", "sul")).toBe("sul");
  });

  it("carves out only a subsystem's own packages directory, never one nested deeper", () => {
    // `<area>/packages/` is the published boundary. A `packages` folder buried
    // inside a lib is an implementation detail, and treating it as a carve-out
    // would silently drop those files out of the SUL grant.
    expect(licenseForPath("shared/libs/core-ui/packages/thing.ts", "sul")).toBe("sul");
  });

  it("no longer recognises an enterprise directory, because the tier is gone", () => {
    // The tier retired with its licence document. A directory of that name is
    // now ordinary code under the tree's own terms — and must be, or the gate
    // would demand an Enterprise License file that no longer exists anywhere.
    expect(CARVE_OUT_DIRS.enterprise).toBeUndefined();
    expect(licenseForPath("hub/enterprise/sso", "sul")).toBe("sul");
  });

  it("gives every carve-out and every licence slug a manifest value", () => {
    // A slug with no manifest value would make the gate compare against
    // `undefined`, which every manifest satisfies by having no `license` field.
    for (const slug of [...Object.values(CARVE_OUT_DIRS), "sul", "proprietary"]) {
      expect(MANIFEST_LICENSE[slug]).toBeTypeOf("string");
    }
  });

  it("declares no manifest value for a tier that no longer exists", () => {
    // The inverse of the rule above, and the one a deletion actually breaks: a
    // leftover `ee` entry would keep a retired slug spendable, so a stale tag
    // would resolve to real terms instead of failing loudly.
    expect(MANIFEST_LICENSE.ee).toBeUndefined();
  });

  // Every path in the tree passes through here, and the answer decides which
  // terms ship with a file — so the examples above are a sample of a space the
  // properties below have to hold across: an unrecognised answer would compare
  // against an undefined manifest value, and a carve-out read at the wrong
  // depth silently moves files out of (or into) the grant.
  test.prop([fc.array(segment, { minLength: 1, maxLength: 5 })])(
    "answers with a licence slug the manifest map declares, for any path in the tree",
    (segments) => {
      expect(Object.keys(MANIFEST_LICENSE)).toContain(licenseForPath(segments.join("/"), "sul"));
    },
  );

  test.prop([segment, carveOut, fc.array(segment, { maxLength: 4 })])(
    "carves out a subsystem's own packages directory, however deep the file sits",
    (subsystem, dir, rest) => {
      expect(licenseForPath([subsystem, dir, ...rest].join("/"), "sul")).toBe(CARVE_OUT_DIRS[dir]);
    },
  );

  test.prop([segment, segment, carveOut, fc.array(segment, { maxLength: 3 })])(
    "reads a carve-out directory only directly beneath a subsystem root, never nested deeper",
    (subsystem, inner, dir, rest) => {
      expect(licenseForPath([subsystem, inner, dir, ...rest].join("/"), "sul")).toBe("sul");
    },
  );

  test.prop([carveOut, fc.array(segment, { maxLength: 3 })])(
    "keeps an unpublished tree proprietary at every path, carve-out name or not",
    (dir, rest) => {
      // The property the hard-coded `cloud/` segment used to provide for one
      // directory name only. It now holds for any area the private workspace
      // cares to have, which is what lets that workspace rename its areas
      // without this function knowing.
      expect(licenseForPath([...rest, dir].join("/"), "proprietary")).toBe("proprietary");
    },
  );
});
