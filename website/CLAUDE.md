# Website — Cross-Product Guidance

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`,
cross-product rules in `shared/CLAUDE.md`. The `website/` subsystem holds the
ecoma.io surface: the storefront and growth area the Website Charter names
— its architectural half is published at
`shared/libs/doctrine/charter/website.md` (the Website/Hub/Platform
classification law, the path-partitioned domain and its render models, the
security conditions for sharing it), while its funnel half — copy, campaigns,
surveys, tone — stays withheld. This directory is the architectural seam the
published half describes.

## What lives here, and what does not

- `website/apps/site` — the Nuxt app shell at `/` (ADR-0004: Nuxt for the site
  at `/`, SSG with ISR; the shell is SSG today, the ISR seam is reserved).
- `website/apps/site-e2e` — the Playwright gate over the built shell.
- The doctrine surface (`/doctrine`) is a shared app (`shared/apps/doctrine-site`)
  mounted by the edge router; the design system (`/design`) is
  `shared/apps/design-system`. The website app does not render either — the
  edge router owns every mount (Website Charter §3).

## The URL topology this shell commits to

Language-first subpaths, one rule for the whole site:

```
ecoma.io/       en (canonical, unprefixed — the first entry of languages.config.json)
ecoma.io/vi     vi
ecoma.io/zh     zh
```

URLs carry no trailing slash: the i18n module emits canonical/hreflang in
that shape, and `site-e2e` pins it — keep the shape when content lands.

- Locales derive from the repo-root `languages.config.json` at build time
  (Rule 14) — both this app and `doctrine-site` read the same file; a language
  edit happens there and nowhere else.
- `@nuxtjs/i18n` strategy `prefix_except_default`; `detectBrowserLanguage` is
  off so a crawler and a person always see the same URL.
- hreflang + canonical + `og:locale` come from `useLocaleHead` in
  `app.vue`; the canonical base URL derives from the root `package.json`
  `homepage` field (one source of truth).
- The doctrine surface must follow the same shape: language-first means one
  VitePress build per locale (`base: "/vi/doctrine/"` …), because VitePress
  appends locale prefixes to a single global base. That migration is a
  recorded decision point, not this shell's work.

## Deferred decisions — the seams, and why they are seams

- **The design-system mount name** (`/design` vs `/design-system`): the
  deployed charter vocabulary says `/design` (ADR-0004, deploy charter §3,
  overview corpus map); the design-system app's own docs say `/design-system`.
  Nothing mounts it yet — the shell must not prejudge. When the mount lands,
  settle the conflict upstream first (Rule: resolve conflicts upstream-first).
- **Marketing content**: the withheld funnel half of the Website Charter owns
  copy and ICP-driven funnels; the render model is settled in the published
  charter §3. The shell renders an honest status page only —
  "add a user-facing surface only once it has real function" (root
  `CLAUDE.md`).
- **Sitemap**: `@nuxtjs/sitemap` is not installed; `robots.txt` deliberately
  names no sitemap while none exists. `llms.txt` ships now as a shell list of
  the locale homes (n8n's site serves the same surface). When the sitemap
  lands with real content it must carry per-locale hreflang alternates, and
  `llms.txt` should grow with the content.
- **The real navigation**: the shell's only nav is the language switcher
  (scoped `data-testid="locale-switcher"`, e2e-pinned). The Website Charter's
  funnel half owns the real nav; when it lands it must keep the switcher and should
  carry the GitHub link and an install/self-host path — dify, n8n and astron
  all anchor self-host from the top bar — plus `/pricing` as a first-class
  destination for a fair-code license.
- **Social preview images**: `og:title`/`og:description`/`twitter:card`
  come from shell copy today; an `og:image` and `summary_large_image` wait
  for a real brand asset from the design system.
- **ISR**: ADR-0004 calls for SSG with ISR; today the shell is fully
  prerendered (`nuxt generate`). ISR route rules and a server runtime arrive
  with the deploy target.
- **Preview deploys**: per-PR preview subdomains must be `noindex` — the
  `preview-noindex` plugin (env `NUXT_PUBLIC_PREVIEW`) injects the meta now;
  the subdomain scheme is ops, and belongs to the deploy target.

## Workspace integration

- The `scope:website` module-boundary constraint lives in the root
  `eslint.config.mjs`, added with this subsystem's first project (the
  comment there says exactly that).
- New projects here follow the workspace gates: `project.json` with
  `type:`/`scope:`/`license:` tags, CLAUDE.md, README triad, e2e in its own
  `type:e2e` project.
