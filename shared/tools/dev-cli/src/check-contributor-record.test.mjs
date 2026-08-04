import { describe, expect, it } from "vitest";

import {
  attributionClause,
  auditRecord,
  auditRecordAcrossVersions,
  authorVerdict,
  automationClause,
  claTextHistory,
  claVersion,
  licensorHandles,
  listedInContributors,
  projectAutomation,
  recordFileFor,
  recordTemplate,
  templateVersionFault,
} from "./check-contributor-record.mjs";

const CLA_TEXT = `# Ecoma Contributor License Agreement

**Version 1.0, effective 2026-07-30.**

Commits made by automated tooling we run — dependency-update bots and the like
— are made on our own behalf and are not contributions under this agreement.

You agree that naming you in [\`CONTRIBUTORS.md\`](./CONTRIBUTORS.md), and
preserving your authorship in the commit history, is a sufficient way of
naming you as an author.

## How you agree

You agree once, by committing a record at \`contributors/<handle>.md\` containing:

\`\`\`
Full legal name:
Address:
GitHub:

I agree to the Ecoma Contributor License Agreement, version 1.0, at CLA.md,
for this and every future contribution I make to this project.
\`\`\`

Sign that commit off.
`;

const TEMPLATE = recordTemplate(CLA_TEXT);
const VERSION = claVersion(CLA_TEXT);

const GOOD = `Full legal name: A Contributor
Address: 1 Some Street, Somewhere
GitHub: someone

I agree to the Ecoma Contributor License Agreement, version 1.0, at CLA.md, for this and every future contribution I make to this project.
`;

describe("reading the agreement rather than restating it", () => {
  it("takes the version from the document, so a new version moves the gate with it", () => {
    expect(VERSION).toBe("1.0");
    expect(claVersion(CLA_TEXT.replace("Version 1.0,", "Version 2.0,"))).toBe("2.0");
  });

  it("takes the required fields from the published template", () => {
    expect(TEMPLATE.fields).toEqual(["Full legal name", "Address", "GitHub"]);
  });

  it("joins the wrapped assent into one sentence, since a record need not wrap it the same way", () => {
    expect(TEMPLATE.sentence).toBe(
      "I agree to the Ecoma Contributor License Agreement, version 1.0, at CLA.md, for this and every future contribution I make to this project.",
    );
  });

  it("refuses a document with no version rather than guessing one", () => {
    expect(() => claVersion("# CLA\n\nno version line\n")).toThrow(/version/);
  });

  it("refuses a document whose acceptance section carries no template", () => {
    expect(() => recordTemplate("# CLA\n\n## How you agree\n\nJust ask us.\n")).toThrow(/template/);
  });
});

describe("the licensor exemption", () => {
  const codeowners = `# a comment mentioning /CLA.md that is not an entry
/LICENSE     @owner
/CLA.md      @owner @second
`;

  it("derives who may not need to agree from who may change the agreement", () => {
    expect(licensorHandles(codeowners)).toEqual(["owner", "second"]);
  });

  it("takes the last matching entry, which is the one CODEOWNERS itself enforces", () => {
    expect(licensorHandles(`${codeowners}/CLA.md @latest\n`)).toEqual(["latest"]);
  });

  it("refuses when CODEOWNERS protects no CLA, rather than exempting nobody silently", () => {
    expect(() => licensorHandles("/LICENSE @owner\n")).toThrow(/CLA/);
  });
});

describe("the template agreeing with its own version line", () => {
  it("accepts a template whose assent sentence names the declared version", () => {
    expect(templateVersionFault(TEMPLATE, VERSION)).toBeNull();
  });

  it("accepts a wording that cases or punctuates the token differently", () => {
    expect(
      templateVersionFault({ sentence: "assent to Version 1.0 of this CLA" }, "1.0"),
    ).toBeNull();
  });

  it("faults the document when the two version spots drift apart", () => {
    expect(templateVersionFault(TEMPLATE, "2.0")).toMatch(/drifted apart/);
  });

  it("never reads a longer version as naming its prefix", () => {
    expect(templateVersionFault({ sentence: "version 1.0.1, at CLA.md" }, "1.0")).toMatch(
      /drifted apart/,
    );
  });
});

