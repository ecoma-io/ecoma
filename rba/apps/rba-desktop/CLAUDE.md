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
