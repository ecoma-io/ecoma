---
title: Building a Public Page
description: How a public page combines the app modules and content.
---

# Building a Public Page

A public page on Ecoma is a composition of four layers:

```text
app/layout      →  PublicShell, global navigation, mount topology
        ↓
app/i18n        →  locale dimension: registry, parse, switch
        ↓
content         →  localized markdown rendered from the content tree
```

## 1. The application owns routing and content

The app defines one file-based route for all documentation content. The
route validates the pathname against the shared topology contract and then
resolves a document from the content collection:

```ts
// pseudo-code for the docs route
const layout = parsePublicLayoutPath(route.path);
// accept only kind === 'localized' && mount === 'docs'
```

If the topology is invalid, the route is rejected before any content lookup; if
the content does not exist, the page is a 404.

## 2. `app/layout` provides the shell

Every docs page renders the shared shell instead of its own header and footer:

```vue
<PublicShell :path="route.path">
  <!-- docs content -->
</PublicShell>
```

The shell parses the pathname once, renders the header (brand, global
navigation, locale switcher) and the footer, and never needs reimplementing per
app.

## 3. `app/i18n` owns the locale

Locales, their metadata, and switching between them all come from `app/i18n`.
When you switch language on a docs page, the shell calls `switchLocale()` to
keep the same document and change only the locale segment:

```text
/en/docs/concepts/public-web
        ↓
/vi/docs/concepts/public-web
```

The app never reimplements locale parsing or path rewriting.

## 4. Content renders locally

The page queries the `docs` collection by the exact pathname and renders the
document with `ContentRenderer`, so the typography you see — headings, code
blocks, tables, blockquotes — is the app-local rendering, not a global
rendering service.

> This page is an illustration of the composition, not a specification of a
> generic page-builder framework. The actual contracts live in the repository.

---

_Previous: [Local Development](/en/docs/guides/local-development)_
