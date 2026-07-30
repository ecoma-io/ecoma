import { describe, expect, it } from "vitest";

import {
  auditRecord,
  claVersion,
  licensorHandles,
  recordTemplate,
} from "./check-contributor-record.mjs";

const CLA_TEXT = `# Ecoma Contributor License Agreement

**Version 1.0, effective 2026-07-30.**

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

  it("refuses when CODEOWNERS protects no CLA, rather than exempting nobody silently", () => {
    expect(() => licensorHandles("/LICENSE @owner\n")).toThrow(/CLA/);
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
