---
name: website
lang: en
description: The ecoma.io storefront and growth area — the Nuxt app shell at `/`, its Playwright gate, and the seam where the withheld Website Charter's funnel will land.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# website

The subsystem the Website Charter's public record names for the ecoma.io
surface: storefront and growth, strongly separated from the product Hub. The
charter's architectural half is published
([Website Charter](../shared/libs/doctrine/charter/website.md)); its funnel
half stays withheld. What exists here today is the seam that half describes —
the URL topology, the i18n shape, and the shell apps that will publish the
marketing surface once the funnel lands.

<!-- readme:why -->

## Why it exists

The deploy charter partitions the product into surfaces at fixed URLs: the
website at `/` (ADR-0004 — Nuxt, SSG with ISR), the doctrine at `/doctrine`
(ADR-0007 — VitePress), the design system at a mount. Those surfaces need an
owner tree, and the corpus map records that tree as this area — not as
`shared/apps`. Putting the surface here keeps the storefront out of the
shared substrate, which must stay importable from every scope: a growth
surface owned by marketing copy has nothing to export to `core-ui`.

<!-- readme:consumers -->

## Who consumes it

Site visitors and search crawlers — the shell serves human readers and the
SEO surface (hreflang, canonical, `robots.txt`) at once. The workspace gates
consume it too: every project here carries the full set of checks
(`lint`, `test`, `typecheck`, `build`, plus `e2e` in its own project), and the
`site` app's hreflang/canonical behavior is pinned by `site-e2e` so a future
content build cannot regress it silently.

<!-- readme:ecosystem -->

## Where it sits

The repository root is the parent of `website/`, same as `shared/` and
`cloud/`. URL topology and i18n decisions are recorded in
[`website/CLAUDE.md`](./CLAUDE.md), which also holds the deferral ledger —
the design-system mount name (`/design` vs `/design-system`), the doctrine
surface's per-locale build migration, the sitemap, and ISR all have seams
reserved there. Nothing here imports any shared lib: the shell is a surface,
not a consumer.

<!-- readme:boundary -->

## What is not in scope

The funnel itself — copy, ICP-driven growth, and render decisions are the
Website Charter's, and the funnel half that owns the copy is withheld. The doctrine surface lives
in `shared/apps/doctrine-site`, not here, and the edge router (not this
tree) owns every mount. The system charter is single and belongs to the
Hub; `website/` records the area, never the funnel.

<!-- readme:status -->

## Status

Shell scaffolding: `website/apps/site` (Nuxt 4 + `@nuxtjs/i18n`, languages
derived from `languages.config.json`) and `website/apps/site-e2e` (Playwright
gate). All content beyond a loud status page is deferred by charter. This
area is one seam ready to be filled, not a product shipping marketing copy.
