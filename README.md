> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# Ecoma

Ecoma is a self-hostable, "fair-code" labor operating system where humans, AI,
and rules/code function as the same type of labor resource (Role/Filler);
workflows — both deterministic processes and reasoning tasks — are
co-designed by humans and AI directly within the engine; every output passes
through a checkpoint with confidence levels adjusted based on each tenant's
data; and human attention is treated as a resource to be measured and
optimized.

## How to read this repo

Every subproject carries **two documents, for two kinds of reader**:

- **`README.md` — for humans.** What this is, why it exists, and what it
  deliberately does **not** do. Start here.
- **`CLAUDE.md` — for the coding agent.** Directory-scoped mechanics:
  invariants, footguns, pairing rules, run commands. A human can read it too,
  but it assumes you already know what the thing is for.

Workspace-wide principles and conventions live in the root
[`CLAUDE.md`](./CLAUDE.md).

## Getting started

```bash
pnpm install

# The design system's Storybook
pnpm nx run design-system:serve

# Definition of done for a code change
pnpm nx affected -t lint test typecheck build e2e
```

`pnpm nx` is the only task runner. Convention and architecture decisions are
recorded in [`CLAUDE.md`](./CLAUDE.md) and in the commit history.

## Contributing

- [Contribution philosophy](./CONTRIBUTING.md) — how we work
- [Security policy](./SECURITY.md) — reporting a vulnerability

## License

Proprietary and confidential — © Ecoma. All rights reserved. This is closed
software, not open source.
