---
name: onboard
description: >
  Generate an onboarding map of THIS workspace that answers two questions on a
  temporal axis: what does the end-state look like (from doctrine), what exists
  today (from Nx graph), where are we on the roadmap (from doctrine + git log).
  Produces either a prose summary or a full HTML artifact. Use whenever the user
  asks to onboard, understand the repo, "what is the end-state architecture",
  "what is the current state", "how is the roadmap going". Args: `day` | `week`
  (default) | `month` | `since=<git date>` | `--mode prose|artifact` (default
  artifact). Answers the two real onboarding questions at once: what is the end
  state, where are we now, and how are we getting there.
---

# Onboard map (Ecoma)

Pays down "knowledge debt" — the gap that opens when the repo grows faster than
a human can keep up. **Generated fresh on every run**, never committed, so it
can never rot.

## Separation of concerns by data nature

| Panel                       | Source of truth                                                       | Nature                                         |
| --------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| **1. Target Architecture**  | Doctrine (`shared/libs/doctrine/`) — north stars, specs, system shape | **Judgment** — read prose, summarise end state |
| **2. Current Architecture** | Nx graph (`nx graph --file`) or `project.json` fallback               | **Deterministic** — edges/tags, no invention   |
| **3. Roadmap Progress**     | Doctrine roadmap + git log                                            | **Deterministic facts + judgment**             |
| **4. Reserved Seams**       | `*/CLAUDE.md` prose                                                   | **Judgment** — what is deliberately not built  |

Rule 5 governs: structure and history are **derived by code** via `.mjs`
scripts; the model's only creative work is reading doctrine prose, reserved
seams, and rendering the narrative.

The `.mjs` scripts live in `shared/tools/onboard/src/`:

- `doctrine-reader.mjs` — reads end-state architecture, system shape, milestones
- `nx-reader.mjs` — reads Nx graph, groups by scope/type/layer
- `git-reader.mjs` — reads git log with temporal LOD (accepts `--window=<arg>`)
- `report-builder.mjs` — orchestrates all three, outputs unified JSON

## How to run

```bash
# Full report as JSON (for consumption by this skill):
node shared/tools/onboard/src/report-builder.mjs --window=week

# Or run individual readers:
node shared/tools/onboard/src/doctrine-reader.mjs
node shared/tools/onboard/src/nx-reader.mjs
node shared/tools/onboard/src/git-reader.mjs --window=week
```

## Mode selection

The skill supports **two output modes**, chosen by the user or defaulting to
artifact:

- **Prose** (`--mode prose`): a plain-text summary suitable for terminal output
- **Artifact** (`--mode artifact`, default): a full HTML artifact with visual
  diagrams

## Report structure (prose output)

When rendering as prose, describe the following in natural language:

### 1. Target Architecture (end state)

Read the output of `doctrine-reader.mjs` and summarise:

- **Vision**: one-sentence end state from the North Star
- **System shape**: the 3 vertical domains (Platform, RPA, Hub) + 2 horizontal
  layers (EE, Cloud), and how they connect
- **Principles**: the 4 mechanism principles
- **Invariants**: the 5 invariants
- **Primitives**: Role, Task, Checkpoint, Handoff, Escalation + Composition
- **Layers**: the 5 product layers (Core → Agent → Human → Design → Intelligence)
- **Milestones**: M0–M7, what each delivers, any freezes passed

Keep it tight — 3–5 paragraphs max. State what the system will be when done.

### 2. Current Architecture (today)

Read the output of `nx-reader.mjs` and summarise:

- **Scope groups**: which subsystems exist, how many projects each
- **Types**: apps vs libs vs e2e
- **Layers**: what layers are present (domain, port, adapter, view, util)
- **Source**: whether data came from live `nx graph` or `project.json` fallback

Contrast with the target: what's been built vs what's still prose.

### 3. Roadmap Progress

Read the output of `report-builder.mjs` (which combines doctrine + git):

- **Where we are**: which milestone the churn clusters around, which freeze
  gates are passed
- **Churn hotspots**: the top subsystems by commit count in the focus window,
  and whether they map to current roadmap priorities
- **Known gaps**: from `overview/index.md`'s declared gaps
- **Rhythm** (git bands): total commits, first commit, top authors, recent
  activity grouped by subsystem/mechanism

### 4. Reserved Seams

Read `*/CLAUDE.md` files and capture what's deliberately not built yet:

- **Reserved leaves**: subsystem dirs with no `project.json`
- **Named seams**: what each subsystem's CLAUDE.md says is deferred
- Link each to its owning `CLAUDE.md`

## Report structure (artifact output)

When rendering as an HTML artifact, produce a single self-contained page with
four clearly separated panels in order: **Target Architecture → Current
Architecture → Roadmap Progress → Reserved Seams**. Design notes:

- **One source of truth per panel** — do not blur deterministic panels with
  narrative ones
- **Target Architecture**: show the 3-domain system shape as a visual diagram,
  list principles, invariants, primitives, layers. Use the doctrine prose;
  never invent structure
- **Current Architecture**: leaf-grouped boxes, core-outward layer order,
  cross-leaf edges only at the `shared` seam; reserved leaves as dashed ghosts.
  A Mermaid `flowchart`/`graph` is fine for the Context view; keep it grouped
  with `subgraph` per leaf
- **Roadmap Progress**: a visual timeline showing M0–M7 with the current
  position highlighted, freeze gates marked, churn hotspots overlaid
- **Reserved Seams**: dashed/ghost boxes for what's deliberately not built,
  with reason labels
- Theme-aware (light/dark), responsive, wide diagrams scroll inside their own
  container
- Title: "Ecoma — onboarding map (last <window>)"
- Stable favicon
- State the generation basis at the foot: "Target architecture from doctrine;
  current structure from live `nx graph`; rhythm from `git log` as of <SHA>;
  reserved seams from CLAUDE.md"
- Do **not** commit the artifact or any temp JSON into the repo

### Loading the scripts in the artifact mode

```bash
# Step 1: Gather all data
node shared/tools/onboard/src/report-builder.mjs --window=week > /tmp/onboard-report.json

# Step 2: Read it
const report = JSON.parse(fs.readFileSync("/tmp/onboard-report.json", "utf8"));
```

Then build the artifact from `report`.

## Temporal level-of-detail (git window)

Same ladder as before — applies only to the git rhythm portion:

| arg                  | Band C — focus (detailed) | Band B — context                         | Band A             |
| -------------------- | ------------------------- | ---------------------------------------- | ------------------ |
| `day` (daily report) | last 24h                  | last 7 days                              | all-time, one line |
| `week` (default)     | last 7 days               | last 30 days                             | all-time, one line |
| `month`              | last 30 days              | last 90 days                             | all-time, one line |
| `since=<expr>`       | since `<expr>`            | next coarser span (or all-time if young) | all-time, one line |

The git window drives `git-reader.mjs --window=<arg>`.

## Editions

This is the contributor edition: its trajectory section reads the published
roadmap, which deliberately withholds its unlock thresholds and its map of
weak points. The private cloud workspace shadows this skill with an owner
edition that reads the withheld halves beside these — same method, whole
corpus.
