# site (`website/apps/site`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`;
this area's charter context and deferral ledger live in
`website/CLAUDE.md`. Nx project `site` (tags `type:app`, `scope:website`,
`license:sul`). The Nuxt app shell at `/` per ADR-0004 (SSG today; ISR is a
reserved seam, see `website/CLAUDE.md`).

## Single sources — do not redeclare them here

- **Locales**: `languages.config.json` at the repo root, read at build time
  in `nuxt.config.ts` (Rule 14). `defaultLocale` is its first entry (en, at
  `/`); `strategy: "prefix_except_default"`; `detectBrowserLanguage` is off —
  a crawler and a person must always see the same URL.
- **Canonical base URL**: the root `package.json` `homepage` field. That is
  why hreflang/canonical links point at the production origin even from a
  preview build — which is correct: a preview must be `noindex` AND its
  canonicals must name the production page.
- **Copy**: the `messages` triads in `app/i18n/messages.ts` are shell copy —
  honest placeholders, deliberately never marketing prose. The Website
  Charter owns real copy.

## The SEO surface is generated, not written

`app.vue` pushes `useLocaleHead({ dir, lang, seo })` into the page head —
hreflang alternates, canonical, `og:locale` and `html lang` all come from
the i18n module. Never hand-write a `<link rel="alternate">` or a
`<meta name="robots">` in a page: the site's SEO contract is what
`site-e2e` pins against the built artifact, and a hand-rolled tag can drift
from the module's output without any lint noticing.

## Preview builds must be noindex — the plugin, and the missing half

`app/plugins/preview-noindex.ts` injects `noindex, nofollow` when
`runtimeConfig.public.preview` is true. The key is declared in
`nuxt.config.ts` (`runtimeConfig.public.preview: false`) — that declaration
is what lets `NUXT_PUBLIC_PREVIEW=true` map onto it at build time; an
undeclared key is silently ignored (observed, not assumed). The e2e suite
pins the false half (a default build carries no robots meta). The true half
was verified by hand on 2026-08-01: `NUXT_PUBLIC_PREVIEW=true` then
`nuxt generate` emits the meta in every prerendered page — re-run the same
two lines whenever the plugin changes, and grep `dist/` for
`noindex, nofollow`.

## Run mechanics

- `build` runs `nuxt generate` (full prerender: `/`, `/vi/`, `/zh/` land in
  `dist/`); the CLI is invoked as `node ../../../node_modules/nuxt/bin/nuxt.mjs`
  — single-package monorepo, there is no `.bin` beside this app.
- `typecheck` runs `nuxi typecheck` (`vue-tsc` against the generated
  `.nuxt/tsconfig.json`, which this app's `tsconfig.json` extends — keep that
  extension; it is what makes the check typecheck the app at all).
- `test` runs the one co-located unit tier (`app/i18n/messages.test.ts`):
  key parity of the copy triads. A dropped key in one locale would silently
  fall back to English — the fallback is deliberate i18n behavior, which is
  exactly why the parity is pinned. Coverage scope is deliberately just
  `app/i18n/messages.ts` (see the comment in `vitest.config.ts`); the pages
  and plugins are the e2e gate's, not this tier's.
- Nuxt auto-imports are used (`#imports`) but always imported explicitly —
  eslint runs against this tree and `no-undef` would not know the globals.

## e2e

Owned by the `site-e2e` Nx project (never co-located), which drives the
built `dist/` via `vite preview` on port 4176 — see its own CLAUDE.md.
