# `src/report/` — rendering violations

The formatters that turn violations into output, one per surface, sharing one
input. Each is a pure function from violation records to text or to a protocol
payload:

- `text.mjs` — the terminal report for `../../cli.mjs`, in the
  `file:line:column` shape an editor and a terminal both make clickable — which
  is why the analysis record carries 1-based positions
  (`../analysis/contract.md`);
- `sarif.mjs` — SARIF 2.1.0 for CI, so a failing job can be read without
  scraping a human report, and so GitHub can annotate the diff. Validated
  against the published schema rather than eyeballed: a file GitHub silently
  rejects leaves the job green with no annotations and no reason given.

## What lands here next

LSP diagnostics for `../../lsp.mjs`, whose positions are 0-based — the
conversion belongs here, in one place, rather than in the rule that found the
violation.

## The two formats say the same thing in different places

The terminal report puts the constraint row that fired on its own line; SARIF
appends it to `message.text`, because GitHub renders that field and nothing
else. Both carry the upstream `messageId` unchanged — SARIF as `ruleId`, text
as the first line — since that id, not the prose, is what makes a verdict
comparable to ESLint's.

## What must not land here

- **Any decision about whether something is a violation.** A formatter that
  filters is a rule wearing a formatter's name, and it will disagree with the
  rule engine the first time one of them changes.
- **A process exit code.** The exit-code table is `../../cli.mjs`'s contract
  and is documented in its header.
