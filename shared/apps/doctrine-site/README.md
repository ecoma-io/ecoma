---
name: doctrine-site
subsystem: shared
lang: en
description: VitePress build that publishes the doctrine tree at ecoma.io/doctrine — a renderer, never an author.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# doctrine-site

<!-- readme:why -->

## Why it exists

Ecoma's design is settled in documents, and those documents are published. This
is the surface that publishes them: a static build, cut with each release,
mounted as a path on the one domain beside the design system.

It is a renderer and nothing else. Every page it shows comes from
`shared/libs/doctrine`, so a document cannot exist on the site without existing
in the tree the workspace checks.

<!-- readme:consumers -->

## Who consumes it

Readers, through `ecoma.io/doctrine`. The edge router owns the mount; this app
only has to agree with it.

`doctrine-site-e2e` drives the built output and is the only automated consumer.

<!-- readme:ecosystem -->

## Where it sits

In `shared/` for the same reason the tree is: the ceiling spans every product
area, so neither the content nor its surface belongs to one product. The
precedent is exact — `/design` is served by `shared/apps/design-system` over
`shared/libs/core-ui`.

<!-- readme:boundary -->

## What it deliberately does not do

- **No authoring.** Content belongs to the library; a page written only here
  would be doctrine under no gate.
- **No derived sidebar order.** Alphabetical is not a reading order.
- **No runtime.** Static output, served by whatever the deployment provides.

<!-- readme:status -->

## Status

Scaffolded: the shell builds and its e2e passes against two placeholder pages.
The ceiling documents arrive with their own change. Directory-scoped mechanics
live in [`./CLAUDE.md`](./CLAUDE.md).
