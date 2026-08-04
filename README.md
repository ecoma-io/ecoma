> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

<p align="center">
  <a href="https://github.com/ecoma-io/ecoma/actions/workflows/ci.yml"><img src="https://github.com/ecoma-io/ecoma/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/ecoma-io/ecoma"><img src="https://api.securityscorecards.dev/projects/github.com/ecoma-io/ecoma/badge" alt="OpenSSF Scorecard"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-fair--code-blue" alt="Fair-code"></a>
</p>

<p align="center">
  <a href="https://ecoma.io">ecoma.io</a> ·
  <a href="https://ecoma.io/doctrine">Doctrine</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

---

## Graph the work. Evolve by loop.

Most automation tools make you choose. Deterministic pipelines, or AI agents. A
workflow engine, or a chat assistant. Humans in the loop, or humans out of it.

**Ecoma refuses the choice.** Humans, AI agents, and rules/code are the same
kind of thing — a _labor resource_ that fills a _role_. A step in a process does
not care whether a person, a model, or a script does the work; it cares that the
work meets its bar. So a workflow is one graph, and what fills each node is a
decision you can change on Tuesday without rewriting anything.

That single idea is what makes the rest possible.

### 1. Graph engineering — the org chart becomes executable

Work is modelled as a graph: nodes are tasks, edges are handoffs, and every node
declares what a good output looks like. Humans and AI co-design that graph
**inside the engine** — not in a diagramming tool that has drifted from reality
by Friday.

The graph _is_ the process. There is no second copy to keep in sync.

### 2. Loop engineering — confidence is measured, not asserted

Every output crosses a **checkpoint** before it moves on, and the checkpoint's
confidence threshold is calibrated against _your_ tenant's data rather than a
vendor's demo. A role that keeps clearing its bar earns more autonomy; one that
stops clearing it gets escorted back to review.

That is the loop: run, measure, recalibrate, widen or narrow the leash. Not a
dashboard you look at — a mechanism that acts.

### 3. From a one-person company to an enterprise

The same engine serves both, because the binding constraint is identical and
only the scale differs: **human attention is the scarcest resource in the
building.**

For a solo founder that constraint is total — you _are_ the whole building.
Ecoma treats your attention as a measured resource: what reaches you, when, and
why becomes a policy you set instead of a flood you triage. A company that
outgrows one person does not change tools; it changes the thresholds.

---

## Where this actually stands

**Ecoma is pre-release.** No version has shipped and no artifact is distributed.
Building something meant to be self-hosted and audited means the design has to
be right before the code is — so the design is public first, and this section
says what is real rather than what is planned.

| Layer               | State                                                                        |
| ------------------- | ---------------------------------------------------------------------------- |
| **Doctrine**        | 3 North Stars, 27 specifications, charters and ADRs — published and readable |
| **Engineering rig** | Working: CI, gates, commit contract, conformance ledger, polyglot toolchain  |
| **Design system**   | Working: Vue 3 primitives and blocks behind a blocking accessibility gate    |
| **Website + docs**  | Working: the storefront shell and the doctrine reading surface               |
| **Engine**          | Specified in full; the package seams exist, the runtime does not             |

If a claim anywhere in this repository says otherwise about a product surface,
that is a bug in the file rather than a feature you missed.

## Read the design before the code

The reasoning is public, and that is the point. Every mechanism a tenant depends
on is written down before it is built, so you can disagree with the design on
its merits instead of reverse-engineering it from a binary.

Start at the [doctrine](https://ecoma.io/doctrine). Inside the tree, every
subproject then carries **two documents for two readers**:

- **`README.md`** — for humans. What this is, why it exists, and what it
  deliberately does **not** do.
- **`CLAUDE.md`** — for the coding agent. Directory-scoped invariants, footguns
  and run commands. A human can read it, but it assumes you already know what
  the thing is for.

Workspace-wide principles live in the root [`CLAUDE.md`](./CLAUDE.md).

## Getting started

```bash
# Toolchain check, dependencies, git hooks, and the Playwright browser
pnpm run setup

# The design system's Storybook
pnpm nx run design-system:serve

# The definition of done for any code change
pnpm nx affected -t lint test typecheck build e2e
```

`pnpm nx` is the only task runner. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Contributing

Outside contributions are welcome, and the terms are written down rather than
improvised:

- [Contribution guide](./CONTRIBUTING.md) — how we work, and the definition of done
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Security policy](./SECURITY.md) — how to report a vulnerability
- [`CLA.md`](./CLA.md) — a one-time agreement before your first merge

## License

Ecoma is **fair-code**: source-available, not open source, and not closed
either. Those are three different things and the difference is the point.

The source is public and stays that way — every mechanism the product commits to
a tenant is meant to be readable, self-hosted and modified. What fair-code
withholds is commercial redistribution, and above all selling Ecoma itself as a
service. That restriction is why the rest can be open.

> **This section is a summary for reading quickly, not the terms.**
> [`LICENSE`](./LICENSE) is what has legal effect, and where the two differ,
> `LICENSE` governs.

| Path                           | Terms                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| everything not named below     | Sustainable Use License                                                                        |
| `<subsystem>/packages/`        | Apache License 2.0 — what you build against                                                    |
| `<subsystem>/enterprise/`      | **no rights granted** — needs a separate written [Enterprise License](./ENTERPRISE-LICENSE.md) |
| `shared/libs/doctrine/**/*.md` | [CC BY-SA 4.0](./shared/libs/doctrine/LICENSE.docs), with the images those files reference     |
| `cloud/`                       | proprietary, and not published                                                                 |
| third-party components         | their own owner's terms                                                                        |

**Running Ecoma for your own organisation is expressly permitted** — commercial
or not, including to deliver goods and services to your customers. What is not
permitted is providing Ecoma to others commercially or for a charge: selling
copies, bundling it inside another paid product, or the clearest case, running
it for them as a hosted service. Distribution to others is allowed only when it
is both free of charge and non-commercial.

The build checks that declaration rather than trusting memory: every project
declares a licence tag, and the conventions gate fails when a tag disagrees with
its own directory. No licence here grants rights in the name Ecoma.
