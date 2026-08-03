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

## Preview builds must be noindex — both halves are gated

`app/plugins/preview-noindex.ts` injects `noindex, nofollow` when
`runtimeConfig.public.preview` is true. The key is declared in
`nuxt.config.ts` (`runtimeConfig.public.preview: false`) — that declaration
is what lets `NUXT_PUBLIC_PREVIEW=true` map onto it at build time; an
undeclared key is silently ignored (observed, not assumed). The e2e suite
pins the false half (a default build carries no robots meta); the true half
is the `verify-preview-noindex` target — three `nuxt generate` passes
(default → assert no meta, preview → assert the meta in every prerendered
page, default again so `dist/` is restored) driven by
`scripts/verify-preview-noindex.mjs`. CI runs the target in the e2e job
whenever this app is affected — it was previously invoked by nothing, which
made "gated" an overstatement; locally, re-run it whenever the plugin or the
`runtimeConfig` declaration changes (it is too build-heavy for a hook).

## The 404 is a client-side surface; the host owns the fallback

`error.vue` renders the not-found (and generic-error) copy, but in this SSG
build the static `404.html` ships as a client-rendered shell — the server
markup is empty and `html lang` appears only after hydration (the e2e gate
reads `/404.html` directly, so it pins exactly that). Serving `404.html` for
unknown routes is the deploy target's job: the e2e server (`vite preview`)
falls back to `index.html` instead, so a real host (nginx, GitHub Pages,
Cloudflare Pages…) must map unknown routes to `404.html`.

## Run mechanics

- `build` runs `nuxt generate` (full prerender: `/`, `/vi`, `/zh` land in
  `dist/`; the canonical/hreflang shape carries no trailing slash — pinned by
  `site-e2e`); the CLI is invoked as `node ../../../node_modules/nuxt/bin/nuxt.mjs`
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
