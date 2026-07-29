---
name: doctrine-site-e2e
subsystem: shared
lang: en
description: Playwright suite driving the built doctrine site, pinning that the assembly produces pages a browser can open.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# doctrine-site-e2e

<!-- readme:why -->

## Why it exists

The doctrine site is assembled from Markdown by a generator. Nothing in the unit
tier can tell you the assembly worked — that the entry page answers at the
mounted path, that the sidebar reaches a document, that the licence is stated
where a reader meets it. Those are facts about a built artifact in a browser,
and this is where they are checked.

<!-- readme:consumers -->

## Who consumes it

CI, as a blocking gate, and anyone changing `doctrine-site` locally.

<!-- readme:ecosystem -->

## Where it sits

Beside `doctrine-site` in `shared/apps`, mirroring `design-system-e2e` beside
`design-system`. e2e projects are never co-located with the code they drive;
they drive a built artifact from the outside.

<!-- readme:boundary -->

## What it deliberately does not do

- **No content assertions.** Whether a document says the right thing is a
  question for the document, not the browser.
- **No unit coverage.** Navigation logic is pinned in `@ecoma-io/doctrine`.
- **No build.** The Nx target builds first through `dependsOn`.

<!-- readme:status -->

## Status

Live: four checks over the shell, and four that prove the pages come from
`shared/libs/doctrine` and from no copy — by changing that library and looking.
They grow with the site rather than ahead of it. Directory-scoped mechanics live
in [`./CLAUDE.md`](./CLAUDE.md).
