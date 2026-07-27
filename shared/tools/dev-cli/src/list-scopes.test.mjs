import { afterEach, describe, expect, it, vi } from "vitest";

import { listScopes } from "./list-scopes.mjs";

const PROJECTS = [
  { name: "vider", root: "vider/apps/vider" },
  { name: "vider-ui", root: "vider/libs/vider-ui" },
  { name: "core-ui", root: "shared/libs/core-ui" },
];

describe("listScopes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emits every project name, every subsystem, and workspace — deduped and sorted", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(listScopes([], () => PROJECTS)).toBe(0);
    // `vider` names both the app project and its subsystem — one scope, not two.
    expect(log).toHaveBeenCalledWith("core-ui\nshared\nvider\nvider-ui\nworkspace");
  });

  it("emits a JSON array under --json", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(listScopes(["--json"], () => PROJECTS)).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual([
      "core-ui",
      "shared",
      "vider",
      "vider-ui",
      "workspace",
    ]);
  });
});
