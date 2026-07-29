import { describe, expect, it } from "vitest";

import { checkDoctrine, findForbidden, findOrphanFamilies } from "./check-doctrine.mjs";

const file = (path, text) => ({ path, text });

describe("findForbidden", () => {
  it("reports a round number, because it is true only to whoever was in that round", () => {
    expect(findForbidden("chốt ở vòng 25 sau đối kháng")[0]).toMatchObject({
      line: 1,
      marker: "vòng 25",
      id: "round",
    });
  });

  it("reports a lettered round, so a sub-round is not a way around the rule", () => {
    expect(findForbidden("vòng 24u")[0].marker).toBe("vòng 24u");
  });

  it("reports a finding id, which names an episode of review rather than a property of the design", () => {
    expect(findForbidden("đóng F04 và f19").map((h) => h.marker)).toEqual(["F04", "f19"]);
  });

  it("reports a blind-spot label while leaving the prose around it, since the blind spot is worth keeping and the index is not", () => {
    const hits = findForbidden("điểm mù W10: người vá và người soi patch là một");
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("blind-spot");
  });

  it("reports a bet identifier, which belongs to the ledger that is not published", () => {
    expect(findForbidden("trỏ cược B12")[0].id).toBe("bet");
  });

  it("reports each marker at its own line, so a long document names the lines to fix", () => {
    expect(findForbidden("sạch\nvòng 3\nsạch\nF07").map((h) => h.line)).toEqual([2, 4]);
  });

  it("passes prose that carries mechanism and reasoning but no coordinates", () => {
    expect(
      findForbidden(
        "Đa tenant không cấp năng lực, chỉ tiết kiệm vận hành — invariant 4 cấm học chéo tenant.",
      ),
    ).toEqual([]);
  });
});

describe("findOrphanFamilies", () => {
  it("reports a scenario citation when the catalog did not travel with it", () => {
    expect(findOrphanFamilies([file("spec/role.md", "xem S31")]).map((f) => f.id)).toEqual([
      "scenario",
    ]);
  });

  it("accepts the same citation once the owning document is present", () => {
    expect(
      findOrphanFamilies([
        file("spec/role.md", "xem S31"),
        file("method/scenario-catalog.md", "S31 …"),
      ]),
    ).toEqual([]);
  });

  it("reports a gate citation with no roadmap, because a reader cannot open what it names", () => {
    expect(findOrphanFamilies([file("spec/task.md", "freeze tại ◆G2")]).map((f) => f.id)).toEqual([
      "gate",
    ]);
  });

  it("reports an ADR citation with no ledger — the case a partial migration produces", () => {
    expect(
      findOrphanFamilies([file("spec/data.md", "ADR-0002 chốt 5 port")]).map((f) => f.id),
    ).toEqual(["adr"]);
  });

  it("stays silent about a family nobody cites, rather than demanding every owner be present", () => {
    expect(findOrphanFamilies([file("spec/role.md", "không trỏ gì")])).toEqual([]);
  });
});

describe("checkDoctrine", () => {
  it("passes an empty tree, so the gate can land before the documents it will guard", () => {
    expect(
      checkDoctrine(
        () => "",
        () => [],
      ),
    ).toBe(0);
  });

  it("fails on a marker that survived redaction", () => {
    const list = () => ["shared/libs/doctrine/spec/role.md"];
    expect(checkDoctrine(() => "chốt vòng 12", list)).toBe(1);
  });

  it("passes a tree whose prose carries no coordinates and cites nothing orphaned", () => {
    const list = () => ["shared/libs/doctrine/spec/role.md"];
    expect(checkDoctrine(() => "Role là một vai lao động; Filler lấp vào nó.", list)).toBe(0);
  });
});
