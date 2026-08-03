import { describe, expect, it } from "vitest";

import {
  checkDependencyCooldown,
  findCooldownFaults,
  PNPM_CONFIG,
  readPnpmCooldown,
  readRenovateCooldown,
  RENOVATE_CONFIG,
} from "./check-dependency-cooldown.mjs";

const renovate = (spelling) => `{
  packageRules: [
    {
      matchUpdateTypes: ["major", "minor", "patch"],
      minimumReleaseAge: ${spelling},
    },
  ],
}`;

const pnpm = (minutes) =>
  `# a comment mentioning minimumReleaseAge in prose\nminimumReleaseAge: ${minutes}\n`;

/** Serves each config from an in-memory map, so no test touches the real tree. */
const reader = (files) => (path) => {
  if (!(path in files)) throw new Error(`missing fixture for ${path}`);
  return files[path];
};

describe("readRenovateCooldown", () => {
  it("reports the days spelling in minutes, so both halves compare in one unit", () => {
    expect(readRenovateCooldown(renovate('"14 days"'))).toBe(20160);
    expect(readRenovateCooldown(renovate('"1 day"'))).toBe(1440);
  });

  it("reports no cooldown for a spelling this gate cannot convert without guessing", () => {
    expect(readRenovateCooldown(renovate('"2 weeks"'))).toBe(null);
    expect(readRenovateCooldown(renovate("null"))).toBe(null);
  });
});

describe("readPnpmCooldown", () => {
  it("reads the bare minute count and not a mention of the key in prose", () => {
    expect(readPnpmCooldown(pnpm(20160))).toBe(20160);
    expect(readPnpmCooldown("# minimumReleaseAge is described here but never set\n")).toBe(null);
  });
});

describe("findCooldownFaults", () => {
  it("passes only when both halves state the same duration", () => {
    expect(findCooldownFaults(20160, 20160)).toEqual([]);
  });

  it("names the disagreement when one half is shorter than the other", () => {
    const [fault] = findCooldownFaults(20160, 4320);
    expect(fault).toContain("the two halves disagree");
    expect(fault).toContain("4320 minutes");
  });

  it("treats a missing half as a fault, because half a cooldown reads as a cooldown", () => {
    expect(findCooldownFaults(null, 20160)[0]).toContain(RENOVATE_CONFIG);
    expect(findCooldownFaults(20160, null)[0]).toContain(PNPM_CONFIG);
    expect(findCooldownFaults(null, null)).toHaveLength(2);
  });

  it("names transitive dependencies when pnpm's half is the missing one", () => {
    expect(findCooldownFaults(20160, null)[0]).toContain("transitive");
  });
});

describe("checkDependencyCooldown", () => {
  it("exits 0 when the two files agree", () => {
    const read = reader({ [RENOVATE_CONFIG]: renovate('"14 days"'), [PNPM_CONFIG]: pnpm(20160) });
    expect(checkDependencyCooldown({ read })).toBe(0);
  });

  it("exits 1 when they drift apart", () => {
    const read = reader({ [RENOVATE_CONFIG]: renovate('"14 days"'), [PNPM_CONFIG]: pnpm(1440) });
    expect(checkDependencyCooldown({ read })).toBe(1);
  });

  it("exits 1 rather than passing when a config cannot be read at all", () => {
    const read = reader({ [RENOVATE_CONFIG]: renovate('"14 days"') });
    expect(checkDependencyCooldown({ read })).toBe(1);
  });
});
