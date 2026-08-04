import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  auditRestatements,
  checkLegalVersions,
  declaredVersion,
  legalSources,
  restatementsIn,
} from "./check-legal-versions.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const CLA = { version: "1.1", effective: "2026-08-04" };
const CORPORATE = { version: "1.1", effective: "2026-08-04" };
const ENTERPRISE = { version: "2.0", effective: "2026-09-01" };
const SOURCES = {
  "CLA.md": CLA,
  "CORPORATE-CLA.md": CORPORATE,
  "ENTERPRISE-LICENSE.md": ENTERPRISE,
};

describe("declaredVersion", () => {
  it("reads both halves off the document's own declaration line", () => {
    expect(declaredVersion("# Title\n\n**Version 1.1, effective 2026-08-04.**\n")).toEqual({
      version: "1.1",
      effective: "2026-08-04",
    });
  });

  it("declares nothing when only one half is present, so half a source is never a source", () => {
    // A document that names a version but no date cannot answer what a
    // restatement's date claim should be. Accepting it would let the gate
    // report green on the half it could not judge.
    expect(declaredVersion("**Version 1.1.**")).toBeNull();
    expect(declaredVersion("**effective 2026-08-04.**")).toBeNull();
    expect(declaredVersion("Some prose mentioning version 1.1 in passing.")).toBeNull();
  });
});

describe("restatementsIn", () => {
  it("reads a version and a date that follow the document's filename as claims about it", () => {
    const text =
      "The Enterprise License (`ENTERPRISE-LICENSE.md`) is version 2.0, effective 2026-09-01.";
    expect(restatementsIn(text, Object.keys(SOURCES))).toEqual([
      { name: "ENTERPRISE-LICENSE.md", kind: "version", claimed: "2.0", line: 1 },
      { name: "ENTERPRISE-LICENSE.md", kind: "effective date", claimed: "2026-09-01", line: 1 },
    ]);
  });

  it("never reads a mention of CORPORATE-CLA.md as a mention of CLA.md", () => {
    // The whole reason mentions are boundary-guarded: `CORPORATE-CLA.md` ends
    // with the literal text `CLA.md`, so an unguarded scan would check the
    // corporate agreement's version against the personal agreement's document
    // and fail — or, worse, pass while judging the wrong pair.
    const claims = restatementsIn("`CORPORATE-CLA.md` is version 1.1.", Object.keys(SOURCES));
    expect(claims.map((c) => c.name)).toEqual(["CORPORATE-CLA.md"]);
  });

  it("stops a document's window at the next document, so adjacent bullets cannot lend versions", () => {
    // The shape CLA.md's "The other agreements" section is written in: one
    // bullet per document, each carrying its own pair. Without the boundary the
    // first bullet's window would reach the second bullet's numbers and read
    // them as a second claim about the first document.
    const text = [
      "- `CORPORATE-CLA.md` is in force — version 1.1, effective 2026-08-04.",
      "- `ENTERPRISE-LICENSE.md` is in force — version 2.0, effective 2026-09-01.",
    ].join("\n");
    expect(restatementsIn(text, Object.keys(SOURCES))).toEqual([
      { name: "CORPORATE-CLA.md", kind: "version", claimed: "1.1", line: 1 },
      { name: "CORPORATE-CLA.md", kind: "effective date", claimed: "2026-08-04", line: 1 },
      { name: "ENTERPRISE-LICENSE.md", kind: "version", claimed: "2.0", line: 2 },
      { name: "ENTERPRISE-LICENSE.md", kind: "effective date", claimed: "2026-09-01", line: 2 },
    ]);
  });

  it("reads the same claims out of Vietnamese prose, where the drift also lands", () => {
    const text = "`CORPORATE-CLA.md` phiên bản 1.1 ở gốc repo, hiệu lực từ 2026-08-04.";
    expect(restatementsIn(text, Object.keys(SOURCES))).toEqual([
      { name: "CORPORATE-CLA.md", kind: "version", claimed: "1.1", line: 1 },
      { name: "CORPORATE-CLA.md", kind: "effective date", claimed: "2026-08-04", line: 1 },
    ]);
  });

  it("leaves a version two paragraphs later alone, because prose has moved on", () => {
    const text = `\`CLA.md\` says what you grant.\n\n${"filler ".repeat(40)}\n\nversion 9.9`;
    expect(restatementsIn(text, Object.keys(SOURCES))).toEqual([]);
  });

  it("ignores a version that precedes the filename, which is a different sentence", () => {
    // The assent sentence reads "…Agreement, version 1.1, at CLA.md" — the
    // version is about the agreement the sentence already named, and
    // check-contributor-record is what holds that one to CLA.md's line. Reading
    // it here would double-judge it under a rule this gate cannot state.
    expect(restatementsIn("…Agreement, version 1.1, at CLA.md, for this", ["CLA.md"])).toEqual([]);
  });

  it("reports the line of the mention, so a wide table row points at the row", () => {
    const text = `intro\n\n| L5 | \`ENTERPRISE-LICENSE.md\`, version 2.0 |`;
    expect(restatementsIn(text, Object.keys(SOURCES))[0].line).toBe(3);
  });
});

