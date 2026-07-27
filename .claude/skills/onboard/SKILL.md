---
name: onboard
description: Generate a beautiful, on-demand onboarding map of THIS workspace as an Artifact — subproject architecture (grouped C4-style by subsystem/project from the live Nx graph), where the reserved seams are, and the recent development rhythm (git history at a temporal level-of-detail over a window you choose: day, week, or month; old history stays compressed, the chosen window is detailed). Use whenever the user asks to onboard, understand the repo, "what is this codebase", "what changed recently", wants an architecture map, or wants a daily/weekly development digest. Args: `day` | `week` (default) | `month` | `since=<git date>`. Answers the two real onboarding questions at once: what is the shape, and where has it been moving.
---

# Onboard map (Ecoma)

Produces a **single Artifact** that pays down "knowledge debt" — the gap that opens when the repo grows faster than a human can keep up (especially when AI is doing the building). It is **generated fresh on every run**, never committed, so it can never rot: the structure comes from the live Nx graph, the rhythm from live git, and only the _why_ is read from prose.

The whole point is the **separation of concerns by data nature** — get this wrong and the map becomes a confident lie, which is worse than nothing for a reader who lacks the knowledge to catch it:

| Panel                 | Source of truth                   | Nature                                     | Your job                                              |
| --------------------- | --------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| **1. Architecture**   | Nx graph JSON (`nx graph --file`) | **Deterministic**                          | Read edges/tags, lay out — **never invent structure** |
| **2. Reserved seams** | `*/CLAUDE.md` prose               | **Judgment**                               | Read & summarize what is deliberately _not_ built     |
| **3. Rhythm**         | `git log`                         | **Deterministic facts → judgment summary** | Feed real git output, then compress into narrative    |

Rule 5 governs this skill: structure and history are **derived by code**, never guessed from memory; the model's only creative work is the reserved-seam read, the git narrative, and the visual layout.

## 1. Gather structure (deterministic — do not skip to memory)

Emit the Nx graph to JSON and parse it. This is the **only** trustworthy source of the dependency edges:

```bash
pnpm nx graph --file=/tmp/onboard-graph.json
```

Then extract nodes, tags, and edges (the schema is stable: `graph.nodes[name].data.{root,tags}`, `graph.dependencies[name] = [{source,target,type}]`):

```bash
node -e '
const g = require("/tmp/onboard-graph.json").graph;
const nodes = Object.entries(g.nodes).map(([name, n]) => ({
  name,
  root: n.data.root,
  tags: n.data.tags || [],
  scope: (n.data.tags || []).find(t => t.startsWith("scope:"))?.slice(6) || "?",
  type:  (n.data.tags || []).find(t => t.startsWith("type:"))?.slice(5)  || "?",
  layer: (n.data.tags || []).find(t => t.startsWith("layer:"))?.slice(6) || null,
}));
const edges = Object.entries(g.dependencies).flatMap(([src, ds]) =>
  ds.filter(d => !d.target.startsWith("npm:")).map(d => ({ from: src, to: d.target, type: d.type })));
console.log(JSON.stringify({ nodes, edges }, null, 2));
' > /tmp/onboard-structure.json
```

**Fallback if `nx` is not installed** (fresh container, deps not restored): parse every `project.json` directly for `name` + `tags` — that still gives you all nodes and their leaf/layer grouping. You will **not** have real dependency edges this way; say so plainly in the artifact (Rule 11 — never draw guessed edges as if they were real). Prefer running `pnpm install` first if the task warrants live edges.

### Group by the repo's own taxonomy — this is what tames the mess at scale

Do not render N projects flat (that is exactly the messy `nx graph` the user is escaping). Use the tags to build a **C4 hierarchy**:

