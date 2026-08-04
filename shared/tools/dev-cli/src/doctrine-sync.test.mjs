import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { doctrineSync, recordCanonicalSha } from "./doctrine-sync.mjs";

// Computed here from the algorithm rather than imported from the gate: the
// point of this command is that the value it writes is the value the gate
// reads, and asserting against the gate's own helper would pass even if both
// sides drifted to the same wrong thing.
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

const CANONICAL = "---\ntitle: Role\n---\n\n# Role\n\nA Role is a unit of labour.\n";

/** A variant carrying `recorded`, or none when it is omitted. */
const variant = (recorded) =>
  `---\ntitle: Vai\n${recorded === undefined ? "" : `canonical-sha: ${recorded}\n`}---\n\n# Vai\n`;

describe("recordCanonicalSha", () => {
  it("overwrites the recorded fingerprint with the one it was given", () => {
    expect(recordCanonicalSha(variant("aaaaaaaaaaaa"), "bbbbbbbbbbbb")).toContain(
      "canonical-sha: bbbbbbbbbbbb",
    );
  });

  it("adds the key to a variant that carries none, keeping the frontmatter it already had", () => {
    const next = recordCanonicalSha(variant(), "bbbbbbbbbbbb");
    expect(next).toContain("title: Vai");
    expect(next).toContain("canonical-sha: bbbbbbbbbbbb");
  });

  it("returns the text unchanged when the recorded value is already the right one, so a caller reports only real writes", () => {
    const text = variant("bbbbbbbbbbbb");
    expect(recordCanonicalSha(text, "bbbbbbbbbbbb")).toBe(text);
  });

  it("refuses a document with no frontmatter block rather than inventing one", () => {
    expect(recordCanonicalSha("# Vai\n\nnội dung", "bbbbbbbbbbbb")).toBeNull();
  });

  it("replaces a malformed fingerprint instead of appending a second key beside it", () => {
    const next = recordCanonicalSha(variant("not-a-sha"), "bbbbbbbbbbbb");
    expect(next.match(/canonical-sha:/g)).toHaveLength(1);
    expect(next).not.toContain("not-a-sha");
  });

  it("leaves a canonical-sha line quoted in the body alone, since prose explaining the rule is not the header", () => {
    const text = `${variant("aaaaaaaaaaaa")}\nRecord \`canonical-sha: cccccccccccc\` in the frontmatter.\n`;
    expect(recordCanonicalSha(text, "bbbbbbbbbbbb")).toContain("canonical-sha: cccccccccccc");
  });

  it("records exactly one key when the frontmatter already carries the line, so repeated runs do not accumulate", () => {
    const once = recordCanonicalSha(variant("aaaaaaaaaaaa"), "bbbbbbbbbbbb");
    const twice = recordCanonicalSha(once, "bbbbbbbbbbbb");
    expect(twice.match(/canonical-sha:/g)).toHaveLength(1);
  });
});

