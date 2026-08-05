import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildClaNoticeComment,
  buildClaResolvedComment,
  CLA_NOTICE_MARKER,
  claNotice,
  runClaGate,
} from "./cla-notice.mjs";

// The default stderr is the shape `authorVerdict` actually emits for an author
// who has not signed: the login in single quotes, which is the only thing the
// attribution decision may key on.
const failingSpawn = (stderr = "'someone' has not agreed to CLA.md — it grants nothing until") =>
  vi.fn(() => ({ status: 1, stderr, stdout: "" }));
const passingSpawn = () => vi.fn(() => ({ status: 0, stderr: "", stdout: "" }));

/** A recording stub of the one client surface this command touches. */
function fakeThread(comments = []) {
  const calls = { created: [], updated: [] };
  return {
    calls,
    client: {
      listComments: async () => comments,
      createComment: async (number, body) => calls.created.push({ number, body }),
      updateComment: async (id, body) => calls.updated.push({ id, body }),
    },
  };
}

beforeEach(() => {
  process.env.GITHUB_REPOSITORY = "owner/repo";
  process.env.GITHUB_TOKEN = "t";
});
afterEach(() => {
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.GITHUB_TOKEN;
});

describe("what the gate is asked", () => {
  it("spawns the dev-cli gate with the author, and the type only when known", () => {
    const spawn = passingSpawn();
    runClaGate({ author: "someone", authorType: "User", spawn });
    expect(spawn.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        "check-contributor-record",
        "--author",
        "someone",
        "--author-type",
        "User",
      ]),
    );
    runClaGate({ author: "someone", spawn });
    expect(spawn.mock.calls[1][1]).not.toContain("--author-type");
  });

  it("forwards the commit range, so it judges the same thing the required gate does", () => {
    const spawn = passingSpawn();
    runClaGate({ author: "someone", commits: "base..head", spawn });
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(["--commits", "base..head"]));
    runClaGate({ author: "someone", spawn });
    expect(spawn.mock.calls[1][1]).not.toContain("--commits");
  });
});

describe("the notice body", () => {
  const body = buildClaNoticeComment({
    author: "someone",
    repo: "owner/repo",
    gateOutput: "'someone' has not agreed to CLA.md",
  });

  it("opens with its marker, which is what the next run's lookup anchors on", () => {
    expect(body.startsWith(CLA_NOTICE_MARKER)).toBe(true);
  });

  it("carries the gate's own words and absolute links a comment can resolve", () => {
    expect(body).toContain("'someone' has not agreed to CLA.md");
    expect(body).toContain("https://github.com/owner/repo/blob/HEAD/CLA.md");
    expect(body).toContain("@someone");
  });

  it("names the sign-off half itself and leaves the signing half to the CLA action", () => {
    // Two bots asking for the same thing in words that can disagree is the
    // failure this split exists to prevent: the action's own comment is the
    // only place the sentence to post is spelled out, because it reads that
    // sentence out of CLA.md at run time.
    expect(body).toContain("Signed-off-by");
    expect(body).toContain("git commit -s");
    expect(body).not.toMatch(/I have read the Ecoma Contributor License Agreement/);
  });

  it("truncates a runaway gate output loudly rather than posting it whole", () => {
    const long = buildClaNoticeComment({
      author: "a",
      repo: "o/r",
      gateOutput: "x".repeat(5000),
    });
    expect(long).toContain("… (truncated)");
    expect(long.length).toBeLessThan(5000);
  });

  it("keeps the resolved body under the same marker, so the flip edits in place", () => {
    expect(buildClaResolvedComment({ author: "someone" }).startsWith(CLA_NOTICE_MARKER)).toBe(true);
  });
});

