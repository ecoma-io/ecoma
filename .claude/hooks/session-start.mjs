#!/usr/bin/env node
// SessionStart hook: resolve the session operator's commit identity, so a cloud
// sandbox's agent-bot identity never authors commits.
// Node-only on purpose — a contributor machine guarantees Node, not jq or a
// POSIX shell.
//
// This is best-effort: the identity is resolved dynamically from the session,
// never hardcoded, and the pre-commit `ensure-commit-identity --check` guard is
// the hard gate that closes any session-timing gap this hook has.
//
// It deliberately installs no `prepare-commit-msg` hook. Agent attribution
// trailers are KEPT — who wrote a commit is something a reader of this history
// is entitled to know, and stripping the trailer made an agent-written commit
// indistinguishable from a hand-written one. What must not drift is the
// AUTHOR: a trailer discloses the tool, `ensure-commit-identity` keeps the
// human on the commit, and those are two different promises.
import { execFileSync } from "node:child_process";

try {
  if (process.env.CLAUDE_PROJECT_DIR) process.chdir(process.env.CLAUDE_PROJECT_DIR);
} catch {
  process.exit(0); // no project directory — nothing to configure
}

try {
  execFileSync("node", ["shared/tools/dev-cli/src/main.mjs", "ensure-commit-identity"], {
    stdio: "inherit",
  });
} catch {
  // Never wedge session startup — the pre-commit guard still catches a bot identity.
}