describe("doctrineSync", () => {
  /** Injectable deps over an in-memory tree, plus the writes it received. */
  const harness = (tree, { log = () => {}, error = () => {} } = {}) => {
    const writes = {};
    const deps = {
      list: vi.fn(() => Object.keys(tree)),
      read: (path) => {
        if (!(path in tree)) throw new Error(`ENOENT: ${path}`);
        return tree[path];
      },
      write: (path, text) => {
        writes[path] = text;
      },
      log,
      error,
    };
    return { deps, writes };
  };

  it("records the sha256 prefix of the canonical's whole content, which is what the gate compares against", () => {
    const tree = {
      "shared/libs/doctrine/spec/role.md": CANONICAL,
      "shared/libs/doctrine/spec/role.vi.md": variant("aaaaaaaaaaaa"),
    };
    const { deps, writes } = harness(tree);

    expect(doctrineSync([], deps)).toBe(0);
    expect(writes["shared/libs/doctrine/spec/role.vi.md"]).toContain(
      `canonical-sha: ${sha(CANONICAL)}`,
    );
  });

  it("never writes to the canonical itself, which owns no fingerprint", () => {
    const tree = {
      "shared/libs/doctrine/spec/role.md": CANONICAL,
      "shared/libs/doctrine/spec/role.vi.md": variant("aaaaaaaaaaaa"),
    };
    const { deps, writes } = harness(tree);

    doctrineSync([], deps);
    expect(Object.keys(writes)).toEqual(["shared/libs/doctrine/spec/role.vi.md"]);
  });

  it("stamps every variant of the same canonical in one pass, so a triad cannot be left half-current", () => {
    const tree = {
      "shared/libs/doctrine/spec/role.md": CANONICAL,
      "shared/libs/doctrine/spec/role.vi.md": variant(),
      "shared/libs/doctrine/spec/role.zh.md": variant(),
    };
    const { deps, writes } = harness(tree);

    expect(doctrineSync([], deps)).toBe(0);
    expect(Object.keys(writes)).toHaveLength(2);
    for (const text of Object.values(writes)) {
      expect(text).toContain(`canonical-sha: ${sha(CANONICAL)}`);
    }
  });

  it("fails on a variant whose canonical is absent, rather than stamping a fingerprint of nothing", () => {
    const error = vi.fn();
    const { deps, writes } = harness(
      { "shared/libs/doctrine/spec/role.vi.md": variant("aaaaaaaaaaaa") },
      { error },
    );

    expect(doctrineSync([], deps)).toBe(1);
    expect(writes).toEqual({});
    expect(error.mock.calls[0][0]).toContain("no canonical");
  });

  it("fails on a variant with no frontmatter, and prints the value it could not record", () => {
    const error = vi.fn();
    const { deps } = harness(
      {
        "shared/libs/doctrine/spec/role.md": CANONICAL,
        "shared/libs/doctrine/spec/role.vi.md": "# Vai\n",
      },
      { error },
    );

    expect(doctrineSync([], deps)).toBe(1);
    expect(error.mock.calls[0][0]).toContain(sha(CANONICAL));
  });

  it("keeps going past a variant it cannot stamp, so one broken file does not hide the rest of the tree", () => {
    const { deps, writes } = harness({
      "shared/libs/doctrine/spec/role.md": CANONICAL,
      "shared/libs/doctrine/spec/role.vi.md": "# Vai\n",
      "shared/libs/doctrine/spec/task.md": CANONICAL,
      "shared/libs/doctrine/spec/task.vi.md": variant(),
    });

    expect(doctrineSync([], deps)).toBe(1);
    expect(writes["shared/libs/doctrine/spec/task.vi.md"]).toContain("canonical-sha:");
  });

  it("writes nothing when every variant already records its canonical", () => {
    const { deps, writes } = harness({
      "shared/libs/doctrine/spec/role.md": CANONICAL,
      "shared/libs/doctrine/spec/role.vi.md": variant(sha(CANONICAL)),
    });

    expect(doctrineSync([], deps)).toBe(0);
    expect(writes).toEqual({});
  });

  // Spelled out rather than imported from the gate: the literal is the whole
  // protection. It reaches the documents inside the tree's families and not the
  // project's own README triad at the root, whose three languages are peers
  // under a fixed-order frontmatter block that a `canonical-sha` key breaks. A
  // directory pathspec would sweep them in, and every assertion above — which
  // injects `list` — would stay green while it did.
  it("scans the documents inside the tree's families, leaving the project's own README triad at the root untouched", () => {
    const { deps } = harness({});
    doctrineSync([], deps);
    expect(deps.list).toHaveBeenCalledWith(["shared/libs/doctrine/*.md"]);
  });

  it("scans only the root it is given, so one family can be stamped without the tree", () => {
    const { deps } = harness({});
    doctrineSync(["shared/libs/doctrine/spec"], deps);
    expect(deps.list).toHaveBeenCalledWith(["shared/libs/doctrine/spec/*.md"]);
  });

  it("ignores a non-markdown file the pathspec swept in", () => {
    const { deps, writes } = harness({ "shared/libs/doctrine/project.json": "{}" });
    expect(doctrineSync([], deps)).toBe(0);
    expect(writes).toEqual({});
  });
});