describe("records agreed under a superseded published version", () => {
  const NEWER = CLA_TEXT.replace(/version 1\.0/g, "version 2.0").replace(
    "Version 1.0,",
    "Version 2.0,",
  );
  const newerTemplate = recordTemplate(NEWER);
  const newerVersion = claVersion(NEWER);

  it("passes a record quoting the assent of a version git history shows was published", () => {
    expect(
      auditRecordAcrossVersions(GOOD, newerTemplate, newerVersion, () => [NEWER, CLA_TEXT]),
    ).toEqual({ faults: [], supersededVersion: "1.0" });
  });

  it("still fails a record citing a version that was never published", () => {
    const { faults } = auditRecordAcrossVersions(
      GOOD.replace(/version 1\.0/g, "version 0.9"),
      newerTemplate,
      newerVersion,
      () => [NEWER, CLA_TEXT],
    );
    expect(faults).not.toEqual([]);
  });

  it("skips history entries that predate the version line or the template", () => {
    const { faults } = auditRecordAcrossVersions(GOOD, newerTemplate, newerVersion, () => [
      "# CLA\n\nan early draft with neither\n",
      CLA_TEXT,
    ]);
    expect(faults).toEqual([]);
  });

  it("never consults history while a record matches the current template", () => {
    const result = auditRecordAcrossVersions(GOOD, TEMPLATE, VERSION, () => {
      throw new Error("history should not be read");
    });
    expect(result).toEqual({ faults: [] });
  });
});

describe("reading the published versions out of git history", () => {
  it("returns each committed text, skipping commits where the file was absent", () => {
    const exec = (cmd, cmdArgs) => {
      if (cmdArgs[0] === "log") return "sha1\nsha2\nsha3\n";
      if (cmdArgs[1] === "sha2:CLA.md") throw new Error("deleted here");
      return `text of ${cmdArgs[1]}`;
    };
    expect(claTextHistory(exec)).toEqual(["text of sha1:CLA.md", "text of sha3:CLA.md"]);
  });

  it("yields nothing when history is unreadable, leaving only the working tree to judge", () => {
    expect(
      claTextHistory(() => {
        throw new Error("not a repository");
      }),
    ).toEqual([]);
  });
});

describe("the attribution promise", () => {
  it("reads the naming consent out of the agreement", () => {
    expect(attributionClause(CLA_TEXT)).toBe("naming you in [`CONTRIBUTORS.md");
  });

  it("survives the link being relabelled or unformatted, since the promise did", () => {
    const plain = CLA_TEXT.replace("[`CONTRIBUTORS.md`](./CONTRIBUTORS.md)", "CONTRIBUTORS.md");
    expect(attributionClause(plain)).toBe("naming you in CONTRIBUTORS.md");
  });

  it("reports no promise once the agreement stops making one", () => {
    expect(attributionClause(CLA_TEXT.replace(/naming you in[^,]*,/, ""))).toBeNull();
  });

  const roster = `| Name | GitHub | Since |
| ---- | ------ | ----- |
| Some One | [@Someone](https://github.com/Someone) | 2026-08 |
`;

  it("finds a handle however the roster cases it", () => {
    expect(listedInContributors("someone", roster)).toBe(true);
    expect(listedInContributors("SOMEONE", roster)).toBe(true);
  });

  it("never accepts a prefix of a longer handle as a listing", () => {
    expect(listedInContributors("some", roster)).toBe(false);
    expect(listedInContributors("someone-else", roster)).toBe(false);
  });
});

describe("finding a record file for a login", () => {
  it("matches however the file or the login is cased, since GitHub logins are case-insensitive", () => {
    expect(recordFileFor("JohnDoe", ["johndoe.md"])).toBe("johndoe.md");
    expect(recordFileFor("johndoe", ["JohnDoe.md"])).toBe("JohnDoe.md");
  });

  it("reports no record rather than a near miss", () => {
    expect(recordFileFor("johndoe", ["johndoe2.md", "README.md"])).toBeNull();
  });
});

