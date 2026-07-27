/**
 * Minimal GitHub REST client for issue triage — global `fetch` only, no SDK
 * (Rule 2: the stdlib already speaks HTTP; an SDK would be the first
 * third-party dep this tool needs). Every method throws on a non-2xx response
 * with the status and a body snippet, so callers fail loud instead of
 * mutating issues on stale assumptions.
 */

const API_VERSION = "2022-11-28";

/**
 * @param {{ repo: string, token: string, fetchImpl?: typeof fetch, baseUrl?: string }} cfg
 *   `repo` is `owner/name` (the shape GitHub Actions provides in
 *   `GITHUB_REPOSITORY`).
 */
export function githubClient({
  repo,
  token,
  fetchImpl = fetch,
  baseUrl = "https://api.github.com",
}) {
  const request = async (method, path, body, { tolerate404 = false } = {}) => {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "ecoma-repo-care",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (cause) {
      // Network-level failures get the same structured shape as non-2xx
      // responses, so callers can report them without a raw fetch stack.
      throw new Error(`GitHub ${method} ${path} failed: ${cause.message}`, { cause });
    }
    const text = await res.text();
    if (!res.ok) {
      // A tolerated 404 is a legitimate answer ("no such path"), not a
      // failure — callers probing model-chosen paths must not crash the run.
      if (tolerate404 && res.status === 404) return null;
      throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : null;
  };

  return {
    getIssue: (number) => request("GET", `/repos/${repo}/issues/${number}`),
    getPull: (number) => request("GET", `/repos/${repo}/pulls/${number}`),
    // Per-file patches; pages capped well above any sane PR, loud when hit.
    listPullFiles: async (number) => {
      const all = [];
      for (let page = 1; page <= 5; page += 1) {
        const batch = await request(
          "GET",
          `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
        );
        all.push(...batch);
        if (batch.length < 100) return all;
      }
      console.error(`listPullFiles: stopped after 500 files — review covers a partial diff`);
      return all;
    },
    /**
     * Repository contents at a ref, for model-requested context reads.
     * Returns `{ type: "dir", entries }` (names, dirs suffixed `/`),
     * `{ type: "file", text }` (decoded UTF-8), or null when the path does
     * not exist or is not readable this way (submodule, symlink, or a file
     * past the API's 1 MB base64 ceiling).
     */
    getContents: async (path, ref) => {
      const encoded = path.split("/").map(encodeURIComponent).join("/");
      const res = await request(
        "GET",
        `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
        undefined,
        { tolerate404: true },
      );
      if (res === null) return null;
      if (Array.isArray(res)) {
        return {
          type: "dir",
          entries: res.map((e) => `${e.name}${e.type === "dir" ? "/" : ""}`),
        };
      }
      if (res.type === "file" && res.encoding === "base64") {
        return { type: "file", text: Buffer.from(res.content, "base64").toString("utf8") };
      }
      return null;
    },
    // One page of 100 covers this repo's label vocabulary many times over.
    listLabels: () => request("GET", `/repos/${repo}/labels?per_page=100`),
    createLabel: ({ name, color, description }) =>
      request("POST", `/repos/${repo}/labels`, { name, color, description }),
    addLabels: (number, labels) =>
      request("POST", `/repos/${repo}/issues/${number}/labels`, { labels }),
    // Paginated like listPullFiles: the marker lookup that keeps triage and
    // review editing one comment in place must see every comment, not page 1.
    listComments: async (number) => {
      const all = [];
      for (let page = 1; page <= 5; page += 1) {
        const batch = await request(
          "GET",
          `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
        );
        all.push(...batch);
        if (batch.length < 100) return all;
      }
      console.error(`listComments: stopped after 500 comments — marker lookup may be incomplete`);
      return all;
    },
    createComment: (number, body) =>
      request("POST", `/repos/${repo}/issues/${number}/comments`, { body }),
    updateComment: (commentId, body) =>
      request("PATCH", `/repos/${repo}/issues/comments/${commentId}`, { body }),
  };
}