- **`scope:`** = the subsystem → the top-level grouping box (today only `shared` has a real directory; `eslint.config.mjs` already reserves a `scope:connectors` depConstraint for a product domain that hasn't landed yet — a product domain gets its own `scope:` tag, and directory, the day it takes root).
- **`type:`** = `app` (the standalone shell) · `lib` · `e2e`.
- **`layer:`** = hexagonal position: `domain` (headless core) → `port` (seam contract) → `adapter` → `view`, with `util` at the bottom. Lay layers out core-outward so the "headless core + shells" shape reads visually.
- **Cross-subsystem edges** only ever go **into `shared`** — that is the enforced leaf-independence boundary (`@nx/enforce-module-boundaries` in `eslint.config.mjs`: `scope:shared` may depend only on itself; a product domain's own scope constraint is added the day it takes root, constrained to its own libs plus `scope:shared`). Draw a subsystem→subsystem edge that isn't via shared as a **violation flag**, not a normal line — it would mean the boundary broke.

Default view is **Context** (leaves + cross-leaf edges at the seam only). Offer Container zoom (libs within one leaf, layer-ordered) as a second view, not crammed into the first.

## 2. Reserved seams (judgment — read the prose, the graph can't show these)

The most important thing a newcomer misses: **what is deliberately _not_ built yet.** Reserved seams have no node or edge in the Nx graph _by design_ — they live only in `CLAUDE.md` prose. You must read them, not derive them:

- **Reserved leaves** — a subsystem dir with only a `CLAUDE.md` and no `project.json` (none exist in the current tree, but the pattern recurs whenever a leaf is sketched ahead of being built). Show it as a ghost/dashed box: named, reserved, not built.
- **Reserved seams inside built subsystems** — read the root `CLAUDE.md` and each subsystem's own `CLAUDE.md` for what's deliberately not built. Capture the named-but-unhardened seams (a capability-graph seam hardened only at a 2nd consumer, an organizational-tier contract hardened field-by-field under its real consumer, reserved release seams: Windows/macOS signing, auto-update feed, agent-in-ecosystem shell). Summarize _why reserved_ in one line each — the process-first / reserved-seam discipline is the single hardest thing to infer from code.

This panel is what turns a structure diagram into an **understanding** of the architecture's intent. Keep it tight; link each item to the `CLAUDE.md` that owns it.

## 3. Development rhythm (deterministic facts, temporal level-of-detail)

Answer "where has it been moving" — the churn hotspots _are_ the knowledge-debt hotspots. Use a **temporal LOD**: three bands, coarse→fine, **centered on the window the user asked for**. The arg picks the _focus_ band (Band C); the other two scale relative to it, so the same skill serves a daily digest and a monthly onboarding without changing shape.

**Resolve the window ladder** (default `week`; also accept a raw `since=<git date expr>` for a custom range):

| arg                  | Band C — focus (detailed) | Band B — context                         | Band A             |
| -------------------- | ------------------------- | ---------------------------------------- | ------------------ |
| `day` (daily report) | last 24h                  | last 7 days                              | all-time, one line |
| `week` (default)     | last 7 days               | last 30 days                             | all-time, one line |
| `month`              | last 30 days              | last 90 days                             | all-time, one line |
| `since=<expr>`       | since `<expr>`            | next coarser span (or all-time if young) | all-time, one line |

Then feed real git output — never summarize commits from memory. Set the two spans once from the row and reuse them:

```bash
FOCUS='1 week ago'; CONTEXT='1 month ago'   # <- set from the ladder (day: '1 day ago' / '1 week ago'; month: '1 month ago' / '3 months ago')

# Band A — all-time, maximally compressed (always one line, whatever the window)
git log --oneline | wc -l                              # total commits
git log --reverse --format='%ad %s' --date=short | head -1   # first commit / origin
git shortlog -sn --all | head -10                       # who built it

# Band B — context span, medium detail (subjects only)
git log --since="$CONTEXT" --date=short --pretty='%ad %s'

# Band C — focus span, full detail: what moved, per leaf
git log --since="$FOCUS" --stat --pretty='%h %ad %s' --date=short
git log --since="$FOCUS" --name-only --pretty=format: | grep -v '^$' \
  | sed -E 's#^([^/]+)/.*#\1#' | sort | uniq -c | sort -rn   # churn per top-level subsystem
```

Then the **judgment** step (Rule 5): compress this into narrative — _what changed and why it matters_, grouped by subsystem/mechanism, **not** a commit dump. "This week `core-ui` gained a new primitive; new lib `dev-cli`-adjacent tooling landed" beats "Tuesday had 3 commits". Neutralize the bands to the window: Band A → one line always; Band B → a few bullets; Band C → the detailed section. **At `day` granularity commit volume is small — Band C may list the actual commits grouped by subsystem (a standup digest); at `month`, always collapse to themes.** Anchor by subsystem/lib, not by date. If the focus span has **zero** commits (e.g. `day` over a quiet weekend), say so plainly — never pad an empty window (Rule 11).

## 4. Render the Artifact

**Load the `artifact-design` skill first** to calibrate design investment, then build **one** self-contained HTML artifact (the `Artifact` tool) with three clearly separated panels in order: **Architecture → Reserved seams → Rhythm**. Design notes:

- One source of truth per panel (§ table) — do not blur the deterministic panels with the narrative one.
- Architecture: leaf-grouped boxes, core-outward layer order, cross-leaf edges only at the `shared` seam; reserved leaves as dashed ghosts. A Mermaid `flowchart`/`graph` is fine for the Context view; keep it grouped with `subgraph` per leaf.
- Theme-aware (light/dark), responsive, wide diagrams scroll inside their own container.
- Title it for the repo + window (e.g. "Ecoma — onboarding map (last week)"). Stable favicon (e.g. 🗺️).
- State the generation basis at the foot: "Structure from live `nx graph`; rhythm from `git log` as of <the commit SHA you read>; reserved seams from CLAUDE.md" — so the reader knows it's derived, not hand-drawn, and how fresh.

Deliver the artifact URL. Do **not** commit the artifact or any temp JSON into the repo — this map is ephemeral by design; its whole value is being regenerated fresh, never a stale file to drift.
