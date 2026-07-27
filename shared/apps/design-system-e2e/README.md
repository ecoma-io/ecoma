---
name: design-system-e2e
subsystem: shared
lang: en
description: Blocking Playwright gate over the design-system app's built Storybook — axe accessibility, the design-token contract, and palette conformance — plus a story-index smoke check.
---

> 🌐 **English** · [Tiếng Việt](./README.vi.md) · [中文](./README.zh.md)

# design-system-e2e

The e2e suite for the `design-system` app's Storybook, which renders
`core-ui`'s stories. It has its own Nx project because this workspace's test
taxonomy forbids co-locating e2e tests with the code under test — see root
`CLAUDE.md`.

<!-- readme:why -->

## Why it exists

The `design-system` Storybook shows a live accessibility panel while you develop, but
a panel is advisory — nothing stops a violation from shipping unless a build
step fails on it. This suite is that step: it scans the **built** Storybook
(`storybook-static`), not the source, because a violation the build itself
introduces — a dropped stylesheet that collapses contrast, an asset that
404s — is invisible to any scan run against source. Scanning the artifact an
operator would actually open is the point.

The same reasoning reaches past accessibility. `tokens.css` states its design
laws in prose — the elevation rhythm `--sunken` < `--background` < `--card`,
the focus ring being the Human force, `--seam` running from `--primary` to
`--agent` — and several of them are held together by literals that restate
another token's value instead of referencing it, so retuning one force left
the others silently pointing at the old colour and nothing failed. This suite
also resolves every token in the built artifact and checks those laws, and
sweeps every story for a colour no token defines. Both need a real browser:
jsdom resolves neither `var()` nor `hsl()`, so the unit tier could only
compare strings copied from the very file it is meant to be checking.

<!-- readme:consumers -->

## Who consumes it

CI and every developer landing a change to `core-ui` or the `design-system`
app, through `pnpm nx run design-system-e2e:e2e` (part of the definition of
done, root `CLAUDE.md`). It is the thing that actually blocks a WCAG violation
from merging; the dev-time a11y panel only surfaces the same class of issue
interactively, it does not gate anything.

<!-- readme:ecosystem -->

## Where it sits

Tagged `type:e2e`, `scope:shared`, with
`implicitDependencies: ["design-system", "core-ui", "dev-cli"]`.
It imports `WCAG_TAGS` from `@ecoma-io/ui/a11y` rather than restating the WCAG
2.0/2.1 A/AA tag scope, so the interactive panel and this blocking gate can
never disagree about what counts as a violation. The list of stories to scan
is never hand-maintained: it is read from the built Storybook's own
`index.json`, so a new primitive is covered the moment its story exists and
a removed one drops out on its own. Each story is scanned as its own test,
so a regression spanning several of them reports every one. That derivation has one
blind spot, and `lint` closes it: a component with no story produces no index
entry at all, so `check-e2e-story-coverage` holds every component in
`core-ui/src` to owning one. Runs via
`pnpm nx run design-system-e2e:e2e`, which goes through `dev-cli run-e2e` (handles
`xvfb` on Linux and the Chromium provisioning shim); available targets are
`lint`, `typecheck`, `e2e`.

<!-- readme:boundary -->

## What it deliberately does not do

It does not unit-test components — that is `core-ui`'s own `test` target,
running in jsdom. It does not test any product application; this suite's
only subject is the `design-system` app's Storybook.

<!-- readme:status -->

## Status

Covers three blocking gates — the axe accessibility sweep, the design-token
contract, and palette conformance — plus a smoke check that the built
Storybook serves its story index. It is the first `type:e2e` project in the
workspace. Mechanics — why the WCAG scope is imported rather than restated,
why the preview server bypasses Nx, why each story is scanned as its own
test, and why a token has to be probed on a fresh element every time — live
in [`./CLAUDE.md`](./CLAUDE.md).
