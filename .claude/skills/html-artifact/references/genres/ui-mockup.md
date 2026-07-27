# Genre: ui-mockup

A mockup exists to let the reviewer _judge a UI at the sizes the real app will run at_. Two consequences:

1. The mockup itself must be a responsive implementation across the app's supported range — not one frozen desktop layout transcribed into HTML.
2. It always ships inside the viewport-preview harness (`templates/ui-mockup.html`): a toolbar with screen-size presets, custom size input, rotation, and scale-to-fit — so a 1920 px preview is still reviewable on a phone.

## Harness mechanics (already implemented in the template)

- One `<section class="vph">` is one self-contained mockup viewer: the script renders its toolbar + stage and picks up the `<template data-screen>` fragments _inside_ that section. Instance-scoped by design — a page may hold several viewers (hybrid pages, `references/hybrid.md`), each with its own screens and presets.
- Each screen/state lives in its own `<template data-screen="Name">` as a complete fragment (its own `<style>` + markup). With more than one template in a section, that section's toolbar automatically gains a screen switcher. The harness renders the active screen into an `<iframe srcdoc>`, so the mockup's media queries respond to the _preset_ width, not the reviewer's window.
- `SIZES` at the top of the script defines the default preset buttons: `{ label, w, h }` entries plus one `{ label: 'Fit', fit: true }` free-flow mode. A section overrides the default with `data-sizes='[…]'` (same shape, JSON) when its mockup targets a different range; `data-title` labels the toolbar.
- When a preset is wider than the reviewer's screen, the frame scales down (`transform: scale`) and the toolbar shows the zoom %. Layout stays true; only rendering shrinks. The `1:1` toggle switches to actual size with scrolling — for inspecting detail on a small screen.
- The artifact theme toggle is mirrored into the iframe automatically; the mockup must use the same token plumbing as everything else.
- Design tokens are duplicated inside the mockup fragment **on purpose** (the iframe is a separate document) — keep shell and fragment tokens in sync.

## Choosing SIZES — a product decision, not a default

Preset widths come from two vocabularies, never an arbitrary width. Desktop/web widths snap to the workspace breakpoint scale (`references/responsive.md`, source of truth `shared/libs/core-ui/tailwind.preset.js`): sm 640 · md 768 · lg 1024 · xl 1280 · 2xl 1536 · 3xl 1920 (FHD) · 4xl 2560 (QHD) · 5xl 3440 (ultrawide). Phone/tablet presets use real device viewports instead (360×740, 390×844, 430×932, 768×1024…) — devices, not breakpoints, define those. Not every app supports the whole scale; the presets are exactly the app's declared range, no more, no less.

- **Desktop app**: the app's declared minimum, 1–2 common sizes, and its declared maximum. Example for an app supporting lg→5xl: 1024×640 (min), 1280×800, 1920×1080 (FHD), 2560×1440 (QHD), 3440×1440 (max, ultrawide). Mark min/max in the button labels.
- **Responsive web**: 360×740, 768×1024, 1024×768, 1536×864, 1920×1080 — extend to 2560/3440 only if the design actually addresses those widths.
- **Mobile app / mobile web**: 360×740 (small Android), 390×844 (iPhone), 430×932 (large phone), plus tablet if supported.

If the supported range is unknown, ask — do not silently ship generic presets for a desktop app.

**Ecoma app mockups**: the mockup fragment uses Alloy tokens (`shared/libs/core-ui/src/styles/tokens.css`) as its palette, and core-ui is deliberately single-theme (no runtime dark/light switch) — so the _fragment_ stays in that one theme (a deliberate choice, per artifact-design), while the harness shell around it still themes both ways.

## Mockup content rules

- Real content, real labels, real states (per `artifact-design`) — a mockup full of lorem tests nothing.
- State variants that matter (empty, loaded, error) are separate `data-screen` templates — reviewers flip between them with the toolbar switcher — never prose descriptions.
- Distinguish app chrome (bars, nav) from content. Chrome behavior across sizes — sidebar collapse, overflow menus — is exactly what the reviewer needs to see: implement it, don't annotate it.

## Done means

Every preset in `SIZES` was actually rendered and looks intentional — no clipped panels, no overlapping text, chrome adapts. One broken preset = not done (Rule 11).
