#!/usr/bin/env node
// PreToolUse hook: refuse to publish agent attribution — or, more importantly,
// a claude.ai session link — to GitHub, through EITHER route that reaches it.
//
// The source fix lives in `.claude/settings.json` (`attribution.commit` and
// `attribution.pr` empty, `attribution.sessionUrl` false), which stops the
// harness from appending either. This hook is the net for the two cases a
// setting cannot cover: an agent that types the byline itself out of habit
// (which is how the line ended up DUPLICATED), and surfaces the setting knows
// nothing about, such as `gh issue comment`.
//
// A session link is the one that actually matters: it is a URL into a private
// transcript, published on a public thread. Failing loud beats stripping
// silently — the body is the agent's to fix, and a silent rewrite would teach
// nothing (CLAUDE.md > Rule 11).
//
// **Two tool shapes, because guarding only one left the route actually used
// wide open.** This started as a `Bash`-only hook, matching `gh pr create` and
// friends. But there is no `gh` CLI in the cloud sandbox — pull requests there
// are opened through the GitHub MCP server, whose calls a `Bash` matcher never
// sees. Three merged pull requests carry a session link in their public body
// for exactly that reason: the setting did not suppress it on that path and the
// guard could not see it. So the payload is now read from both shapes.
//
// The MCP side keys on the FIELD NAME, never on a list of tool names
// (CLAUDE.md > Rule 14: derive rather than enumerate). A roster of writing
// tools would go stale the next time the server grows one, and the failure
// would be silent — the shape this hook exists to prevent. Field names are the
// stable part of that surface: whatever publishes free text calls it `body`,
// `title`, or a `message`. Keying on the tool instead would also mean scanning
// every argument of every call, and a read-only `search_pull_requests` whose
// query is literally this pattern would be denied for publishing nothing.
import { readFileSync } from "node:fs";

// gh subcommands that publish free text someone else will read.
//
// Anchored at command position — start of a line, or just after a shell
// separator, with any `KEY=value` prefix skipped. A bare `\bgh …` also matched
// the words QUOTED inside some other command (a heredoc writing this hook's
// own fixtures, a grep for the pattern), which denies a call that publishes
// nothing. Missing a real invocation nested inside a quoted string is the
// cheaper error: nothing publishes without also reaching a command position.
const PUBLISHING_GH =
  /(?:^|[\n;&|(])[ \t]*(?:[A-Za-z_]\w*=\S*[ \t]+)*gh[ \t]+(?:pr|issue|release)[ \t]+(?:create|edit|comment)\b/m;

const FORBIDDEN = [
  {
    what: "a claude.ai session link",
    re: /https?:\/\/claude\.ai\/code\/session[_/-]/i,
  },
  { what: "a `Claude-Session:` trailer", re: /^[ \t]*claude-session[ \t]*:/im },
  { what: "a `Co-Authored-By: Claude` trailer", re: /co-authored-by[ \t]*:[ \t]*claude\b/i },
  { what: "a “Generated with Claude Code” byline", re: /generated with\s+\[?claude code/i },
];

/**
 * Tool names whose arguments reach GitHub through the MCP server. Matched as a
 * prefix so a newly added tool is guarded the day it appears, rather than the
 * day someone remembers to list it.
 */
const GITHUB_MCP_TOOL = /^mcp__github__/;

/**
 * Argument names that carry free text a reader will see. `body` covers pull
 * request and issue bodies, review comments and replies; `title` covers both;
 * `message`/`commit_message`/`commit_title` cover the commit a file-write or a
 * merge composes. Anything else a GitHub MCP call takes — a query, a path, a
 * ref, a number — publishes nothing and is deliberately not read.
 */
const PUBLISHING_FIELDS = new Set(["body", "title", "message", "commit_message", "commit_title"]);

/**
 * The publishing text of an MCP call: every `PUBLISHING_FIELDS` string in its
 * arguments, joined. Non-string values are skipped rather than stringified, so
 * a number or an array of paths cannot manufacture a match.
 */
function mcpPublishedText(toolInput) {
  return Object.entries(toolInput ?? {})
    .filter(([key, value]) => PUBLISHING_FIELDS.has(key) && typeof value === "string")
    .map(([, value]) => value)
    .join("\n");
}

/**
 * The text the command would publish: the command line itself (a heredoc or
 * an inline `--body` string is already in there) plus any `--body-file`/`-F`
 * payload, which would otherwise smuggle the line past a command-line scan.
 */
function publishedText(command) {
  const parts = [command];
  const fileArg = /(?:--body-file|(?<![\w-])-F)[= ]+(?:"([^"]+)"|'([^']+)'|(\S+))/g;
  for (const match of command.matchAll(fileArg)) {
    const path = match[1] ?? match[2] ?? match[3];
    if (!path || path === "-") continue; // stdin: nothing on disk to read
    try {
      parts.push(readFileSync(path, "utf8"));
    } catch {
      // Unreadable or not-yet-written path — the command-line scan still applies.
    }
  }
  return parts.join("\n");
}

const input = JSON.parse(readFileSync(0, "utf8"));
const toolName = input.tool_name ?? "";
const command = input.tool_input?.command ?? "";

/** What this call would publish, or `null` when it publishes nothing. */
function candidateText() {
  if (GITHUB_MCP_TOOL.test(toolName)) return mcpPublishedText(input.tool_input);
  if (PUBLISHING_GH.test(command)) return publishedText(command);
  return null;
}

const text = candidateText();
if (text) {
  const hits = FORBIDDEN.filter((f) => f.re.test(text)).map((f) => f.what);
  if (hits.length > 0) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `This would publish ${hits.join(" and ")} to a public GitHub thread. ` +
            "Remove those lines from the body and run it again — this repo publishes no agent " +
            "attribution and never a session link (.claude/settings.json > attribution).",
        },
      }),
    );
  }
}
