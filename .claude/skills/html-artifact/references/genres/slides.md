# Genre: slides

Decks that must work both projected on a desktop and scrolled on a phone.

- One `<section class="slide">` per slide in a vertical scroll-snap deck. On a phone it degrades to natural scrolling — that is a feature, keep it.
- Navigation: keyboard ←/→/space/PageUp/PageDown, on-screen prev/next buttons (≥44 px — they are the mobile navigation), and a slide counter.
- Slide text scales with `clamp()`. Never absolute-position text to fixed coordinates — it shears at other aspect ratios.
- One idea per slide; if a slide needs `overflow-y`, it is two slides.
- Slides are `min-height: 100svh` (not `vh` — the mobile URL bar).
- Respect `prefers-reduced-motion`: smooth scrolling becomes instant.

## Template

`templates/slides.html` — snap deck, HUD navigation, counter, keyboard wiring.
