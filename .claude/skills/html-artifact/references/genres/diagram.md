# Genre: diagram

Architecture, flows, sequences, ERDs.

- Prefer native mermaid — ` ```mermaid ` fences in markdown artifacts, `<pre class="mermaid">` in HTML. No libraries needed, and theming is handled. Caveat: mermaid renders **only in the Artifact viewer** — a file delivered standalone (SendUserFile, saved to disk) shows raw text; use inline SVG when the deliverable is a file.
- Diagrams are intrinsically wide: every diagram lives in the pan/zoom stage (template) or at minimum an `overflow-x: auto` container. The page body never scrolls sideways.
- On phones, `flowchart TD` (top-down) reads far better than `LR` — choose orientation for the narrow case; wide screens tolerate both.
- Custom SVG: set `viewBox` with fluid width; generate coordinates with a small inline script rather than hand-authoring long path data.
- Big graphs: one overview diagram plus per-area detail diagrams beats one giant graph. Label edges sparingly.
- Add a legend when node shapes or colors carry meaning; verify both themes.

## Template

`templates/diagram.html` — a mermaid block plus a pan/zoom stage (pointer drag, wheel/pinch zoom, and +/−/reset buttons — the buttons matter on mobile).
