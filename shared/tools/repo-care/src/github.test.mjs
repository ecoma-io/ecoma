import { describe, expect, it, vi } from "vitest";

import { githubClient } from "./github.mjs";

const jsonResponse = (payload, ok = true, status = 200) => ({
  ok,
  status,
  text: async () => JSON.stringify(payload),
});

const client = (fetchImpl) => githubClient({ repo: "ecoma-io/ecoma", token: "tkn", fetchImpl });

describe("githubClient", () => {
  it("authenticates and versions every request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ number: 7 }));
    await client(fetchImpl).getIssue(7);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/ecoma-io/ecoma/issues/7");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer tkn");
    expect(init.headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(init.headers["User-Agent"]).toBe("ecoma-repo-care");
    expect(init.body).toBeUndefined();
  });

  it("serializes write payloads onto the right endpoints", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}));
    const gh = client(fetchImpl);
    await gh.addLabels(7, ["bug", "area:shared"]);
    await gh.createLabel({ name: "needs-info", color: "fbca04", description: "d" });
    await gh.createComment(7, "hello");
    await gh.updateComment(123, "edited");

    const calls = fetchImpl.mock.calls.map(([url, init]) => [init.method, url, init.body]);
    expect(calls[0]).toEqual([
      "POST",
      "https://api.github.com/repos/ecoma-io/ecoma/issues/7/labels",
      JSON.stringify({ labels: ["bug", "area:shared"] }),
    ]);
    expect(calls[1][1]).toBe("https://api.github.com/repos/ecoma-io/ecoma/labels");
    expect(calls[2][2]).toBe(JSON.stringify({ body: "hello" }));
    expect(calls[3]).toEqual([
      "PATCH",
      "https://api.github.com/repos/ecoma-io/ecoma/issues/comments/123",
      JSON.stringify({ body: "edited" }),
    ]);
  });

  it("paginates pull files until a short page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}` }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(fullPage))
      .mockResolvedValueOnce(jsonResponse([{ filename: "last" }]));
    const files = await client(fetchImpl).listPullFiles(9);

    expect(files).toHaveLength(101);
    expect(fetchImpl.mock.calls[0][0]).toContain("/pulls/9/files?per_page=100&page=1");
    expect(fetchImpl.mock.calls[1][0]).toContain("page=2");
  });

  it("stops pull-file pagination loudly at the page cap", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}` }));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(fullPage));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const files = await client(fetchImpl).listPullFiles(9);

    expect(files).toHaveLength(500);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(err.mock.calls.flat().join("")).toContain("partial diff");
    err.mockRestore();
  });

  it("paginates comments until a short page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(fullPage))
      .mockResolvedValueOnce(jsonResponse([{ id: 100 }]));
    const comments = await client(fetchImpl).listComments(7);

    expect(comments).toHaveLength(101);
    expect(fetchImpl.mock.calls[0][0]).toContain("/issues/7/comments?per_page=100&page=1");
    expect(fetchImpl.mock.calls[1][0]).toContain("page=2");
  });

  it("stops comment pagination loudly at the page cap", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(fullPage));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const comments = await client(fetchImpl).listComments(7);

    expect(comments).toHaveLength(500);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(err.mock.calls.flat().join("")).toContain("marker lookup may be incomplete");
    err.mockRestore();
  });

  it("wraps a network failure in a structured error naming the request", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    await expect(client(fetchImpl).getIssue(1)).rejects.toThrow(
      "GitHub GET /repos/ecoma-io/ecoma/issues/1 failed: fetch failed",
    );
  });

  it("throws loud on non-2xx, carrying status and a body snippet", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: "Not Found" }, false, 404));
    await expect(client(fetchImpl).getIssue(1)).rejects.toThrow(/404.*Not Found/);
  });

  it("returns null for empty bodies instead of choking on them", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204, text: async () => "" });
    expect(await client(fetchImpl).getIssue(1)).toBeNull();
  });

  describe("getContents", () => {
    it("decodes a base64 file at the requested ref, path segments encoded", async () => {
      const payload = {
        type: "file",
        encoding: "base64",
        content: Buffer.from("export const a = 1;\n").toString("base64"),
      };
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(payload));
      const res = await client(fetchImpl).getContents("src/dir with space/a.mjs", "abc123");

      expect(res).toEqual({ type: "file", text: "export const a = 1;\n" });
      expect(fetchImpl.mock.calls[0][0]).toBe(
        "https://api.github.com/repos/ecoma-io/ecoma/contents/src/dir%20with%20space/a.mjs?ref=abc123",
      );
    });

    it("lists a directory with dirs suffixed by a slash", async () => {
      const payload = [
        { name: "src", type: "dir" },
        { name: "readme.md", type: "file" },
      ];
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(payload));
      expect(await client(fetchImpl).getContents("pkg", "abc")).toEqual({
        type: "dir",
        entries: ["src/", "readme.md"],
      });
    });

    it("answers null for a missing path instead of throwing — models guess paths", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse({ message: "Not Found" }, false, 404));
      expect(await client(fetchImpl).getContents("no/such.mjs", "abc")).toBeNull();
    });

    it("answers null for content it cannot decode (symlink, submodule, oversized)", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse({ type: "file", encoding: "none", content: "" }));
      expect(await client(fetchImpl).getContents("huge.bin", "abc")).toBeNull();
    });

    it("still throws loud on non-404 failures", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: "boom" }, false, 502));
      await expect(client(fetchImpl).getContents("a", "abc")).rejects.toThrow(/502/);
    });
  });
});
