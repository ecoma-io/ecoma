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
- **Three refusals, one failure mode.** `buildNav` throws on a section the tree
  has but the order does not, on a section the order declares but the tree
  lacks, and on a document at the tree root. All three close the same hole: a
  docs site does not fail by crashing, it fails by publishing a page nobody can
  reach — and no reader reports a page they do not know exists. Widening any of
  the three to a warning reopens it, because a warning in a build log is a page
  nobody reads either.
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
- Markdown content lands here in its own change. Until it does, this project is
  the machinery and nothing else, and `doctrine-site` is what will read it.
