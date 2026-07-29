import { describe, expect, it } from "vitest";

import {
  splitLangs,
  checkDoctrine,
  findForbidden,
  findOrphanFamilies,
  findStaleVariants,
  fingerprint,
} from "./check-doctrine.mjs";

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

  it("reports a bet identifier while leaving the rubric's own group-B criteria alone, which a bare B-number could not distinguish", () => {
    expect(findForbidden("B1 mọi câu chứa người/AI")).toEqual([]);
    expect(findForbidden("trỏ cược BET-12")[0].id).toBe("bet");
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

  // The three rules are pinned directly above; these pin that the runner
  // actually consults each of them. Deleting a loop leaves every direct test
  // green, which is how a rule stops running without anyone noticing.

  it("fails on a variant left behind, so the staleness rule is reached and not merely present", () => {
    const canonical = "# Role\n\nnội dung";
    const texts = {
      "shared/libs/doctrine/spec/role.md": `${canonical} đã sửa`,
      "shared/libs/doctrine/spec/role.vi.md": `---\ncanonical-sha: ${fingerprint(canonical)}\n---\n# Vai`,
    };
    expect(
      checkDoctrine(
        (path) => texts[path],
        () => Object.keys(texts),
      ),
    ).toBe(1);
  });

  it("passes the same pair once the variant records the canonical it was written from", () => {
    const canonical = "# Role\n\nnội dung";
    const texts = {
      "shared/libs/doctrine/spec/role.md": canonical,
      "shared/libs/doctrine/spec/role.vi.md": `---\ncanonical-sha: ${fingerprint(canonical)}\n---\n# Vai`,
    };
    expect(
      checkDoctrine(
        (path) => texts[path],
        () => Object.keys(texts),
      ),
    ).toBe(0);
  });

  it("fails on a citation whose owning document stayed behind, so the family rule is reached too", () => {
    const list = () => ["shared/libs/doctrine/spec/task.md"];
    expect(checkDoctrine(() => "freeze tại ◆G2", list)).toBe(1);
  });
});

describe("findStaleVariants", () => {
  const canonical = "# Role\n\nRole là một vai lao động.";
  const marked = (sha) => `---\ncanonical-sha: ${sha}\n---\n\n# Vai`;
  const pair = (canonicalText, sha) => [
    { path: "doctrine/spec/role.md", text: canonicalText },
    { path: "doctrine/spec/role.vi.md", text: marked(sha) },
  ];

  it("accepts a variant whose fingerprint matches the canonical it was written from", () => {
    expect(findStaleVariants(pair(canonical, fingerprint(canonical)))).toEqual([]);
  });

  it("reports a variant left behind when the canonical was edited, naming the value to record", () => {
    const edited = `${canonical} Filler lấp vào nó.`;
    const problems = findStaleVariants(pair(edited, fingerprint(canonical)));
    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe("stale");
    expect(problems[0].why).toContain(fingerprint(edited));
  });

  it("reports a variant carrying no fingerprint at all, and prints the one to add", () => {
    const problems = findStaleVariants([
      { path: "doctrine/spec/role.md", text: canonical },
      { path: "doctrine/spec/role.vi.md", text: "# Vai" },
    ]);
    expect(problems[0].kind).toBe("unmarked");
    expect(problems[0].why).toContain(fingerprint(canonical));
  });

  it("reports a variant whose canonical did not travel with it", () => {
    expect(
      findStaleVariants([{ path: "doctrine/spec/role.vi.md", text: marked("aaaaaaaaaaaa") }])[0],
    ).toMatchObject({ kind: "orphan" });
  });

  it("leaves a canonical-only document alone, because a variant is optional and an absent one misleads nobody", () => {
    expect(findStaleVariants([{ path: "doctrine/spec/role.md", text: canonical }])).toEqual([]);
  });

  it("treats a dotted name that is not a language as canonical rather than an unmarked variant", () => {
    expect(findStaleVariants([{ path: "doctrine/spec/role.draft.md", text: canonical }])).toEqual(
      [],
    );
  });
});

describe("splitLangs", () => {
  it("takes the first entry as canonical, which is what the config's ordering means", () => {
    expect(splitLangs(["aa", "bb", "cc"]).canonical).toBe("aa");
  });

  it("takes every other entry as a variant, against a triad the workspace does not use — a hand-written ['vi','zh'] passes an assertion against the real config and fails this one", () => {
    expect(splitLangs(["aa", "bb", "cc"]).variants).toEqual(["bb", "cc"]);
  });

  it("leaves no variants for a single-language workspace rather than inventing one", () => {
    expect(splitLangs(["aa"]).variants).toEqual([]);
  });
});
