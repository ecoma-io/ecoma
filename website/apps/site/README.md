---
name: site
subsystem: website
lang: en
description: The ecoma.io website shell — the Nuxt app at `/` (ADR-0004) publishing the marketing surface in en/vi/zh once the Website Charter lands.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# site

The ecoma.io website shell: the Nuxt app at `/` that will publish the
storefront once the Website Charter lands. Today it proves the plumbing the
charter will build on — the URL topology (`/`, `/vi`, `/zh`), the i18n
shape, and the SEO surface (hreflang, canonical, `robots.txt`) — with an
honest status page and no marketing copy.

<!-- readme:why -->

## Why it exists

ADR-0004 assigns the site at `/` to Nuxt (SSG with ISR). The Website
Charter, withheld, owns the funnel and the copy; this app is the seam that
turns the recorded decisions into a running, deployable artifact — and the
artifact `site-e2e` gates, so the SEO contract cannot rot unseen while the
content build happens later.

<!-- readme:consumers -->

## Who consumes it

Visitors and crawlers of ecoma.io — served one page per language, with
`html lang`, hreflang alternates, canonical and `og:locale` generated from
`useLocaleHead` rather than hand-written. The `site-e2e` Nx project consumes
the built `dist/` as its blocking gate.

<!-- readme:ecosystem -->

## Where it sits

`website/apps/site`, tagged `type:app`, `scope:website`. Locales derive from
the repo-root `languages.config.json` at build time; the canonical base URL
derives from the root `package.json` `homepage`. Both are read, never
copied (Rule 14). Mechanics and the preview-`noindex` seam are in
[`./CLAUDE.md`](./CLAUDE.md); the area's deferral ledger is in
[`../../CLAUDE.md`](../../CLAUDE.md). Targets: `lint`, `typecheck`, `test`,
`build`, `serve` — plus `e2e` in its own project.

<!-- readme:boundary -->

## What it is not

It is not the doctrine surface (`shared/apps/doctrine-site` owns `/doctrine`)
and not the design system (`shared/apps/design-system` owns the `/design`
mount). It imports no shared lib — a surface, not a consumer. And it is not
the Website Charter: the funnel, the copy and the ICP work land there, not
in this shell.

<!-- readme:status -->

## Status

Shell scaffolding — SSG via `nuxt generate`; ISR, sitemap, and the real
storefront content are reserved seams (see the deferral ledger in
[`./CLAUDE.md`](./CLAUDE.md)).
