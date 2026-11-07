---
title: Concepts
description: The foundational ideas behind the Ecoma public web platform.
---

# Concepts

This section explains the ideas that shape the platform. Start here before the
guides so that the practical walkthroughs make sense.

## What is covered

- [Public Web](/en/docs/concepts/public-web) — the public URL model and how
  `/<locale>/<mount>/<path>` is parsed and built.
- [Content and Locales](/en/docs/concepts/content-and-locales) — how
  documentation content is localized and how content paths map to public routes.

## Why these two pages exist

The public surface of Ecoma is built from a small set of strict contracts: a
locale is always the first URL segment, a mount identifies an application, and
the remaining path is opaque to the platform. Understanding those contracts
explains almost every decision you will meet later.

> If a concept is not covered here, check the repository documentation under
> `docs/` — the implementation always wins when it disagrees with a page.

---

_Next: [Public Web](/en/docs/concepts/public-web)_
