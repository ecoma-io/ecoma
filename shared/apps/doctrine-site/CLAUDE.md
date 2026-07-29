# Doctrine site mechanics (`shared/apps/doctrine-site`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`. Nx
project name `doctrine-site`; tags `type:app`, `scope:shared`. A VitePress build
(ADR-0007) that publishes the tree in `shared/libs/doctrine` at `ecoma.io/doctrine`.

- **This app renders; it never authors.** `srcDir` points straight at
  `shared/libs/doctrine` and this project holds no Markdown of its own. A page
  that existed only here would be doctrine nobody governs — the whole reason the
  tree is a library. `doctrine-site-e2e` proves the absence of a copy by
  changing the library and looking; do not weaken that test into "the page
  exists", which a copy would satisfy too.
- **`base: "/doctrine/"` must agree with the edge router**, which owns the mount
  (Website Charter §3b). It is not a preference: change it here alone and the
  built asset URLs point at a path nothing serves.
- **`.vitepress/config.ts` imports the library by RELATIVE PATH, under a scoped
  `eslint-disable`.** VitePress loads the config through Vite's config loader,
  which bundles it with `tsconfig: false` and externalises every bare specifier;
  `@ecoma-io/doctrine` is a tsconfig `paths` alias with no package behind it, so
  the alias form dies at load time with `ERR_MODULE_NOT_FOUND`. A relative
  specifier is bundled instead, which is why it works. `design-system`'s
  `tailwind.config.js` carries the same exemption for the same class of reason.
  Do not "fix" this import to the alias — it fails at run time, not at lint.
- **`implicitDependencies: ["doctrine"]` is still the only edge Nx has.** The
  relative import does not create one (verified: the graph shows no dependency
  without the entry), and the Markdown is read by directory scan, which no
  import graph can see. Remove it and `nx affected` stops rebuilding this site
  when a document changes.
- **Section order is declared; order inside a section is derived.** The declared
  list is safe only because `buildNav` checks it against the tree both ways —
  drop that call and the list starts hiding documents silently. Within a
  section, a hand-kept order over twenty-odd specifications would drift with
  nothing to catch it, so it is the section's own index first, then alphabetical.
- **The mount point is served by a redirect emitted in `buildEnd`, not by
  `rewrites`.** No document sits at the tree root (`buildNav` refuses one), so
  `/doctrine/` has nothing of its own to render. Rewriting the front-door
  document to the site root moves the directory its relative links resolve
  against — `../north-star/platform.md` becomes a link that climbs out of the
  mount, which the build reports as a dead link. A rewrite here would impose a
  linking rule on documents this app has no business constraining.
- **`.vitepress/theme/` exists to say each thing once.** The `status:` every
  document declares, the languages it was published in, and the licence are
  rendered from two slot components rather than repeated across the tree. The
  licence is deliberately not `themeConfig.footer`: the default theme hides that
  footer on any page with a sidebar, which is every page here.
- **`typecheck` runs `vue-tsc`, unlike `design-system`, which has no such
  target.** The difference is not inconsistency: there, every component is
  typechecked in `core-ui` and the config is inert; here `.vitepress/` holds
  this app's only logic and its only components, so nothing else would check
  them.
- Runtime proof belongs to `doctrine-site-e2e`, which drives the BUILT site.
  Nothing here launches a browser.
