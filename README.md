> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# Ecoma

[![CI](https://github.com/ecoma-io/ecoma/actions/workflows/ci.yml/badge.svg)](https://github.com/ecoma-io/ecoma/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/ecoma-io/ecoma/badge)](https://scorecard.dev/viewer/?uri=github.com/ecoma-io/ecoma)

[ecoma.io](https://ecoma.io) · [Doctrine](https://ecoma.io/doctrine)

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
- [Code of Conduct](./CODE_OF_CONDUCT.md) — community standards
- [Security policy](./SECURITY.md) — reporting a vulnerability

## License

Ecoma is **fair-code**: source-available, not open source, and not closed
either. Those three are different things and the difference is the point.

The source is public and stays that way — every mechanism the product commits
to a tenant is meant to be readable, self-hosted and modified. What fair-code
withholds is the one freedom an OSI licence cannot withhold: selling Ecoma
itself as a service. That restriction is why the rest can be open.

**No licence is granted yet.** The Sustainable Use License is being prepared
and has not been reviewed, so until it lands the legal position is © Ecoma,
all rights reserved. Granting a licence is not reversible for code already
released under it, which is why this sentence is a status rather than a
placeholder.

The documents under `shared/libs/doctrine/` are licensed today, separately:
[CC BY-SA 4.0](./shared/libs/doctrine/LICENSE).
