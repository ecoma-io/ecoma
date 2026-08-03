---
name: engine-domain
subsystem: platform
lang: en
description: The engine's domain vocabulary — the primitives every other layer is written in terms of, with one Go package per concept.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# engine-domain

The pure half of the engine: the concepts, and nothing that talks to anything.
One Go package per concept — `eventlog`, `artifact`, `role`, `task`,
`checkpoint`, `handoff`, `escalation`, `calibration`, `composition`, `tenant`,
`lease`, `keytree`.

<!-- readme:why -->

## Why it exists

Every other layer is written in terms of these primitives, so they have to be
expressible without knowing what stores them or what carries them over a wire.
Keeping them in a library of their own is what makes that testable rather than
aspirational: a `layer:domain` library may reach only domain and util, so the
compiler is where a leaked dependency shows up, not a review.

<!-- readme:consumers -->

## Who consumes it

`engine-ports` names its interfaces in this vocabulary, `engine-adapters`
implements those interfaces, and the application service and composition root
that arrive later orchestrate over them. Nothing outside the `platform/` area
consumes it, and nothing here consumes anything at all.

<!-- readme:ecosystem -->

## Where it sits

First in the direction `layer:domain` → `layer:port` → `layer:adapter`. The
package boundary inside is a named seam: a package is promoted to a library of
its own — keeping its import path — once it earns an independent consumer, and
not before. Mechanics for whoever edits a file here are in
[`./CLAUDE.md`](./CLAUDE.md).

<!-- readme:boundary -->

## What it deliberately does not do

It performs no I/O and speaks no wire format. It owns the Filler concept but
never the Filler wire contract — those are different things, and the mapping
between them belongs to the application service. It also holds no logic in its
root package: a type that sits in no seam has quietly opted out of the split
the seams exist for.

<!-- readme:status -->

## Status

Scaffolded. The twelve packages exist, each documented with what it will hold
and empty of types. Content lands with the specification each one implements.
Directory-scoped mechanics live in [`./CLAUDE.md`](./CLAUDE.md).
