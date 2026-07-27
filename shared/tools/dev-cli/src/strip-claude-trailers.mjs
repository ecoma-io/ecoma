/**
 * Strips AI-agent attribution trailers that some cloud/agent harnesses append
 * to commit messages automatically:
 *   - "Co-Authored-By: Claude …"  (only the Claude co-author — human
 *     co-authors are preserved)
 *   - "Claude-Session: …"         (a link back to a claude.ai session)
 *
 * Wired into git as a `prepare-commit-msg` step (lefthook.yml, plus a fallback
 * .git/hooks entry installed by the `.claude/settings.json` SessionStart hook)
 * so commits land under the human author with a clean message regardless of
 * whether dependencies are installed.
 */
import { readFileSync, writeFileSync } from "node:fs";

// A trailer line is stripped when its key is `Claude-Session` or it is a
// `Co-Authored-By` crediting Claude. Case-insensitive; leading whitespace only.
const AGENT_TRAILER_RE = /^\s*(co-authored-by:\s*claude\b|claude-session:)/i;

/**
 * Returns `message` with the agent trailers removed. When nothing matches, the
 * input is returned byte-for-byte unchanged so human commits are never touched.
 */
export function stripTrailers(message) {
  const lines = message.split("\n");
  if (!lines.some((line) => AGENT_TRAILER_RE.test(line))) return message;

  const kept = lines.filter((line) => !AGENT_TRAILER_RE.test(line));
  // Drop blank lines left dangling at the end once the trailers are gone.
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  return kept.join("\n") + "\n";
}

/**
 * Rewrites the commit-message file at `msgPath` in place. Returns a process
 * exit code (always 0 — a missing/unreadable file is a no-op, never a failure
 * that would block the commit).
 */
export function stripClaudeTrailers(msgPath) {
  if (!msgPath) return 0;

  let text;
  try {
    text = readFileSync(msgPath, "utf8");
  } catch {
    return 0;
  }

  const cleaned = stripTrailers(text);
  if (cleaned !== text) writeFileSync(msgPath, cleaned);
  return 0;
}