describe("what a run does to the thread", () => {
  it("posts the notice when the gate fails and none exists, and still exits 0 — a messenger, not a second gate", async () => {
    const { calls, client } = fakeThread([{ id: 1, body: "unrelated" }]);
    const code = await claNotice(["--pr", "7", "--author", "someone"], {
      spawn: failingSpawn(),
      client,
    });
    expect(code).toBe(0);
    expect(calls.created).toHaveLength(1);
    expect(calls.created[0].number).toBe("7");
    expect(calls.created[0].body.startsWith(CLA_NOTICE_MARKER)).toBe(true);
    expect(calls.updated).toHaveLength(0);
  });

  it("edits its own comment in place on a re-run instead of stacking a second one", async () => {
    const { calls, client } = fakeThread([{ id: 5, body: `${CLA_NOTICE_MARKER}\nold` }]);
    const code = await claNotice(["--pr", "7", "--author", "someone"], {
      spawn: failingSpawn(),
      client,
    });
    expect(code).toBe(0);
    expect(calls.created).toHaveLength(0);
    expect(calls.updated).toEqual([{ id: 5, body: expect.stringContaining("action needed") }]);
  });

  it("flips an existing notice to resolved once the gate passes, and posts nothing on a thread that was never red", async () => {
    const red = fakeThread([{ id: 5, body: `${CLA_NOTICE_MARKER}\nold` }]);
    await claNotice(["--pr", "7", "--author", "someone"], {
      spawn: passingSpawn(),
      client: red.client,
    });
    expect(red.calls.updated).toEqual([{ id: 5, body: expect.stringContaining("resolved") }]);

    const clean = fakeThread([]);
    await claNotice(["--pr", "7", "--author", "someone"], {
      spawn: passingSpawn(),
      client: clean.client,
    });
    expect(clean.calls.created).toHaveLength(0);
    expect(clean.calls.updated).toHaveLength(0);
  });

  it("stays silent when the gate is red for reasons that are not this author's", async () => {
    const { calls, client } = fakeThread([]);
    const code = await claNotice(["--pr", "7", "--author", "someone"], {
      spawn: failingSpawn("CONTRIBUTORS.md: does not name 'other-person', who has signed"),
      client,
    });
    expect(code).toBe(0);
    expect(calls.created).toHaveLength(0);
    expect(calls.updated).toHaveLength(0);
  });

  it("flips an earlier notice to say so when the remaining red is not this author's", async () => {
    const { calls, client } = fakeThread([{ id: 5, body: `${CLA_NOTICE_MARKER}\nold` }]);
    const code = await claNotice(["--pr", "7", "--author", "someone"], {
      spawn: failingSpawn("CONTRIBUTORS.md: does not name 'other-person', who has signed"),
      client,
    });
    expect(code).toBe(0);
    expect(calls.created).toHaveLength(0);
    expect(calls.updated).toEqual([
      { id: 5, body: expect.stringContaining("no longer yours to fix") },
    ]);
  });

  it("reads faults off stderr, so a note quoting the same trailer is not read as one", async () => {
    const { calls, client } = fakeThread([{ id: 5, body: `${CLA_NOTICE_MARKER}\nold` }]);
    const code = await claNotice(["--pr", "7", "--author", "renovate[bot]"], {
      // The gate's exemption NOTE names the trailer on stdout while the only
      // fault, on stderr, belongs to somebody else.
      spawn: vi.fn(() => ({
        status: 1,
        stderr: "signatures/version1/cla.json: signedContributors[2] names no GitHub account",
        stdout:
          "1 commit(s) authored by 'renovate[bot]' carry no Signed-off-by: trailer and owe none",
      })),
      client,
    });
    expect(code).toBe(0);
    expect(calls.created).toHaveLength(0);
    expect(calls.updated).toEqual([
      { id: 5, body: expect.stringContaining("no longer yours to fix") },
    ]);
  });

  it("posts on a missing sign-off, which is this author's branch whatever commit it names", async () => {
    const { calls, client } = fakeThread([]);
    const code = await claNotice(["--pr", "7", "--author", "someone"], {
      spawn: failingSpawn('abc12345 ("feat: work"): no Signed-off-by: trailer — CLA.md says'),
      client,
    });
    expect(code).toBe(0);
    expect(calls.created).toHaveLength(1);
    expect(calls.created[0].body).toContain("Signed-off-by");
  });

  it("posts when the roster fault names this author, whatever the login's casing", async () => {
    const { calls, client } = fakeThread([]);
    await claNotice(["--pr", "7", "--author", "CasedUser"], {
      spawn: failingSpawn("CONTRIBUTORS.md: does not name 'CasedUser', who has signed"),
      client,
    });
    expect(calls.created).toHaveLength(1);
  });

  it("never claims a comment that merely quotes the marker mid-body", async () => {
    const { calls, client } = fakeThread([{ id: 9, body: `quoting ${CLA_NOTICE_MARKER} inside` }]);
    await claNotice(["--pr", "7", "--author", "someone"], { spawn: failingSpawn(), client });
    expect(calls.created).toHaveLength(1);
    expect(calls.updated).toHaveLength(0);
  });

  it("fails its own run when the gate could not judge at all, without touching the thread", async () => {
    const { calls, client } = fakeThread([]);
    const code = await claNotice(["--pr", "7", "--author", "someone"], {
      spawn: vi.fn(() => ({ status: 2, stderr: "--author needs a GitHub login", stdout: "" })),
      client,
    });
    expect(code).toBe(1);
    expect(calls.created).toHaveLength(0);
  });

  it("refuses an invocation missing the pull request or the author", async () => {
    expect(await claNotice(["--author", "x"], {})).toBe(2);
    expect(await claNotice(["--pr", "7"], {})).toBe(2);
  });

  it("reports a thread it could not write rather than pretending it notified anyone", async () => {
    const code = await claNotice(["--pr", "7", "--author", "someone"], {
      spawn: failingSpawn(),
      client: {
        listComments: async () => {
          throw new Error("GitHub GET -> 500");
        },
      },
    });
    expect(code).toBe(1);
  });
});
