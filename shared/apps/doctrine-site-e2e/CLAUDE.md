# Doctrine site e2e mechanics (`shared/apps/doctrine-site-e2e`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`. Nx
project name `doctrine-site-e2e`; tags `type:e2e`, `scope:shared`. Playwright
over the **built** `doctrine-site`.

- **This tier exists because assembly is the risk.** The site is generated from
  Markdown by a tool, so no unit test can say the assembly produced a page a
  browser opens at the mounted path. That is what these pin, and it is the only
  thing they should pin — a fact better checked in the library belongs there.
- **`tree-as-source` writes into `shared/libs/doctrine` and rebuilds the site.**
  That is the point of the file, not a shortcut in it: every other check here
  would pass just as well against a copy of the tree kept beside the app, so the
  only way to tell a renderer from a copy is to change the library and look. It
  writes two untracked files and removes them, so `check-doctrine` — which reads
  the git index — never sees them, and a killed run leaves two strays and damages
  no document. It rebuilds with VitePress directly rather than through the Nx
  target, which would hand back its cached output for inputs that just changed.
- **`workers: 1`.** One suite rebuilds the `dist` every worker shares; a second
  worker reading it mid-build sees neither the old site nor the new one.
- **The `e2e` target builds first via `dependsOn`, never inside the command.**
  `webServer` only serves; a build step in the serve command would race test
  collection.
- Two things copied from `design-system-e2e`'s config are load-bearing and
  documented there in full: `exec` in the serve command (so Playwright's
  teardown reaps the process holding the port) and launching Vite as
  `node <resolved cli>` (there is no `node_modules/.bin` beside an app in a
  single-package monorepo). Changing either produces a webServer timeout whose
  cause is invisible.
- The suite runs through `dev-cli run-e2e`, which wraps Linux in `xvfb-run`.
  Chromium must be provisioned; an environment without it fails at launch rather
  than reporting a site defect.
