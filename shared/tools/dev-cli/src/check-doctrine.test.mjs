import { describe, expect, it, vi } from "vitest";

import {
  splitLangs,
  checkDoctrine,
  findForbidden,
  findOrphanFamilies,
  findStaleVariants,
  findUnmappedDocuments,
  CORPUS_MAP,
  DOCTRINE_ROOT,
  findUnmarkedEntries,
  WITHHELD_MARKER,
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

  it("reports an English round reference, so the language a document is written in is not a way around the rule", () => {
    expect(findForbidden("Round #5 caught three majors")[0]).toMatchObject({
      marker: "Round #5",
      id: "round",
    });
  });

  it("reports a round code whose word was stripped, since redaction that removes only the word leaves the coordinate", () => {
    expect(findForbidden("án văn giữ nguyên từ 24u")[0]).toMatchObject({
      marker: "24u",
      id: "round-code",
    });
  });

  it("leaves the rubric's own group-F criteria alone, which a pattern matching unpadded finding ids could not distinguish", () => {
    expect(findForbidden("F3 mở rộng live-view; F8 FMEA subsystem")).toEqual([]);
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
  // A fixture tree carrying a corpus map that routes every canonical document
  // in it. Without this, every test about one rule would silently also be a
  // test about the routing rule, and would fail for a reason it never meant to
  // assert.
  const withMap = (texts) => ({
    [CORPUS_MAP]: Object.keys(texts)
      .map((path) => `[doc](${path.replace(`${DOCTRINE_ROOT}/`, "../")})`)
      .join("\n"),
    ...texts,
  });
  const runOver = (texts, args = []) =>
    checkDoctrine(args, {
      read: (path) => texts[path],
      list: () => Object.keys(texts),
      error: () => {},
    });

  it("passes an empty tree, so the gate can land before the documents it will guard", () => {
    expect(checkDoctrine([], { read: () => "", list: () => [], error: () => {} })).toBe(0);
  });

  it("fails on a marker that survived redaction", () => {
    const list = () => ["shared/libs/doctrine/spec/role.md"];
    expect(checkDoctrine([], { read: () => "chốt vòng 12", list, error: () => {} })).toBe(1);
  });

  it("passes a tree whose prose carries no coordinates and cites nothing orphaned", () => {
    expect(
      runOver(
        withMap({
          "shared/libs/doctrine/spec/role.md": "Role là một vai lao động; Filler lấp vào nó.",
        }),
      ),
    ).toBe(0);
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
    expect(runOver(texts)).toBe(1);
  });

  it("passes the same pair once the variant records the canonical it was written from", () => {
    const canonical = "# Role\n\nnội dung";
    expect(
      runOver(
        withMap({
          "shared/libs/doctrine/spec/role.md": canonical,
          "shared/libs/doctrine/spec/role.vi.md": `---\ncanonical-sha: ${fingerprint(canonical)}\n---\n# Vai`,
        }),
      ),
    ).toBe(0);
  });

  it("fails on a published document the corpus map does not route to, so the routing rule is reached too", () => {
    const texts = {
      [CORPUS_MAP]: "# Index",
      "shared/libs/doctrine/spec/role.md": "Role là một vai lao động.",
    };
    expect(runOver(texts)).toBe(1);
  });

  it("fails on a citation whose owning document stayed behind, so the family rule is reached too", () => {
    const list = () => ["shared/libs/doctrine/spec/task.md"];
    expect(checkDoctrine([], { read: () => "freeze tại ◆G2", list, error: () => {} })).toBe(1);
  });
});

// The withheld tier is judged by the same command with a different rule set,
// derived from the root rather than declared. Each tier-scoped rule is pinned
// from both sides: the same fixture under the published root must still fail,
// so none of these can pass by the rule having quietly stopped running.
describe("checkDoctrine over the withheld tier", () => {
  const WITHHELD = "cloud/libs/doctrine";
  const runAt = (root, texts) =>
    checkDoctrine([root], {
      read: (path) => texts[path],
      list: () => Object.keys(texts),
      error: () => {},
    });

  it("accepts a bet identifier in the tier that holds the ledger defining it", () => {
    expect(runAt(WITHHELD, { [`${WITHHELD}/icp-ledger.md`]: "The wedge converts — BET-3." })).toBe(
      0,
    );
  });

  it("still refuses that identifier where publication is what makes it a violation", () => {
    const texts = {
      [CORPUS_MAP]: `[doc](../icp-ledger.md)`,
      [`${DOCTRINE_ROOT}/icp-ledger.md`]: "The wedge converts — BET-3.",
    };
    expect(runAt(DOCTRINE_ROOT, texts)).toBe(1);
  });

  it("refuses an episode coordinate here too — end state is a property of doctrine, not of publication", () => {
    expect(runAt(WITHHELD, { [`${WITHHELD}/eng-charter.md`]: "chốt ở vòng 31" })).toBe(1);
  });

  it("holds a variant to its canonical here too", () => {
    const canonical = "# Charter\n\nbody";
    const texts = {
      [`${WITHHELD}/eng-charter.md`]: `${canonical} edited`,
      [`${WITHHELD}/eng-charter.vi.md`]: `---\ncanonical-sha: ${fingerprint(canonical)}\n---\n# Điều lệ`,
    };
    expect(runAt(WITHHELD, texts)).toBe(1);
  });

  it("demands no corpus map, because the tier has no outside reader to route", () => {
    expect(runAt(WITHHELD, { [`${WITHHELD}/web-charter.md`]: "The funnel's dual goal." })).toBe(0);
    // The same lone document under the published root fails for want of the
    // map — the routing rule is scoped, not deleted.
    expect(runAt(DOCTRINE_ROOT, { [`${DOCTRINE_ROOT}/web-charter.md`]: "x" })).toBe(1);
  });

  it("lets a withheld document cite a family whose owner is published across the boundary", () => {
    expect(runAt(WITHHELD, { [`${WITHHELD}/roadmap-unpublished.md`]: "blocked until ◆G4" })).toBe(
      0,
    );
  });

  // The failure this pins is the one that reads as success: a tree whose
  // documents sit directly at its root was matched by no pathspec, so the gate
  // reported clean having opened nothing. Asserting the exit code alone cannot
  // tell that apart from a genuinely clean tree — the list call is the evidence.
  it("reaches documents sitting directly at the root, where the withheld tier keeps all of them", () => {
    const list = vi.fn(() => [`${WITHHELD}/eng-charter.md`]);
    const read = vi.fn(() => "chốt ở vòng 31");
    expect(checkDoctrine([WITHHELD], { read, list, error: () => {} })).toBe(1);
    expect(read).toHaveBeenCalled();
  });

  it("still leaves the project's own README and CLAUDE.md to their own gate", () => {
    const texts = {
      [`${WITHHELD}/README.md`]: "vòng 31",
      [`${WITHHELD}/README.vi.md`]: "vòng 31",
      [`${WITHHELD}/CLAUDE.md`]: "vòng 31",
    };
    expect(runAt(WITHHELD, texts)).toBe(0);
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

describe("findUnmappedDocuments", () => {
  const map = (body) => file(CORPUS_MAP, body);
  const spec = "shared/libs/doctrine/spec/role.md";

  it("reports a document the corpus map does not route to, because a page nobody links is a page nobody arrives at", () => {
    expect(findUnmappedDocuments([map("# Index"), file(spec, "# Role")])[0]).toMatchObject({
      path: spec,
    });
  });

  it("accepts a document the map links, resolving the link against the map's own directory", () => {
    expect(findUnmappedDocuments([map("[Role](../spec/role.md)"), file(spec, "# Role")])).toEqual(
      [],
    );
  });

  it("does not demand that the map route to itself", () => {
    expect(findUnmappedDocuments([map("# Index")])).toEqual([]);
  });

  it("lets a canonical's row route its translation too, since a variant is the same document", () => {
    const files = [
      map("[Role](../spec/role.md)"),
      file(spec, "# Role"),
      file("shared/libs/doctrine/spec/role.vi.md", "# Role"),
    ];
    expect(findUnmappedDocuments(files)).toEqual([]);
  });

  it("reports the absent map once rather than reporting every document as unrouted", () => {
    const problems = findUnmappedDocuments([file(spec, "# Role")]);
    expect(problems).toHaveLength(1);
    expect(problems[0].path).toBe(CORPUS_MAP);
  });
});

describe("findUnmarkedEntries", () => {
  const inventory = (...rows) => [
    file(
      CORPUS_MAP,
      [
        "| File | Domain |",
        "| --- | --- |",
        `| [Role](../spec/role.md) | Platform |`,
        ...rows,
      ].join("\n"),
    ),
  ];

  it("reports a row that neither links a document nor declares it withheld, because absence cannot say which it is", () => {
    const problems = findUnmarkedEntries(inventory("| sổ thị trường | SỐNG |"));
    expect(problems).toHaveLength(1);
    expect(problems[0].why).toContain("sổ thị trường");
  });

  it("accepts the same row once it carries the marker", () => {
    expect(findUnmarkedEntries(inventory(`| sổ thị trường ${WITHHELD_MARKER} | SỐNG |`))).toEqual(
      [],
    );
  });

  it("accepts a row that links into the tree, which needs no marker", () => {
    expect(findUnmarkedEntries(inventory("| [Task](../spec/task.md) | Platform |"))).toEqual([]);
  });

  it("leaves a table whose first column links nothing alone — the publishing policy and the gap ledger name categories, not files", () => {
    const map = file(
      CORPUS_MAP,
      ["| Tài liệu | Public? |", "| --- | --- |", "| Web charter | ❌ |"].join("\n"),
    );
    expect(findUnmarkedEntries([map])).toEqual([]);
  });

  it("leaves the header and the separator alone rather than reporting them as unmarked documents", () => {
    expect(findUnmarkedEntries(inventory())).toEqual([]);
  });

  it("stays silent when the map is absent, since that is the routing rule's finding and not a second one", () => {
    expect(findUnmarkedEntries([file("shared/libs/doctrine/spec/role.md", "# Role")])).toEqual([]);
  });
});
