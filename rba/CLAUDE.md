# rba — area mechanics

The RPA area. One project today, `apps/rba-desktop`, and a hard rule about
what may join it.

## The gate that decides what belongs here

**No RPA mechanism lands in this area until ◆G0 freezes the Filler interface
and the Session effect.** That is not a style preference and not a sequencing
convenience — it is the entry condition the roadmap states for this track, and
the reason is mechanical: a driver written against an unfrozen Filler interface
becomes a second implementation of it, and every RPA specification here is
built on there being exactly one.

So when a change proposes to add a driver, a perception layer, a session
store, or credential handling to this tree, the first question is not "is the
code good" but "has the freeze happened". If it has not, the change belongs in
a specification, not in this directory.

What may land before the freeze: shell, chrome, packaging, toolchain. Things
whose correctness does not depend on an interface that is still moving.

## The Rust lane runs from here

`apps/rba-desktop/src-tauri` is the workspace's only Rust crate, so it is also
the only thing exercising `cargo`, `clippy` and `rustfmt` in CI. Two
consequences worth knowing before touching it:

- **Breaking it silently disables the whole Rust lane.** If the crate stops
  building, nothing else fails — there is no second crate to notice. Treat a
  red `rba-desktop:lint` or `:test` as a toolchain outage, not one app's
  problem.
- **Clippy levels live in the workspace `Cargo.toml`**, inherited here through
  `[lints.clippy] workspace = true`. Add a level there, never in the crate — a
  second crate arriving later must inherit the same bar without anyone
  remembering to copy it.

## Building it needs system libraries that are not preinstalled

Tauri links against `webkit2gtk` and GTK on Linux, and needs their development
headers **even for `cargo check`**. A machine without them cannot compile this
crate at all, so `rba-desktop:lint` and `:test` failing with a `pkg-config`
error is an environment gap, not a code defect — say which of the two you are
looking at when you report a red lane, because reporting a missing header as a
code failure sends the next reader hunting in the wrong tree.

A cloud session **can** install them, and should: run `apt-get update` first
(without it the install hangs, which reads as "apt is unavailable here" and is
not), then `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev` and
`libayatana-appindicator3-dev`. Exact commands are in the project's own
`CLAUDE.md`. Proving a Rust change locally beats pushing to read CI: with
`clippy::pedantic` on, the round trip is one push per lint.

## Scope tag

`scope:rba` was created in the change that landed this area's first project,
which is the rule for every scope. It appears in three places that must stay
in step, and a value missing from any of them fails open rather than loud:
`require-project-tags.mjs`'s vocabulary, `eslint.config.mjs`'s
`depConstraints`, and each project's own `tags`.

The constraint is `scope:rba` may depend on `scope:rba` and `scope:shared`, and
nothing else. Reaching into `scope:platform` from here would couple the RPA
surface to engine internals it is supposed to consume through a frozen
interface.
