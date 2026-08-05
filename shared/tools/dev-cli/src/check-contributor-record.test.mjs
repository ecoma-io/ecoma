import { describe, expect, it, vi } from "vitest";

import {
  allowlist,
  assentSentence,
  attributionClause,
  auditSignatures,
  authorVerdict,
  automationClause,
  claVersion,
  commitsOwedSignOff,
  licensorHandles,
  listedInContributors,
  projectAutomation,
  signaturesPath,
  signOffClause,
  templateVersionFault,
  unsignedCommits,
} from "./check-contributor-record.mjs";

const CLA_TEXT = `# Ecoma Contributor License Agreement

**Version 1.0, effective 2026-07-30.**

Commits made by automated tooling we run — dependency-update bots and the like
— are made on our own behalf and are not contributions under this agreement.

You agree that naming you in [\`CONTRIBUTORS.md\`](./CONTRIBUTORS.md), and
preserving your authorship in the commit history, is a sufficient way of
naming you as an author.

Separately, sign off each commit. The \`Signed-off-by\` trailer carries its
ordinary industry meaning.

## How you agree

You agree once, by posting this line as a comment on your first pull request:

\`\`\`
I have read the Ecoma Contributor License Agreement, version 1.0, at CLA.md,
and I agree to it for this and every future contribution I make to this project.
\`\`\`

Sign each commit off.
`;

const SENTENCE = assentSentence(CLA_TEXT);
const VERSION = claVersion(CLA_TEXT);

const WORKFLOW = `name: CLA
jobs:
  cla:
    steps:
      - uses: contributor-assistant/github-action@abc123
        with:
          path-to-signatures: "signatures/version1/cla.json"
          branch: "main"
`;

/** One signatures file as the CLA action writes it. */
const signatures = (...entries) => JSON.stringify({ signedContributors: entries });
const SIGNED = { name: "CasedUser", created_at: "2026-08-04T09:15:00Z" };

describe("reading the agreement rather than restating it", () => {
  it("takes the version from the document, so publishing a version moves the gate with it", () => {
    expect(VERSION).toBe("1.0");
    expect(claVersion(CLA_TEXT.replace("Version 1.0,", "Version 2.0,"))).toBe("2.0");
  });

  it("joins the wrapped assent into one sentence, since a comment is compared as one line", () => {
    expect(SENTENCE).toBe(
      "I have read the Ecoma Contributor License Agreement, version 1.0, at CLA.md, and I agree to it for this and every future contribution I make to this project.",
    );
  });

  it("refuses a document with no version rather than guessing one", () => {
    expect(() => claVersion("# CLA\n\nno version line\n")).toThrow(/version/);
  });

  it("refuses a document whose acceptance section fences no sentence", () => {
    expect(() => assentSentence("# CLA\n\n## How you agree\n\nJust ask us.\n")).toThrow(/sentence/);
  });

  it("refuses an empty fence, which would let any comment at all count as assent", () => {
    expect(() => assentSentence("# CLA\n\n## How you agree\n\n```\n \n```\n")).toThrow(/empty/);
  });
});

