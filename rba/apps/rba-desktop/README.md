---
name: rba-desktop
subsystem: rba
lang: en
description: The Ecoma RBA desktop shell — a Tauri window hosting the shared design system, and the only project compiling Rust in this workspace.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# rba-desktop

A desktop window that renders the shared design system and does nothing else.

<!-- readme:why -->

## Why it exists

To prove a toolchain while proving it is still cheap.

This workspace installs a Rust toolchain in CI unconditionally, carries a
workspace `Cargo.toml`, and ships `core-tauri` for desktop window chrome —
and before this project, compiled no Rust at all. A lane that is configured
but never exercised is indistinguishable from one that is broken; the first
change to find out would have been the first real RPA driver, which is the
worst possible moment to discover a toolchain problem.

The shell separates that failure from the mechanism's. When a driver arrives,
the packaging, the window, the design-system composition and the Rust build
are already known-good, and the only unproven thing is the driver.

It is **not** the start of the RPA track. That track's entry condition is
◆G0 freezing the Filler interface and the Session effect, and neither has
happened. See [`../../CLAUDE.md`](../../CLAUDE.md) for what that forbids.

<!-- readme:consumers -->

## Who consumes it

Nobody, by design — it is an application, and applications are leaves.

Its own dependencies run the other way: it consumes `@ecoma-io/ui` for
primitives and tokens, and will consume `@ecoma-io/core-tauri` for window
controls once the shell grows chrome that needs them. Those two are the
reason the shell is worth having at all: they are the first real proof that
the design system composes inside a Tauri webview rather than only inside
Storybook.

<!-- readme:ecosystem -->

## Where it sits

The first and only project of the `rba/` area, and the workspace's only Rust
crate. Both facts make it load-bearing out of proportion to its size: it is
the sole holder of the `scope:rba` tag, and the sole exerciser of `cargo`,
`clippy` and `rustfmt`.

The frontend is Vite + Vue 3, the same stack the design system's Storybook
host uses, so a component behaves the same in both. The Rust side is a thin
Tauri composition root: a `run()` that builds a window, and a `main` that
calls it.

<!-- readme:boundary -->

## What it deliberately does not do

- **No RPA mechanism** — no driver, no perception, no session, no credential
  handling, no Filler. Those wait on the ◆G0 freeze.
- **No business logic of its own.** Anything worth testing belongs in a lib
  that other surfaces can share; a shell that accumulates logic becomes a
  place where a second copy of something lives.
- **No bundling in pull-request CI.** `bundle` builds real installers and is
  a release-lane target; the per-change gates are `lint` (which runs
  `cargo fmt --check` and `clippy`) and `test` (`cargo test`).

<!-- readme:status -->

## Status

Scaffold, and honestly labelled as one: the window opens, renders a heading,
and carries a single Rust unit test.

`release-desktop.yml` bundles real `.deb`/`.dmg`/`.msi` installers on all three
platforms and uploads them as run artifacts. They are **unsigned** and go
nowhere: signing identities and a distribution channel do not exist yet, and
neither is needed to prove the packaging pipeline resolves. The icons are
placeholders generated from `product-ecoma-rba.svg`.

Building it requires the GTK/WebKit development headers Tauri links against;
a machine without them cannot even `cargo check` this crate. Agent-facing
mechanics, including which failures are environment rather than code, live in
[`./CLAUDE.md`](./CLAUDE.md).
