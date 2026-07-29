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
- **No derived section order.** The order the sections are read in is
  declared and checked against the tree both ways; alphabetical would put
  `charter` ahead of `north-star`. Order _within_ a section is derived, because
  a hand-kept list of twenty-odd specifications drifts and nothing checks it.
- **No runtime.** Static output, served by whatever the deployment provides.

<!-- readme:status -->

## Status

Live: every page comes from `shared/libs/doctrine`, and this app holds no
document of its own. Directory-scoped mechanics live in
[`./CLAUDE.md`](./CLAUDE.md).
