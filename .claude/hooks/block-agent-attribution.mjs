#!/usr/bin/env node
// PreToolUse(Bash) hook: refuse to publish agent attribution — or, more
// importantly, a claude.ai session link — to GitHub.
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
const command = input.tool_input?.command ?? "";

if (PUBLISHING_GH.test(command)) {
  const text = publishedText(command);
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
