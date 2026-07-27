---
name: core-tauri
subsystem: shared
lang: en
description: Tauri window-chrome composable backing @ecoma-io/ui's TitleBar for desktop shells.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# core-tauri

Shared Tauri webview plumbing for desktop apps: the window-chrome composable
that backs `@ecoma-io/ui`'s `TitleBar` (minimize / maximize / close, maximized
state). Currently the workspace's only desktop-shell substrate.

<!-- readme:why -->

## Why this exists

Every frameless desktop shell needs exactly one set of window-chrome controls
wired into `TitleBar` — minimize, maximize, close, and the maximized state
that drives the button icon. If each Tauri host app wired that itself, the
copies would drift apart over time (different edge cases around when
`isMaximized` refreshes, different error handling). This lib exists so that
wiring is written once and consumed by every desktop shell in the workspace.

<!-- readme:consumers -->

## Who consumes it

A Tauri host app's `TitleBar` wiring calls `useWindowControls` from
`src/window-controls.ts` to drive `@ecoma-io/ui`'s `TitleBar` component. No
host app exists in the repo yet — this lib is built ahead of its first
consumer, kept as the substrate for the first Tauri desktop shell that lands.

<!-- readme:ecosystem -->

## Where it sits in the ecosystem

One of `shared/libs`: importable by any product domain via
`@ecoma-io/core-tauri`, never the reverse (`shared/*` never reaches into a
product domain — see `shared/CLAUDE.md`). It pairs with `@ecoma-io/ui`'s
`TitleBar`: that component owns the chrome's look, this lib owns driving the
actual OS window behind it. It is the only desktop-shell substrate in the
workspace today — a second desktop-shell backend would implement the same
`UseWindowControls` shape rather than this lib growing a second backend.

<!-- readme:boundary -->

## What it deliberately does not do

- No preload/IPC tier — Tauri's webview drives its own window directly
  through `@tauri-apps/api/window`, so `useWindowControls` is the whole
  bridge; that layering belongs to shells that actually need an IPC hop.
- No frameless configuration — that lives in the host app's
  `tauri.conf.json` (`app.windows[].decorations: false`) and its Rust shell.
- No window-sizing policy — that is a per-app product decision (see
  core-ui's Design System › Principles §4).
- No Tauri type in its public surface — `UseWindowControls` is a plain shape
  (`isMaximized` ref + three functions) so a second desktop-shell backend
  could implement it without touching a host app's `TitleBar` wiring.

<!-- readme:status -->

## Status

Built, unit-tested (mocking `@tauri-apps/api/window` at the module
boundary), with no host app consumer in the repo yet. Runtime proof belongs
to a host app's e2e suite once one exists, not to this lib. Mechanics and
invariants: [`CLAUDE.md`](./CLAUDE.md).
