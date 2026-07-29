---
name: design-system
subsystem: shared
lang: en
description: The workspace's Storybook host app — it builds core-ui's stories and design docs into the static site the e2e gates scan and the future ecoma.io website will publish.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# design-system

The Storybook host app for the workspace's design system: the shell that
renders `core-ui`'s stories and design docs. It ships no components of its
own — all content lives in `core-ui`; this app owns the host that turns that
content into a running site and a deployable artifact.

<!-- readme:why -->

## Why it exists

The workspace's libraries are buildless by practice, but a Storybook is a
build: it emits `storybook-static`, an artifact with a lifecycle of its own —
`design-system-e2e` scans it as a blocking gate, and the planned ecoma.io
website will publish it as its design-system section. Hosting the Storybook
in an app gives that artifact a first-class owner while `core-ui` stays a
pure, buildless library.

<!-- readme:consumers -->

## Who consumes it

Developers, through `pnpm nx run design-system:serve` — the dev Storybook
(port 6008) with the live accessibility panel. `design-system-e2e`, through
`pnpm nx run design-system:build` — its Playwright gates scan the built
output. And, by recorded design intent, the future ecoma.io website, which
will mount the built Storybook as one of its sections.

<!-- readme:ecosystem -->

## Where it sits

Tagged `type:app`, `scope:shared`, with
`implicitDependencies: ["core-ui"]` — the story globs reach into
`core-ui`'s tree, an edge no import graph can see. Available targets are
`build`, `serve`, `lint`. The theme source (`tailwind.preset.js`) and every
story stay in `core-ui`; this app holds only the host wiring: the Storybook
config, `tailwind.config.js`, and the `postcss.config.js` shim Tailwind v4
requires.

<!-- readme:boundary -->

## What it deliberately does not do

It ships no components and no public API — `@ecoma-io/ui` stays an internal
alias of `core-ui`, never an npm package. It carries no `typecheck` or `test`
targets: everything here is host config executed by Storybook's own
toolchain, and every component it renders is typechecked and tested in
`core-ui`. It is not the blocking accessibility gate either — that is
`design-system-e2e`.

<!-- readme:status -->

## Status

Builds and serves the complete design-system Storybook — every `core-ui`
story and design doc, with story IDs owned by the content, not by this host.
Mechanics — the derived Vite aliases, the Tailwind jiti landmine, the
PostCSS shim, and the recorded website seam — live in
[`./CLAUDE.md`](./CLAUDE.md).
