---
name: engine-ports
subsystem: platform
lang: en
description: The interfaces the engine's domain exposes to the outside — a log store, a blob store, a lease, a key store — named as needs, not as technologies.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# engine-ports

What the engine needs from the outside world, written in its own vocabulary:
an append-only log store, a content-addressed blob store, a lease, a key
store, a SQL read surface, a metrics projection.

<!-- readme:why -->

## Why it exists

A port is the thing that makes a backend replaceable. Separating it from both
the concepts and the implementations is what lets the same engine run on the
small stack and the reference stack without a branch anywhere in it — and what
lets a contract suite drive both from one set of cases. Written inside
`engine-domain` these interfaces would drag storage concerns into the pure
layer; written inside `engine-adapters` there would be nothing left to swap.

<!-- readme:consumers -->

## Who consumes it

`engine-adapters` implements it, `conformance-g0` drives it directly, and the
application service and composition root that arrive later orchestrate over
it. It consumes `engine-domain` and nothing else.

<!-- readme:ecosystem -->

## Where it sits

The middle of `layer:domain` → `layer:port` → `layer:adapter`, inside the
`platform/` area. Mechanics for whoever edits a file here are in
[`./CLAUDE.md`](./CLAUDE.md).

<!-- readme:boundary -->

## What it deliberately does not do

It names no technology — no driver, no dialect, no URL shape. It holds no
contract tests either: a suite never lives inside the project it arbitrates.
And it holds no vector port yet: `engine-ports/vector` is a named seam that
arrives with Knowledge, its first consumer, rather than a contract designed for
nobody.

<!-- readme:status -->

## Status

Scaffolded, and deliberately empty of interfaces. Each one lands with the
specification it serves, and the ones the gate covers land together with the
suite that holds them to their contract. Directory-scoped mechanics live in
[`./CLAUDE.md`](./CLAUDE.md).
