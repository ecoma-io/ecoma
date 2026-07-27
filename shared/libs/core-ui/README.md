---
name: core-ui
subsystem: shared
lang: en
description: Alloy design system — Vue 3 primitives, blocks, and design tokens shared across every Ecoma product surface.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# core-ui — Alloy

Alloy is the design system Ecoma ships as `@ecoma-io/ui`: Vue 3 + Tailwind
primitives, blocks, and design tokens meant to be consumed, not
re-implemented, by every product surface in the workspace. Its formal
language is two forces — Human (steel) × Agent (copper) — with a gradient
seam only where the two meet; light-first, enterprise-toned.

<!-- readme:why -->

## Why it exists

Ecoma is a workspace where humans and agents work side by side, and for the
human side that means screens — screens that cross every product boundary
this repo will ever hold (a standalone app, a workspace shell, or a product's
own composition on top of one). If every product hand-rolls its own button,
dialog, or skeleton loader, each copy drifts in spacing, motion, and
accessibility on its own schedule. Alloy exists so a generic affordance — a
primitive, a token, a motion pattern — is built once and consumed everywhere,
under one rule in each direction: a product consumes before it hand-rolls,
and anything generic drafted inside a product graduates back up here instead
of staying a local fork. This is not a vague "looks generic enough" call —
it is a concrete inventory that unrelated products all reach for the same
way.

<!-- readme:consumers -->

## Who consumes it

Any UI-facing app or product UI lib in the workspace, imported as
`@ecoma-io/ui`. There is no in-repo consumer yet — only `shared/` exists
today, before any product domain — so this lib is currently kept as the
substrate future product surfaces will build on. In the meantime the
`design-system` app's Storybook (`pnpm nx run design-system:serve`) is the
live consumer of its design docs: every primitive's `.mdx` page and the
shared `docs/design/*` spec
pages (Motion, Color, Elevation, Typography, Iconography, Logo, Signature,
Principles) render there.

<!-- readme:ecosystem -->

## Where it sits

Alloy is tier one of a two-tier UI stack: this lib owns every _generic_
affordance (primitives, blocks, tokens, motion), while each product's own UI
lib (tier two) owns only that product's composition on top. That split is
what lets a product ship a screen without re-deciding what a button or a
confirmation dialog looks like. Every primitive here is five co-located
artifacts (component, test, demo, stories, design-page `.mdx`), and the
design pages under `docs/design/*` are the shared spec — the vocabulary
(tokens, keyframes, motion patterns, the icon set) every primitive draws on.

<!-- readme:boundary -->

## What it deliberately does not do

It knows nothing about any product's domain — no video timeline, no browser
profile list, no process editor. It carries no routing, no data fetching, no
business logic; a primitive here only takes props and emits events. Product-
specific composition belongs to each product's own UI lib (tier two), never
here — and the reverse holds too: once a second product needs a generic
affordance, it graduates up into this lib rather than staying duplicated
downstream.

<!-- readme:status -->

## Status

Built and exercised through the `design-system` Storybook, with no in-repo
consumer yet
— kept as the substrate for future product surfaces. Mechanics — the five
co-located artifacts per primitive, the consume-first / graduate-upstream
rules, the token source of truth, and the Tailwind v4 footguns — live in
[`./CLAUDE.md`](./CLAUDE.md).