describe("auditRestatements", () => {
  it("faults a version that disagrees with the document, naming both numbers", () => {
    const [fault] = auditRestatements("`ENTERPRISE-LICENSE.md`, version 1.0", SOURCES);
    expect(fault).toContain("says ENTERPRISE-LICENSE.md is at version 1.0");
    expect(fault).toContain("declares 2.0");
  });

  it("faults an effective date that disagrees even when the version agrees", () => {
    // The two halves drift independently: the doctrine rows that prompted this
    // gate were wrong about both, but a version bump that forgets the date is
    // the likelier future mistake.
    const faults = auditRestatements("`CLA.md` version 1.1, effective 2026-07-31", SOURCES);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("effective date 2026-07-31");
  });

  it("passes a restatement that agrees with the document", () => {
    expect(auditRestatements("`CLA.md` version 1.1, effective 2026-08-04", SOURCES)).toEqual([]);
  });

  it("passes a bare mention that claims nothing, so citing a document stays free", () => {
    expect(auditRestatements("Read [`CLA.md`](./CLA.md) before contributing.", SOURCES)).toEqual(
      [],
    );
  });
});

describe("legalSources", () => {
  const texts = {
    "CLA.md": "**Version 1.1, effective 2026-08-04.**",
    "README.md": "Ecoma is fair-code.",
    "shared/enterprise/ENTERPRISE-LICENSE.md": "**Version 2.0, effective 2026-09-01.**",
    "ENTERPRISE-LICENSE.md": "**Version 2.0, effective 2026-09-01.**",
  };
  const read = (f) => texts[f];

  it("takes every declaring file as a source, so a fourth legal text needs no edit here", () => {
    const { sources } = legalSources(["CLA.md", "README.md"], read);
    expect(Object.keys(sources)).toEqual(["CLA.md"]);
    expect(sources["CLA.md"]).toMatchObject({ version: "1.1", effective: "2026-08-04" });
  });

  it("refuses two declaring files with one basename instead of shadowing one", () => {
    // ENTERPRISE-LICENSE.md is a document that gets copied into the directory
    // it governs. Once two copies exist, a prose mention of the filename cannot
    // say which it means — and silently judging against whichever was listed
    // first would let the copy drift unnoticed, which is the exact defect this
    // gate exists for.
    const { collisions } = legalSources(
      ["ENTERPRISE-LICENSE.md", "shared/enterprise/ENTERPRISE-LICENSE.md"],
      read,
    );
    expect(collisions).toEqual([
      {
        name: "ENTERPRISE-LICENSE.md",
        files: ["ENTERPRISE-LICENSE.md", "shared/enterprise/ENTERPRISE-LICENSE.md"],
      },
    ]);
  });

  it("skips a listed file it cannot read rather than crashing the gate", () => {
    const { sources } = legalSources(["gone.md"], () => {
      throw new Error("ENOENT");
    });
    expect(sources).toEqual({});
  });
});

describe("checkLegalVersions", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Writes `files` into a throwaway dir and makes `git ls-files` report them. */
  function tree(files) {
    const dir = mkdtempSync(join(tmpdir(), "check-legal-versions-"));
    const paths = Object.entries(files).map(([name, text]) => {
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    });
    vi.mocked(execFileSync).mockReturnValue(`${paths.join("\n")}\n`);
    return dir;
  }

  it("fails on a doctrine row left a version and a date behind its document", () => {
    tree({
      "CORPORATE-CLA.md": "**Version 1.1, effective 2026-08-04.**\n",
      "index.md": "| L10 | `CORPORATE-CLA.md` version 1.0, effective 2026-07-31 |\n",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(checkLegalVersions()).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("version 1.0"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("effective date 2026-07-31"));
  });

  it("passes once the restatement is moved onto the document's declaration", () => {
    tree({
      "CORPORATE-CLA.md": "**Version 1.1, effective 2026-08-04.**\n",
      "index.md": "| L10 | `CORPORATE-CLA.md` version 1.1, effective 2026-08-04 |\n",
    });
    expect(checkLegalVersions()).toBe(0);
  });

  it("fails loud when nothing declares a version, rather than reporting a green it did not earn", () => {
    // A gate whose source set is derived can be silently emptied — by deleting
    // a declaration line, or by rewording it past the pattern. Both leave every
    // restatement unjudged, and a green run would be the only symptom.
    tree({ "CLA.md": "# Ecoma Contributor License Agreement\n" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(checkLegalVersions()).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("judging nothing"));
  });

  it("names the documents it judged on a green run, so a narrowed source set is visible", () => {
    tree({ "CLA.md": "**Version 1.1, effective 2026-08-04.**\n" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(checkLegalVersions()).toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("CLA.md 1.1 (2026-08-04)"));
  });
});
