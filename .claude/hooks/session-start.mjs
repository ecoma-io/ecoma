#!/usr/bin/env node
// SessionStart hook: resolve the session operator's commit identity (so a cloud
// sandbox's agent-bot identity never authors commits) and install the
// prepare-commit-msg hook that strips agent trailers.
// Node-only on purpose — a contributor machine guarantees Node, not jq or a
// POSIX shell. The emitted git hook stays #!/bin/sh: git bundles sh on every
// platform it runs on, including Windows.
//
// This is best-effort: the identity is resolved dynamically from the session,
// never hardcoded, and the pre-commit `ensure-commit-identity --check` guard is
// the hard gate that closes any session-timing gap this hook has.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";

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

const hook = ".git/hooks/prepare-commit-msg";
if (!existsSync(hook)) {
  writeFileSync(
    hook,
    '#!/bin/sh\nexec node "$(git rev-parse --show-toplevel)/shared/tools/dev-cli/src/main.mjs" strip-claude-trailers "$1"\n',
  );
  chmodSync(hook, 0o755);
}
