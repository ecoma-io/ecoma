import { describe, expect, it, vi } from "vitest";

// The roster logic is the unit; the signatures audit and the roster lookup it
// leans on are `check-contributor-record`'s and are pinned by that file's own
// tests. `listedInContributors` is stubbed with the contract it actually has —
// "does this text name this handle" — so a row this module decides not to add
// is this module's decision under test, not the regexp's.
vi.mock("./check-contributor-record.mjs", () => ({
  CONTRIBUTORS_FILE: "CONTRIBUTORS.md",
  auditSignatures: vi.fn(() => ({ logins: [], faults: [] })),
  listedInContributors: (handle, text) => text.toLowerCase().includes(handle.toLowerCase()),
}));

const { auditSignatures } = await import("./check-contributor-record.mjs");
const { parseTable, renderTable, rosterWithSignatories, signedMonth, syncContributors } =
  await import("./sync-contributors.mjs");

const ROSTER = `# Contributors

Everyone whose work is in Ecoma.

| Name     | GitHub                                 | Since   |
| -------- | -------------------------------------- | ------- |
| A Person | [@Someone](https://github.com/Someone) | 2026-08 |
`;

const signatures = (...entries) => JSON.stringify({ signedContributors: entries });

describe("the month a signature was made", () => {
  it("reads the roster's granularity off the timestamp the action recorded", () => {
    expect(signedMonth("2026-08-04T09:15:00Z")).toBe("2026-08");
  });

  it("reports nothing rather than a guess when the timestamp is unusable", () => {
    // A wrong date in an attribution table is worse than an absent row that a
    // red gate is already naming.
    expect(signedMonth("last Tuesday")).toBeNull();
    expect(signedMonth(undefined)).toBeNull();
  });
});

describe("finding the table in the roster", () => {
  it("locates it by its separator line, so prose may move around it", () => {
    const table = parseTable(ROSTER);
    expect(table.header).toEqual(["Name", "GitHub", "Since"]);
    expect(table.rows).toEqual([["A Person", "[@Someone](https://github.com/Someone)", "2026-08"]]);
    expect(table.before).toContain("# Contributors");
  });

  it("reports no table rather than inventing one, so the caller can fail loudly", () => {
    expect(parseTable("# Contributors\n\nnobody yet\n")).toBeNull();
  });
});

describe("rendering the table back", () => {
  it("pads every cell to the widest in its column, the way Prettier owns this file", () => {
    // Emitting an unpadded row would leave the tree one `nx format:write` away
    // from a diff nobody asked for.
    const [header, rule, row] = renderTable({
      header: ["Name", "GitHub"],
      separator: ["---", "---"],
      rows: [["A Much Longer Name", "@x"]],
    });
    expect(header).toBe("| Name               | GitHub |");
    expect(rule).toBe("| ------------------ | ------ |");
    expect(row).toBe("| A Much Longer Name | @x     |");
  });

  it("measures a decomposed name by what it renders as, not by its code units", () => {
    // A Vietnamese name written with combining marks would otherwise be padded
    // as if it were twice as long, and Prettier would rewrite the row.
    const rows = [["Hóa".normalize("NFD"), "@h"]];
    const [, , row] = renderTable({ header: ["Name", "GitHub"], separator: ["-", "-"], rows });
    expect(row.normalize("NFC")).toBe("| Hóa  | @h     |");
  });

  it("keeps the alignment colons a separator cell already carried", () => {
    const [, rule] = renderTable({
      header: ["Name", "Since"],
      separator: [":---", "---:"],
      rows: [],
    });
    expect(rule).toBe("| :--- | ----: |");
  });
});

describe("adding the rows the project owes its signatories", () => {
  const signatory = { name: "Newcomer", created_at: "2026-08-04T09:15:00Z" };

  it("appends a row for a signatory the roster does not name", () => {
    const { text, added } = rosterWithSignatories(ROSTER, [signatory]);
    expect(added).toEqual(["Newcomer"]);
    expect(text).toContain("[@Newcomer](https://github.com/Newcomer)");
    expect(text).toContain("2026-08");
  });

  it("leaves an existing row exactly as it is, including a name someone improved", () => {
    // The roster's name column is how a person chooses to be credited;
    // regenerating the file would repeatedly overwrite that with a handle.
    const { text, added } = rosterWithSignatories(ROSTER, [
      { name: "Someone", created_at: "2026-08-04T09:15:00Z" },
    ]);
    expect(added).toEqual([]);
    expect(text).toBe(ROSTER);
  });

  it("writes nothing on a second run, so the workflow may run it every time", () => {
    const once = rosterWithSignatories(ROSTER, [signatory]);
    expect(rosterWithSignatories(once.text, [signatory]).added).toEqual([]);
  });

  it("skips a signatory whose signature carries no usable date", () => {
    // `check-contributor-record` already fails that signature; crediting it
    // with an invented month would put a wrong date in an attribution table.
    expect(rosterWithSignatories(ROSTER, [{ name: "Undated" }]).added).toEqual([]);
  });

  it("refuses a roster with no table rather than appending into prose", () => {
    expect(() => rosterWithSignatories("# Contributors\n\nnobody yet\n", [signatory])).toThrow(
      /no contributor table/,
    );
  });
});

describe("the command over a tree", () => {
  const io = (files) => ({
    readFileSync: vi.fn((path) => {
      if (!(path in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[path];
    }),
    writeFileSync: vi.fn(),
  });

  it("refuses to guess where the signatures live, since the workflow names that path", () => {
    expect(syncContributors([], io({}))).toBe(2);
  });

  it("reports nothing to do when no contributor has signed yet", () => {
    const fs = io({});
    expect(syncContributors(["--signatures", "sigs.json"], fs)).toBe(0);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("refuses to write a roster from a signatures file that does not audit", () => {
    // A file the action could not have written evidences no grant, so crediting
    // whatever it happens to name would be attribution without a signature.
    auditSignatures.mockReturnValueOnce({ logins: [], faults: ["sigs.json: is not valid JSON"] });
    const fs = io({ "sigs.json": "{ truncated" });
    expect(syncContributors(["--signatures", "sigs.json"], fs)).toBe(1);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("writes the missing rows and names who was added", () => {
    const fs = io({
      "sigs.json": signatures({ name: "Newcomer", created_at: "2026-08-04T09:15:00Z" }),
      "CONTRIBUTORS.md": ROSTER,
    });
    expect(syncContributors(["--signatures", "sigs.json"], fs)).toBe(0);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "CONTRIBUTORS.md",
      expect.stringContaining("[@Newcomer](https://github.com/Newcomer)"),
    );
  });

  it("reports what is missing without writing under --check, for a caller that only asks", () => {
    const fs = io({
      "sigs.json": signatures({ name: "Newcomer", created_at: "2026-08-04T09:15:00Z" }),
      "CONTRIBUTORS.md": ROSTER,
    });
    expect(syncContributors(["--signatures", "sigs.json", "--check"], fs)).toBe(1);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("passes a roster that already names every signatory", () => {
    const fs = io({
      "sigs.json": signatures({ name: "Someone", created_at: "2026-08-04T09:15:00Z" }),
      "CONTRIBUTORS.md": ROSTER,
    });
    expect(syncContributors(["--signatures", "sigs.json"], fs)).toBe(0);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
