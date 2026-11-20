# Upstream provenance — security-audit skill

This directory vendors [`cloudflare/security-audit-skill`](https://github.com/cloudflare/security-audit-skill). The upstream methodology is preserved verbatim; Ecoma-specific integration lives only in the overlay section at the end of [`SKILL.md`](SKILL.md).

## Pinned revision

- Repository: https://github.com/cloudflare/security-audit-skill
- Pinned commit: `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`
- Commit subject: "Clarify guidance and full audit modes" (2026-09-14)
- Branch pinned: `main` (default branch, single branch, 14 commits at pin time)
- License: MIT — Copyright (c) 2025-2026 Cloudflare, Inc. (preserved in [`LICENSE`](LICENSE))
- Verification at vendoring time: upstream `git ls-remote origin HEAD` resolved to the pinned SHA, and every vendored file was byte-identical to `skills/security-audit/` at that revision.

The task brief that triggered this vendoring quoted `1bd344f714ab981da20bef789b38481d07d64ce0` as the inspected upstream tree. That SHA does **not** exist in the upstream repository; it is a commit of the Ecoma repository itself (`1bd344f7 ci: merge semgrep and gitleaks into a single security-analysis job (#525)`). It is recorded here to prevent it from being mistaken for an upstream pin later.

## Vendored file manifest

Copied from upstream `skills/security-audit/` at the pinned commit (byte-identical except where noted):

| Vendored file                             | Upstream path                                                   | Local modifications                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SKILL.md`                                | `skills/security-audit/SKILL.md`                                | **Modified**: the upstream text (lines 1–192) is untouched; an Ecoma integration overlay is appended after it, starting at the `## Ecoma integration overlay` heading. |
| `RECONNAISSANCE.md`                       | `skills/security-audit/RECONNAISSANCE.md`                       | none                                                                                                                                                                   |
| `HUNTING.md`                              | `skills/security-audit/HUNTING.md`                              | none                                                                                                                                                                   |
| `ATTACK-CLASSES.md`                       | `skills/security-audit/ATTACK-CLASSES.md`                       | none                                                                                                                                                                   |
| `VALIDATION-AND-REPORTING.md`             | `skills/security-audit/VALIDATION-AND-REPORTING.md`             | none                                                                                                                                                                   |
| `AI-AND-LLM.md`                           | `skills/security-audit/AI-AND-LLM.md`                           | none                                                                                                                                                                   |
| `WEB-PROTOCOL-AND-AUTH.md`                | `skills/security-audit/WEB-PROTOCOL-AND-AUTH.md`                | none                                                                                                                                                                   |
| `CLIENT-SIDE.md`                          | `skills/security-audit/CLIENT-SIDE.md`                          | none                                                                                                                                                                   |
| `SUPPLY-CHAIN-AND-RELEASE.md`             | `skills/security-audit/SUPPLY-CHAIN-AND-RELEASE.md`             | none                                                                                                                                                                   |
| `CLOUD-AND-DEPLOYMENT.md`                 | `skills/security-audit/CLOUD-AND-DEPLOYMENT.md`                 | none                                                                                                                                                                   |
| `PROTOCOLS-RPC-AND-MESSAGING.md`          | `skills/security-audit/PROTOCOLS-RPC-AND-MESSAGING.md`          | none                                                                                                                                                                   |
| `RESOURCE-EXHAUSTION-AND-AVAILABILITY.md` | `skills/security-audit/RESOURCE-EXHAUSTION-AND-AVAILABILITY.md` | none                                                                                                                                                                   |
| `DATA-ISOLATION-AND-LIFECYCLE.md`         | `skills/security-audit/DATA-ISOLATION-AND-LIFECYCLE.md`         | none                                                                                                                                                                   |
| `DESKTOP-MOBILE-AND-LOCAL-IPC.md`         | `skills/security-audit/DESKTOP-MOBILE-AND-LOCAL-IPC.md`         | none                                                                                                                                                                   |
| `MEMORY-SAFETY-AND-BINARY.md`             | `skills/security-audit/MEMORY-SAFETY-AND-BINARY.md`             | none                                                                                                                                                                   |
| `report-schema.json`                      | `skills/security-audit/report-schema.json`                      | none                                                                                                                                                                   |
| `validate-findings.cjs`                   | `skills/security-audit/validate-findings.cjs`                   | none (upstream executable bit kept)                                                                                                                                    |
| `validate-findings.test.cjs`              | `skills/security-audit/validate-findings.test.cjs`              | none                                                                                                                                                                   |
| `validate-coverage-ledger.cjs`            | `skills/security-audit/validate-coverage-ledger.cjs`            | none (upstream executable bit kept)                                                                                                                                    |
| `validate-coverage-ledger.test.cjs`       | `skills/security-audit/validate-coverage-ledger.test.cjs`       | none                                                                                                                                                                   |

Files not under upstream `skills/security-audit/`:

| Vendored file        | Upstream path           | Purpose                                                                                               |
| -------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `LICENSE`            | `LICENSE` (repo root)   | MIT license text, preserved verbatim as vendoring requires.                                           |
| `UPSTREAM-README.md` | `README.md` (repo root) | Upstream overview, preserved under a renamed file to keep this directory's entry point as `SKILL.md`. |

Ecoma-authored files in this directory (not upstream content): this `UPSTREAM.md`, and the overlay section inside `SKILL.md`.

## Update procedure

1. Never follow upstream `main` implicitly. Upstream moves independently; a newer `main` commit is never adopted by default.
2. To sync, a work item must explicitly select a target upstream commit, verify it (`git ls-remote` + clone + `git rev-parse`), and record it here with its subject and date.
3. Copy the updated `skills/security-audit/` files over this directory, then re-apply the Ecoma overlay to the end of `SKILL.md` and re-check this manifest table (upstream may add, rename or remove companion files; `SKILL.md` and `HUNTING.md`/`VALIDATION-AND-REPORTING.md` carry an identical-fenced-block invariant between them — do not fork-edit upstream prose to "fix" drift).
4. Preserve `LICENSE` (replace only with the updated upstream license text if upstream changes it) and refresh `UPSTREAM-README.md`.
5. Re-run the validation commands from the overlay and the repository checks (`pnpm dx repo-prepare`, twice, second run idempotent) before committing, with the new pinned SHA recorded in the commit message.
6. Any change that weakens an upstream safety control is not a sync — stop and report instead.
