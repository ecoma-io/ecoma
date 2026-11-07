# DX Tool Instructions

- Machine-enforceable repository policy lives in DX (`pnpm dx pr-check`): the GitHub Actions step only runs the command, so YAML never re-implements policy. The command enforces exactly the PR policy documented in the root `AGENTS.md` — the title rules; no development-commit type-count invariant — and nothing else: diff inspection, file/project counts and the semantic "one logical change" judgement belong to human/AI review.
- Rules reuse the repository's source of truth: commitlint validates titles and parses development-commit types from the same configuration (parser preset included), never a parallel rule set, a second Conventional Commit parser, a hard-coded Nx project list, or GitHub's `pull_request.commits` count.
- pr-check is deterministic and offline: the development-commit range comes from the event payload's base/head SHAs against the checkout's local git history, and unavailable context or history fails the check closed. Configuration, event data and git access are injectable inputs.
- Treat `ROOT_DIR` as the repository root; commands must not depend on the caller's current working directory, and every command must be deterministic, repeatable and testable.
- Repository preparation must remain safe for repeated execution.
- Recursive repository operations must respect `.gitignore`.
- `.agents/` is the source of truth for agent configuration: `.agents/skills/` for skills and `.agents/agents/` for subagent definitions. `.claude/skills/`, `.opencode/skills/`, `.claude/agents/` and `.opencode/agents/` are generated; never author hand-written files there.
- `CLAUDE.md` is not generated. Claude Code reads `AGENTS.md` directly as project instructions when no `CLAUDE.md` exists, so no wrapper file is written.
- Agent-configuration synchronization must be idempotent: copy new and changed files, delete destination entries with no source counterpart, and preserve a destination untouched when its `.agents/` source is absent.
- Subagent definitions use Claude's frontmatter shape (`name`, `description`, optional `tools` and `model`) as the only source format. The OpenCode variant is derived, never hand-authored there: it needs `mode: subagent` and `permissions` built from `tools`, and OpenCode applies the last matching rule, so the generated catch-all `deny` must precede the specific `allow` rules.
- An unmappable tool name, an unknown frontmatter key or a `name` that does not match the file name must fail the command. Silently dropping any of them yields an agent with different permissions than its source declares.
