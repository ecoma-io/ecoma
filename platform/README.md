---
name: platform
lang: en
description: The Platform area — the Ecoma engine split along the hexagonal layer axis, plus the conformance suite that arbitrates each gate the roadmap has opened.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# platform

The area that holds the engine of the labor operating system: its domain
vocabulary, the ports that vocabulary exposes, the adapters behind those
ports, and the suites that arbitrate the gates. Its structure is not a habit
— it is a decision, recorded in
[ADR-0008](../shared/libs/doctrine/method/subsystem-structure.md), which this
tree instantiates row for row.

<!-- readme:why -->

## Why it exists

An area is a top-level directory, and it takes root in the change that lands
its first project rather than in anticipation of one. `platform/` earns that
now because the engine has to exist somewhere that is neither a product
surface nor the cross-product substrate: `shared/` must stay importable from
every scope, and an engine that every scope may import is an engine nobody
can replace. The split inside is by hexagonal layer rather than by feature,
so that the direction of every future import is decided once — at the
`layer:` tag — instead of argued per pull request.

<!-- readme:consumers -->

## Who consumes it

Nothing outside the area yet, and that is the intended state at this point:
`engine-domain`, `engine-ports` and `engine-adapters` are consumed by the
application service and the composition root that arrive later, and
`conformance-g0` consumes the ports and adapters directly, because it must
run before any application service exists. The workspace gates consume the
whole tree today — every project here carries `lint`, `test`, `typecheck`
and `build`, and the suite additionally carries `conformance`, which is the
target `dev-cli conformance` runs.

<!-- readme:ecosystem -->

## Where it sits

The repository root is the parent, the same as for `shared/` and `website/`.
A contract two domains share never lives in either of them — it belongs under
`shared/packages/`, licensed Apache 2.0, which is also the only home a second
product area may depend on. Inside this tree the direction is
`layer:domain` → `layer:port` → `layer:adapter`; the composition root, whose
job is to wire adapters into ports, deliberately carries no layer tag at all.
Directory-scoped mechanics are in [`platform/CLAUDE.md`](./CLAUDE.md).

<!-- readme:boundary -->

## What it deliberately does not do

It holds no `packages/` tier: that tier exists for a unit a third party
receives, and nothing here is promised to one yet. It holds no product
surface either — the storefront is `website/`, the doctrine site and the
design system are shared app shells. And it does not decide the wire
contract: domain vocabulary and wire contract are different things, and the
protocol schema lives with its own bindings rather than in this tree.

<!-- readme:status -->

## Status

Scaffolded, deliberately hollow. `engine-domain` carries the package seams
its future split will cut along, `engine-ports` and `engine-adapters` carry
their role and nothing else, and `conformance-g0` carries a named suite
skeleton whose assertions land together with the interfaces they check. The
layer and licence boundaries here are **review-enforced, not machine-checked**
— every library is Go, and nothing in the workspace parses Go imports.
Directory-scoped mechanics live in [`./CLAUDE.md`](./CLAUDE.md).
