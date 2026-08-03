---
name: engine-adapters
subsystem: platform
lang: en
description: The implementations behind the engine's ports — one per backend, for both deployment shapes — plus the port contracts that arbitrate the milestone exit litmus.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# engine-adapters

Where the engine finally touches something real: a store, a filesystem, an
object bucket. Every port gets an implementation per deployment shape, never
one shared implementation wearing two names.

<!-- readme:why -->

## Why it exists

Two deployment shapes ship — the small stack and the reference stack — and the
promise that they behave the same is only worth what a test proves. Keeping
every implementation in one project, behind `engine-ports`, is what makes that
provable: the contract cases live once and run against each backend in turn.
It also keeps the choice of backend out of every other layer, which is the
whole point of having ports at all.

<!-- readme:consumers -->

## Who consumes it

The composition root wires these into ports; nothing else imports an adapter,
because reaching a store any other way is what the port boundary exists to
stop. `conformance-g0` reaches them too — a port contract cannot run without an
implementation behind it. It consumes `engine-ports` and `engine-domain`.

<!-- readme:ecosystem -->

## Where it sits

Last in the direction `layer:domain` → `layer:port` → `layer:adapter`, inside
the `platform/` area. Mechanics for whoever edits a file here are in
[`./CLAUDE.md`](./CLAUDE.md).

<!-- readme:boundary -->

## What it deliberately does not do

It arbitrates no gate. Three port contracts live here — SQL-read,
metrics-projection and the key-store — and they measure a milestone's exit
litmus rather than a gate, so they are ordinary integration tests under the
`test` target and carry no `conformance` target: a suite arbitrates a named
gate or nothing. It also holds no application logic; orchestration over ports
belongs a layer up.

<!-- readme:status -->

## Status

Scaffolded, and deliberately empty of adapters. Each lands with the port it
implements, in pairs — the small stack's backend and the reference stack's
backend — and its contract cases arrive with it, named
`*_integration_test.go`. Directory-scoped mechanics live in
[`./CLAUDE.md`](./CLAUDE.md).
