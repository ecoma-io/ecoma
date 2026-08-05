# `src/report/` — rendering violations

Empty. Nothing produces a violation yet, so there is nothing to render.

## What lands here

The formatters that turn violations into output, one per surface, sharing one
input. Each is a pure function from violation records to text or to a protocol
payload:

- a terminal report for `../../cli.mjs`, in the `file:line:column` shape an
  editor and a terminal both make clickable — which is why the analysis record
  carries 1-based positions (`../analysis/contract.md`);
- a machine-readable form for CI, so a failing job can be read without
  scraping a human report;
- LSP diagnostics for `../../lsp.mjs`, whose positions are 0-based — the
  conversion belongs here, in one place, rather than in the rule that found the
  violation.

## What must not land here

- **Any decision about whether something is a violation.** A formatter that
  filters is a rule wearing a formatter's name, and it will disagree with the
  rule engine the first time one of them changes.
- **A process exit code.** The exit-code table is `../../cli.mjs`'s contract
  and is documented in its header.
