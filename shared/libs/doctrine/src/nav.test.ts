import { describe, expect, it } from "vitest";

import { buildNav } from "./nav";

const doc = (path: string, title = path) => ({ path, title });

describe("buildNav", () => {
  it("orders sections by the declared order rather than by how the tree happens to enumerate", () => {
    const nav = buildNav(
      [doc("spec/role.md"), doc("north-star/platform.md")],
      ["north-star", "spec"],
    );
    expect(nav.map((s) => s.id)).toEqual(["north-star", "spec"]);
  });

  it("preserves the caller's order inside a section, leaving reading order a content decision", () => {
    const nav = buildNav([doc("spec/task.md"), doc("spec/role.md")], ["spec"]);
    expect(nav[0].docs.map((d) => d.path)).toEqual(["spec/task.md", "spec/role.md"]);
  });

  it("refuses a section the tree has but the order does not, naming it — an undeclared section would otherwise be dropped silently", () => {
    expect(() => buildNav([doc("spec/role.md"), doc("charter/deploy.md")], ["spec"])).toThrow(
      /absent from the declared order: charter/,
    );
  });

  it("refuses a section the order declares but the tree lacks, so a renamed directory fails instead of rendering an empty entry", () => {
    expect(() => buildNav([doc("spec/role.md")], ["spec", "method"])).toThrow(
      /absent from the tree: method/,
    );
  });

  it("refuses a document sitting at the tree root, because it belongs to no section and would reach no reader", () => {
    expect(() => buildNav([doc("roadmap.md"), doc("spec/role.md")], ["spec"])).toThrow(
      /found at the root: roadmap\.md/,
    );
  });
});
