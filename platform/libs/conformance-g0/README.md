---
name: conformance-g0
subsystem: platform
lang: en
description: The suite that arbitrates the first gate — the Event Log entry schema, the log-store and blob-CAS contracts on both stacks, the Lease, and Principal identity.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# conformance-g0

A gate is a frozen text plus a suite that runs independently; a gate with no
suite is a paper gate. This project is that suite for the first gate, and its
scope is closed rather than open-ended.

<!-- readme:why -->

## Why it exists

Freezing an interface is a promise, and a promise nobody can check is a
document. The five contract areas this suite covers are exactly what the gate
freezes: the Event Log entry schema, the log-store port contract against both
stacks, the blob-CAS contract against both blob backends, the Lease contract,
and Principal identity. Nothing else, ever, under this gate — growth declared
at the freeze is the promise being kept, growth after it is breaking.

<!-- readme:consumers -->

## Who consumes it

The conformance executor, which finds this project by its `conformance` target
and its gate tag, and reports it in the gate ledger. Whoever proposes to flip
the gate's documents to frozen consumes it too: this suite going green is the
precondition for that act, not a follow-up to it.

<!-- readme:ecosystem -->

## Where it sits

Inside the `platform/` area, beside — never inside — what it arbitrates. It
drives `engine-ports` and `engine-adapters` directly and depends on no
application service, because it has to run before one exists. Mechanics for
whoever edits a file here are in [`./CLAUDE.md`](./CLAUDE.md).

<!-- readme:boundary -->

## What it deliberately does not do

It carries no `layer:` tag: a port contract must reach adapters to run against
both stacks, and any layer tag would forbid exactly that. It does not perform
the freeze either — that stays a human act with consequences. And it does not
arbitrate the storage behaviour the gate leaves open; the SQL-read,
metrics-projection and key-store contracts live in `engine-adapters` as
ordinary tests.

<!-- readme:status -->

## Status

An honest skeleton: five files, one per contract area, each naming its cases
as TODOs. **There are no test functions yet** — an empty test that passes would
report a contract as checked when nothing checked it, so `go test` is simply
green over zero tests and the ledger reads one suite, nothing frozen. The
assertions land together with the interfaces they check. Directory-scoped
mechanics live in [`./CLAUDE.md`](./CLAUDE.md).
