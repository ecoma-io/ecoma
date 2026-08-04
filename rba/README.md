---
name: rba
lang: en
description: The RPA area — today a single desktop shell that proves the Rust and Tauri toolchain before the interfaces it will host are frozen.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# rba

The area the North Star names for robotic process automation: the drivers,
sessions and self-healing that let a Filler act on software built for people.

**Almost none of that is here yet, and the emptiness is the point.** The RPA
track's entry condition is not "the engine is finished" — it is that ◆G0 has
frozen two interfaces, the Filler interface and the Session effect. Starting
the mechanism before that freeze produces a second codepath, which is the one
failure the RPA principles forbid outright.

What lives here today is one project, `apps/rba-desktop`: a desktop shell with
no RPA mechanism in it. It exists because the toolchain has to be proven
somewhere, and proving it is cheapest before there is anything to break.

## Why the shell lands before the mechanism

The workspace already installs a Rust toolchain in CI, already carries a
`Cargo.toml`, and already ships `shared/libs/core-tauri` for desktop window
chrome. Until this project, none of it compiled a single line of Rust — the
lane was declared and unexercised, which is the same as untested.

A toolchain proved late is a toolchain that fails at the worst moment: the day
the first real RPA driver needs it, under deadline, with the mechanism itself
already in doubt. Landing an empty shell now separates those two failures, so
that when the driver arrives the only new thing is the driver.

## What is deliberately absent

No driver, no perception, no session, no credential handling, no Filler. Each
of those has a specification in the doctrine tree and a gate that freezes its
interface; none of those freezes has happened. Code written against an unfrozen
interface is code that will be rewritten, and the roadmap says so in the row
that gates this track.

## Layout

| Path                | What it is                                                                      |
| ------------------- | ------------------------------------------------------------------------------- |
| `apps/rba-desktop/` | The Tauri desktop shell — a webview, the shared design system, and nothing else |

Agent-facing mechanics for this area live in [`CLAUDE.md`](./CLAUDE.md).