describe("where the signatures are written", () => {
  it("reads the path off the workflow input that writes it, so the two cannot point apart", () => {
    expect(signaturesPath(WORKFLOW)).toBe("signatures/version1/cla.json");
  });

  it("accepts the input unquoted, since YAML does not require quoting it", () => {
    expect(signaturesPath("          path-to-signatures: signatures/version1/cla.json\n")).toBe(
      "signatures/version1/cla.json",
    );
  });

  it("normalizes a leading './', which names the same file and would miss the lookup", () => {
    expect(signaturesPath('  path-to-signatures: "./sigs/cla.json"\n')).toBe("sigs/cla.json");
  });

  it("refuses a workflow that records nothing rather than reporting green", () => {
    // A gate that stayed silent here would certify an acceptance mechanism
    // that is not installed — every pull request passing because nothing
    // writes a signature at all.
    expect(() => signaturesPath("name: CLA\njobs: {}\n")).toThrow(/path-to-signatures/);
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

describe("what the workflow is told to exempt", () => {
  const automation = {
    "renovate[bot]": { config: ".github/renovate.json5", gitAuthor: "renovate[bot]" },
  };

  it("hands the action the same two exempt sets the required check applies", () => {
    // The action's own status and CI's required check must not disagree about
    // who is exempt, which is why the workflow reads this instead of writing a
    // second answer.
    expect(allowlist(["owner"], automation)).toBe("owner,renovate[bot]");
  });

  it("exempts nobody extra when the tree runs no automation", () => {
    expect(allowlist(["owner"], {})).toBe("owner");
  });
});

describe("the agreement agreeing with its own version line", () => {
  it("accepts an assent sentence that names the declared version", () => {
    expect(templateVersionFault(SENTENCE, VERSION)).toBeNull();
  });

  it("accepts a wording that cases or punctuates the token differently", () => {
    expect(templateVersionFault("assent to Version 1.0 of this CLA", "1.0")).toBeNull();
  });

  it("faults the document when the two version spots drift apart", () => {
    expect(templateVersionFault(SENTENCE, "2.0")).toMatch(/drifted apart/);
  });

  it("never reads a longer version as naming its prefix", () => {
    expect(templateVersionFault("version 1.0.1, at CLA.md", "1.0")).toMatch(/drifted apart/);
  });
});

describe("auditing the file the CLA action writes", () => {
  const PATH = "signatures/version1/cla.json";

  it("reports every signatory the file names, which is what the gate asks about", () => {
    const second = { name: "Someone", created_at: "2026-08-05T10:00:00Z" };
    expect(auditSignatures(signatures(SIGNED, second), PATH)).toEqual({
      logins: ["CasedUser", "Someone"],
      faults: [],
    });
  });

  it("faults a file that is not JSON, keeping the parser's own reason", () => {
    const { logins, faults } = auditSignatures("{ truncated", PATH);
    expect(logins).toEqual([]);
    expect(faults[0]).toContain(PATH);
  });

  it("faults a shape carrying no signatory array, which evidences no grant at all", () => {
    // The failure that matters is silent: an entry that names nobody still
    // counts as "the file exists", and this is the only writing behind every
    // grant the project holds.
    expect(auditSignatures(JSON.stringify({ somethingElse: [] }), PATH).faults[0]).toMatch(
      /signedContributors/,
    );
  });

  it("refuses an entry naming no account, and never counts it as a signatory", () => {
    const { logins, faults } = auditSignatures(signatures({ created_at: "2026-08-04" }), PATH);
    expect(logins).toEqual([]);
    expect(faults[0]).toMatch(/identifies nobody/);
  });

  it("faults a signature with no date, since nothing then places it against a version", () => {
    const { logins, faults } = auditSignatures(signatures({ name: "Someone" }), PATH);
    expect(faults[0]).toMatch(/no created_at/);
    // Still a named account: the fault is the missing date, and dropping the
    // login would additionally fail the author who did sign.
    expect(logins).toEqual(["Someone"]);
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

describe("the sign-off requirement", () => {
  it("reads the requirement out of the agreement", () => {
    expect(signOffClause(CLA_TEXT)).toBe("Separately, sign off each commit.");
  });

  it("reports no requirement once the agreement stops making one", () => {
    expect(signOffClause(CLA_TEXT.replace("Separately, sign off each commit.", ""))).toBeNull();
  });

  /** One `git log --format=%H%x1f%s%x1f%an%x1f%b%x00` record. */
  const entry = (sha, subject, author, body) =>
    `${sha}\u001f${subject}\u001f${author}\u001f${body}\u0000`;

  it("names the commits carrying no trailer and passes over the ones that do", () => {
    const log =
      entry("aaaa1111", "fix: one", "A Person", "body\n\nSigned-off-by: A Person <a@e.com>\n") +
      entry("bbbb2222", "fix: two", "A Person", "no trailer here\n") +
      entry("cccc3333", "fix: three", "A Person", "signed-off-by: lower <l@e.com>\n");
    expect(unsignedCommits("base..HEAD", () => log)).toEqual([
      { sha: "bbbb2222", subject: "fix: two", author: "A Person" },
    ]);
  });

  it("rejects a trailer with nothing after it, which certifies nobody", () => {
    const log = entry("dddd4444", "fix: four", "A Person", "Signed-off-by:\n");
    expect(unsignedCommits("base..HEAD", () => log)).toEqual([
      { sha: "dddd4444", subject: "fix: four", author: "A Person" },
    ]);
  });

  it("reports each commit's author, which is what lets a caller exempt per commit", () => {
    const log =
      entry("eeee5555", "chore: bump", "renovate[bot]", "no trailer\n") +
      entry("ffff6666", "fix: mine", "A Person", "no trailer\n");
    expect(unsignedCommits("base..HEAD", () => log).map((c) => c.author)).toEqual([
      "renovate[bot]",
      "A Person",
    ]);
  });

  it("asks git for non-merge commits only, since nobody authors a merge", () => {
    const exec = vi.fn(() => "");
    unsignedCommits("base..HEAD", exec);
    expect(exec.mock.calls[0][1]).toEqual(expect.arrayContaining(["--no-merges", "base..HEAD"]));
  });

  it("drops only the commits the exempt account authored, keeping a person's on its branch", () => {
    const unsigned = [
      { sha: "a", subject: "chore: bump", author: "renovate[bot]" },
      { sha: "b", subject: "feat: mine", author: "A Person" },
    ];
    expect(commitsOwedSignOff(unsigned, "renovate[bot]")).toEqual([unsigned[1]]);
  });

  it("exempts nothing when no account is exempt", () => {
    const unsigned = [{ sha: "a", subject: "chore: bump", author: "renovate[bot]" }];
    expect(commitsOwedSignOff(unsigned, null)).toEqual(unsigned);
  });

  it("keys on the declared git author name, never the login — the two are different namespaces", () => {
    // The GitHub Actions bot commits as "GitHub Actions" under the login
    // `github-actions[bot]`; matching the login would exempt nothing of its.
    const unsigned = [{ sha: "a", subject: "chore: sync", author: "GitHub Actions" }];
    expect(commitsOwedSignOff(unsigned, "github-actions[bot]")).toEqual(unsigned);
    expect(commitsOwedSignOff(unsigned, "GitHub Actions")).toEqual([]);
  });

  it("reports an unreadable range loudly, keeping the git error as the cause", () => {
    expect(() =>
      unsignedCommits("nope..HEAD", () => {
        throw new Error("unknown revision");
      }),
    ).toThrow(/could not read the commits in 'nope\.\.HEAD'/);
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
      "renovate[bot]": { config: ".github/renovate.json5", gitAuthor: "renovate[bot]" },
    });
    expect(projectAutomation(() => false)).toEqual({});
  });
});

describe("what a pull request author owes", () => {
  const CLAUSE = automationClause(CLA_TEXT);
  const base = {
    licensors: ["owner"],
    clause: CLAUSE,
    automation: {
      "renovate[bot]": { config: ".github/renovate.json5", gitAuthor: "renovate[bot]" },
    },
    hasSigned: false,
    sentence: SENTENCE,
  };

  it("asks nothing of a licensor, who cannot grant a licence to themselves", () => {
    expect(authorVerdict("Owner", base)).toEqual({ ok: true });
  });

  it("asks nothing further of a contributor whose signature the file names", () => {
    expect(authorVerdict("someone", { ...base, hasSigned: true })).toEqual({ ok: true });
  });

  it("quotes the login and the sentence to post, so the fault is self-service", () => {
    const verdict = authorVerdict("someone", base);
    expect(verdict.ok).toBe(false);
    // The single-quoted login is what `cla-notice` keys on to decide whether a
    // repository-wide red is this author's to fix.
    expect(verdict.fault).toContain("'someone'");
    expect(verdict.fault).toContain(SENTENCE);
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
    expect(verdict.fault).toContain("needs their own signature");
  });

  it("stops exempting automation once the agreement stops exempting it", () => {
    const verdict = authorVerdict("renovate[bot]", { ...base, type: "Bot", clause: null });
    expect(verdict.ok).toBe(false);
    expect(verdict.fault).toContain("no longer places commits");
  });

  it("treats an author of unknown kind as a person, so an unasked question fails closed", () => {
    const verdict = authorVerdict("renovate[bot]", base);
    expect(verdict.ok).toBe(false);
    expect(verdict.fault).toContain("'renovate[bot]'");
  });
});
