# Doctrine tree mechanics (`shared/libs/doctrine`)

Directory-scoped mechanics only — principles live in the root `CLAUDE.md`. Nx
project name `doctrine`; import alias `@ecoma-io/doctrine` (tags `type:lib`,
`scope:shared`, `layer:domain`). It holds the published ceiling — North Stars,
specs, the deploy charter, the review rubric — and the pure logic that turns
that tree into navigation. `shared/apps/doctrine-site` renders it; nothing else
consumes it.

- **The module is pure and stays that way.** It takes a document list and
  returns sections; it never reads a directory itself. That is what the
  `layer:domain` tag means here, and it is also what makes every rule below
  testable without a fixture tree. Reading the filesystem belongs to whoever
  calls this — today the site's build step.
- **Four refusals, one failure mode.** `buildNav` throws on a section the tree
  has but the order does not, on a section the order declares but the tree
  lacks, and on a document at the tree root; `groupVariants` throws on a
  translation whose canonical did not travel with it. All four close the same
  hole: a docs site does not fail by crashing, it fails by publishing a page
  nobody can reach — and no reader reports a page they do not know exists.
  Widening any of them to a warning reopens it, because a warning in a build log
  is a page nobody reads either. They are only worth having while they are on
  the build path: `doctrine-site` calls both, and each refusal has been seen to
  fail that build.
- **A document that `overview/index.md` does not route to is not published, it
  is stranded.** Adding a page to this tree means adding its row to the corpus
  map in the same pass; `check-doctrine` refuses the tree otherwise. It is the
  content-side twin of `buildNav`'s refusals: a docs site does not fail by
  crashing, it fails by carrying a page nobody can reach, and nobody reports a
  page they do not know exists. Only that direction is gated here — a row
  pointing at a file that does not exist is already `check-doc-links`' answer,
  and whether the row still _describes_ the document stays on review.
- **A document the policy withholds is named, never omitted.** Its inventory row
  carries no link and the marker `(withheld)` instead — a positive
  statement that the document exists and is not published here. Absence would
  say the same thing as an oversight, and a reader has no way to tell those
  apart, which is why the marker is gated rather than left to habit. The gate
  finds that table by the one property no other table in the map has — links
  into this tree in its first column — so renaming a heading never turns the
  check off.
- **A translation is the same document, not a second one.** `groupVariants`
  collapses `<name>.<lang>.md` onto `<name>.md` so one specification never
  appears once per language in the navigation; the translation is still returned
  because it is still a page, one the canonical's own page offers. The published
  languages arrive as an argument for the reason the section order does —
  `languages.config.json` settles them and this module cannot see it.
  `check-doctrine`'s `variantOf` is the same convention written a second time,
  and the duplication is accepted rather than overlooked: `dev-cli` is plain
  `.mjs` with no TypeScript toolchain and cannot import this module, and a
  cross-project source import would be an edge the Nx graph cannot see — the
  reason `languages.config.json` sits at the repo root in the first place. Both
  sides derive the language list from that one file, so what is duplicated is
  the filename shape and nothing else. Change the shape on one side and you have
  changed it on neither.
- **Section order is an argument, never a constant here.** It arrives from the
  caller alongside the tree. A section list baked into this module would be a
  claim about content this module cannot see, and the two-way check above is
  what keeps the caller's claim honest instead. Do not "helpfully" add a
  default.
- **Order inside a section is the caller's**, deliberately: reading order is a
  content decision. This module only guarantees it does not reshuffle.
- **Titles come from each document's own `# H1`**, with the file stem as
  fallback. Never introduce a title map — that is the second place to rename a
  heading, and it drifts the first time someone edits only the document.
- The Markdown is content and the `src/` modules are machinery; they share a
  project so that editing a document is a change `nx affected` can see. Neither
  half reads the other: the modules never open the tree, and no document names a
  module.