describe("the automation exemption", () => {
  const CLAUSE = automationClause(CLA_TEXT);

  it("reads the exemption out of the agreement, joined across the wrap", () => {
    expect(CLAUSE).toBe(
      "Commits made by automated tooling we run — dependency-update bots and the like — are made on our own behalf and are not contributions under this agreement.",
    );
  });

  it("reports no exemption once the agreement stops declaring one", () => {
    expect(automationClause(CLA_TEXT.replace(/Commits made by[\s\S]*?agreement\./, ""))).toBeNull();
  });

  it("exempts an account only while the configuration that runs it is committed", () => {
    expect(projectAutomation((path) => path === ".github/renovate.json5")).toEqual({
      "renovate[bot]": ".github/renovate.json5",
    });
    expect(projectAutomation(() => false)).toEqual({});
  });
});

describe("what a pull request author owes", () => {
  const CLAUSE = automationClause(CLA_TEXT);
  const base = {
    licensors: ["owner"],
    clause: CLAUSE,
    automation: { "renovate[bot]": ".github/renovate.json5" },
    hasRecord: false,
  };

  it("asks nothing of a licensor, who cannot grant a licence to themselves", () => {
    expect(authorVerdict("Owner", base)).toEqual({ ok: true });
  });

  it("asks nothing further of a contributor whose record exists", () => {
    expect(authorVerdict("someone", { ...base, hasRecord: true })).toEqual({ ok: true });
  });

  it("names the record a contributor still owes", () => {
    const verdict = authorVerdict("someone", base);
    expect(verdict.ok).toBe(false);
    expect(verdict.fault).toContain("contributors/someone.md");
  });

  it("lets through automation the project runs, saying which config makes it ours", () => {
    const verdict = authorVerdict("renovate[bot]", { ...base, type: "Bot" });
    expect(verdict.ok).toBe(true);
    expect(verdict.note).toContain(".github/renovate.json5");
    expect(verdict.note).toContain(CLAUSE);
  });

  it("refuses a machine account the project does not run, since a coding agent works for a person", () => {
    const verdict = authorVerdict("some-agent[bot]", { ...base, type: "Bot" });
    expect(verdict.ok).toBe(false);
    expect(verdict.fault).toContain("does not run");
    expect(verdict.fault).toContain("needs their own record");
  });

  it("stops exempting automation once the agreement stops exempting it", () => {
    const verdict = authorVerdict("renovate[bot]", { ...base, type: "Bot", clause: null });
    expect(verdict.ok).toBe(false);
    expect(verdict.fault).toContain("no longer places commits");
  });

  it("treats an author of unknown kind as a person, so an unasked question fails closed", () => {
    const verdict = authorVerdict("renovate[bot]", base);
    expect(verdict.ok).toBe(false);
    expect(verdict.fault).toContain("contributors/renovate[bot].md");
  });
});

describe("auditing a record", () => {
  it("passes a record carrying every field and the verbatim assent", () => {
    expect(auditRecord(GOOD, TEMPLATE, VERSION)).toEqual([]);
  });

  it("names a field the record left out", () => {
    expect(auditRecord(GOOD.replace(/^Address:.*$/m, ""), TEMPLATE, VERSION)).toEqual([
      "missing the 'Address:' line the CLA's record template requires",
    ]);
  });

  it("rejects a field present but blank, which reads as answered and is not", () => {
    expect(
      auditRecord(GOOD.replace("Address: 1 Some Street, Somewhere", "Address:"), TEMPLATE, VERSION),
    ).toEqual(["'Address:' is blank"]);
  });

  it("accepts an assent the contributor wrapped differently, since wrapping is not the agreement", () => {
    const wrapped = GOOD.replace(
      "version 1.0, at CLA.md, for this",
      "version 1.0, at CLA.md,\nfor this",
    );
    expect(auditRecord(wrapped, TEMPLATE, VERSION)).toEqual([]);
  });

  it("rejects assent to a different version, which is agreement to another document", () => {
    const stale = GOOD.replace("version 1.0", "version 0.9");
    expect(auditRecord(stale, TEMPLATE, VERSION)).toEqual([
      "the agreement sentence does not match CLA.md version 1.0 verbatim",
    ]);
  });

  it("reports a record with the fields and no assent as unsigned, not as merely malformed", () => {
    const fieldsOnly = GOOD.split("\n").slice(0, 3).join("\n");
    expect(auditRecord(fieldsOnly, TEMPLATE, VERSION)).toEqual(["carries no agreement sentence"]);
  });
});
