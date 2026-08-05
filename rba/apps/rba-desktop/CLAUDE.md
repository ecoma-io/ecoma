# rba-desktop — mechanics

The workspace's only Rust crate, wrapped in a Tauri window. Small, and
load-bearing for a reason that has nothing to do with its size.

## Read this before reporting a red lane

Tauri links `webkit2gtk` and GTK on Linux and needs their **development
headers to `cargo check`, not just to build**. A machine without them fails
before compiling a single line of this crate's own code.

So a red `rba-desktop:lint` or `rba-desktop:test` is one of two very different
things, and saying which is part of the report:

| Symptom                                                        | What it is      | What to do                  |
| -------------------------------------------------------------- | --------------- | --------------------------- |
| `pkg-config` cannot find `webkit2gtk-4.1` / `gtk+-3.0`         | environment gap | install the headers (below) |
| `clippy` / `rustc` diagnostics naming files under `src-tauri/` | a code defect   | fix it                      |

**Install them; do not settle for CI as the proof.** A cloud sandbox does not
ship them, but it can fetch them — the failure that looks like "apt is
unavailable here" is usually just an empty package list:

```sh
apt-get update        # without this, the install below hangs and then fails
apt-get install -y --no-install-recommends \
  libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev
```

This matters more than it looks. Pushing to read CI costs a round trip per
mistake, and `clippy::pedantic` is on: the first two defects here were
`semicolon_if_nothing_returned` and `missing_panics_doc`, one per push, both
of which a local run reports in seconds. If the headers genuinely cannot be
installed, then say the Rust half is unproven rather than implying it passed
— claiming a build you did not run is exactly the failure Rule 11 names.

## Breaking this crate silently disables the Rust lane

There is no second Rust crate. If this one stops compiling, `cargo`, `clippy`
and `rustfmt` stop being exercised anywhere in the workspace, and nothing else
turns red to say so. That is the whole reason the project exists, so treat its
red as a toolchain outage rather than one app's problem.

## The RUSTSEC wall is one dependency, and the fix is upstream's

`cargo audit` and OpenSSF Scorecard both report seventeen RUSTSEC findings
against this crate — sixteen `unmaintained`, one `unsound`. That is one
problem, not seventeen: `tauri` is this crate's only direct dependency, and
every finding arrives through it.

| Finding group                         | Reaches us via                                            |
| ------------------------------------- | --------------------------------------------------------- |
| gtk3-rs is archived (ten crates)      | `tao` / `wry` / `muda` — Tauri's Linux window and webview |
| `proc-macro-error` is unmaintained    | `glib-macros` ← `glib` ← gtk3-rs                          |
| five `unic-*` crates are unmaintained | `urlpattern` ← `tauri-utils`                              |
| `glib::VariantStrIter` is unsound     | `glib` ← gtk3-rs                                          |

Sixteen have no fixed version to move to — the crates are archived, so there is
nothing to upgrade into. The seventeenth does have one, `glib >= 0.20.0`, and
Cargo still refuses it, because `gtk 0.18.2` requires `glib ^0.18` and Tauri
v2's Linux runtime requires gtk3. Two commands print that wall rather than
describing it:

```sh
cargo update -p glib --precise 0.20.0        # blocked by gtk 0.18.2's glib ^0.18
cargo update -p urlpattern --precise 0.4.0   # blocked by tauri-utils' urlpattern ^0.3
```

The second matters as much as the first: `urlpattern 0.4.0` is the release that
swapped the `unic-*` family for `icu_properties`, so it would clear five of the
sixteen on its own, and `tauri-utils` is the thing pinning us below it.

The `unsound` one is the only finding whose blast radius is checkable rather
than assumed. `glib::Variant::array_iter_str` is the sole public constructor of
the affected `VariantStrIter` (`VariantStrIter::new` is `pub(crate)`), so
grepping the resolved sources for `array_iter_str` answers whether anything we
ship can reach it — re-run that check before treating the advisory as inert.

The exit is a Tauri release off gtk3, tracked upstream at
[tauri-apps/tauri#12561](https://github.com/tauri-apps/tauri/issues/12561)
(move `tauri-runtime-wry` to gtk4-rs) and by the `tauri-cef` line that swaps
WebKitGTK for Chromium. Neither is consumable: crates.io carries no `tauri`
outside the 2.x line and no `tauri-cef` at all. Keep the dependency spelled
`tauri = "2"` — it already resolves to the newest 2.x, so a tighter pin buys no
newer transitive crate and costs the next patch release.

**Do not silence any of this.** A `deny.toml`, an audit allowlist, or an
`--ignore RUSTSEC-…` flag changes nothing about what ships, and removes the one
signal that would tell us the upstream move landed.

## Two manifests, one lint bar

`Cargo.toml` at the workspace root owns the lint bar — `unsafe_code = "forbid"`
and the clippy levels — and this crate takes all of it with
`[lints] workspace = true`. Raise the bar there. Writing levels into the crate
would work today and silently stop working the moment a second crate arrives
without them, which is the drift Rule 14 rung 2 is about.

Cargo's inheritance is all-or-nothing at the `[lints]` level: a crate cannot
cherry-pick the clippy half and keep its own `rust` half. That is why
`unsafe_code` sits in the workspace table rather than here. A crate that
genuinely needs `unsafe` — a native driver wrapper, one day — opts out by
writing its own `[lints]` table, which shows up in a diff as a decision
someone made.

## The dev port is fixed, and both sides say so

`vite.config.ts` sets `port: 6011` with `strictPort: true`, and
`tauri.conf.json`'s `devUrl` names the same port. `strictPort` is what makes
the pair honest: without it Vite silently moves to the next free port, the
desktop window opens on a dead URL, and the failure looks like a Tauri bug.
Change one and you must change the other.

## What may be added here, and what may not

**May**: window chrome, packaging, updater wiring, anything about being a
desktop application.

**May not**: a driver, perception, a session store, credential handling, a
Filler implementation — the ◆G0 freeze gates all of them, and the area
`CLAUDE.md` one level up states why. Also: business logic of any kind. If
something here is worth a test beyond `product_name`, it probably belongs in
a lib that other surfaces can consume.

## Targets

| Target      | Runs                                                                     | When         |
| ----------- | ------------------------------------------------------------------------ | ------------ |
| `lint`      | eslint, journey markers, `cargo fmt --check`, `cargo clippy -D warnings` | every change |
| `test`      | `cargo test`                                                             | every change |
| `typecheck` | `vue-tsc --noEmit`                                                       | every change |
| `build`     | `vite build` — the webview assets only                                   | every change |
| `bundle`    | `tauri build` — real installers                                          | release lane |

`bundle` is deliberately outside the per-change gates: it compiles a release
binary and runs the platform packagers, which costs minutes and proves
nothing a `clippy` run has not already proven about the code.
