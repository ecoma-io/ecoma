# Doctrine site mechanics (`shared/apps/doctrine-site`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`. Nx
project name `doctrine-site`; tags `type:app`, `scope:shared`. A VitePress build
(ADR-0007) that publishes the tree in `shared/libs/doctrine` at `ecoma.io/doctrine`.

- **This app renders; it never authors.** Content lives in `content/` today and
  moves to `shared/libs/doctrine` with the migration. A page that exists only
  here would be doctrine nobody governs — the whole reason the tree is a library.
- **`base: "/doctrine/"` must agree with the edge router**, which owns the mount
  (Website Charter §3b). It is not a preference: change it here alone and the
  built asset URLs point at a path nothing serves.
- **`.vitepress/config.ts` cannot import `@ecoma-io/doctrine` yet.** VitePress
  bundles the config with esbuild, which externalises bare imports before any
  Vite alias applies, so the path alias does not resolve at config-load time.
  `implicitDependencies` in `project.json` carries the graph edge meanwhile, so
  `nx affected` still rebuilds when a document changes. Solve the import when
  the ceiling lands and the two-way section check has something to check.
- **Sidebar order is declared, never derived from the directory listing.**
  Alphabetical would put `charter` ahead of `north-star`, which is not a reading
  order anyone chose.
- Runtime proof belongs to `doctrine-site-e2e`, which drives the BUILT site.
  Nothing here launches a browser.
