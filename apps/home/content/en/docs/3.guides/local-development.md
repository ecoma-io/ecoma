---
title: Local Development
description: A concrete development loop — start the app, inspect a page, change content, run tests, build.
---

# Local Development

This guide walks through the everyday development loop for a public app.

## 1. Start the app

From the workspace root, start the public app dev server:

```bash
cd apps/home
pnpm exec nuxt dev
```

The server listens on `http://localhost:4200` — the port is pinned in
`devServer` in the app's `nuxt.config.ts`. The Nx target `serve` runs the same
command: `npx nx serve @ecoma-io/home`.

`host` is `0.0.0.0`, so the server also answers on every network interface of
your machine: open `http://<your-lan-ip>:4200` from another device on the same
network, or `http://<your-tailscale-ip>:4200` over a tailnet. MagicDNS names
such as `http://<machine>.<tailnet>.ts.net:4200` work too. Note that the dev
server has no authentication — anything that can reach the port can read the
app, its build errors and its source code, so prefer a trusted network.

## 2. Inspect a page

Open a document in the browser, for example:

```text
http://localhost:4200/en/docs/getting-started/installation
```

Look at the rendered page: the header with global navigation and locale
switcher, the docs sidebar, breadcrumbs, the table of contents, and the
previous/next links. Use the browser _View Source_ to confirm the page is
server-rendered.

## 3. Change content

Markdown content lives under `apps/home/content`. Edit an English page and open
its Vietnamese counterpart to see both sides:

```bash
# pick a page, e.g.
$EDITOR apps/home/content/en/docs/getting-started/local-development.md
```

`nuxt dev` picks up the change; the page reloads with the new content.

## 4. Run tests

From the workspace root, run the unit tests:

```bash
pnpm exec nx test home
```

This runs the Vitest suites colocated with the home app — including the
path-validation and content-resolution tests.

## 5. Build

The public app is a Cloudflare Worker with SSR; the production build also
prerenders every content page:

```bash
npx nx build @ecoma-io/home
```

The output lands in `apps/home/.output` — the Worker entry in `server/` plus
prerendered HTML and assets in `public/`. One Nx target consumes that output:

- `npx nx deploy @ecoma-io/home --configuration=staging` publishes it to
  Cloudflare as the staging Worker (`build` runs first automatically); use
  `--configuration=production` for the production Worker — a bare deploy
  without a configuration refuses to run.

To inspect the prerendered pages without deploying, point any static file
server at the output directory, for example:

```bash
npx serve apps/home/.output/public
```

---

_Previous: [Guides](/en/docs/guides) · Next: [Building a Public Page](/en/docs/guides/building-a-public-page)_
