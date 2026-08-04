import { expect, test as base, type Page } from "playwright/test";

import { builtStoryIds, latchStoryRendered, storyUrl, waitForStory } from "./storybook-preview";
import { colorTokenNames, declaredTokenNames, paintTokens, rawTokenValues } from "./token-probe";

/**
 * Holds every rendered story to the token palette.
 *
 * `core-ui`'s own guidance is "never hardcode colors, durations, or easings;
 * use Loom tokens" — and until this sweep, nothing enforced it. A
 * `text-[#3b82f6]` or a `bg-black/40` scrim compiles, renders, and passes both
 * the unit tier (jsdom resolves no colours) and the axe sweep (a hardcoded
 * colour with adequate contrast is perfectly accessible). It surfaces only as a
 * surface that stops following a retuned token, months later.
 *
 * One test per story, matching the a11y sweep: palette drift usually lands
 * across several stories at once, and seeing only the first hides the shape of
 * it. Measured across all built stories: zero off-palette colours on every
 * property below, so this ships as a hard assertion with no allowance list —
 * the first entry should be added only with a reason, the way
 * UPSTREAM_FOCUS_PATTERNS carries its two.
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER: SVG `fill` and `stroke`. Both are
 * inherited properties that compute on EVERY element — their initial value is
 * `black`, so a plain `<div>` reports `fill: rgb(0, 0, 0)` while painting
 * nothing, which is instrument error rather than a finding (measured: 718 of
 * them). Narrowing to SVG shapes leaves only the brand artwork in
 * `core-ui/docs/design/assets/*.svg`, which carries a FIXED brand palette on
 * purpose — a logo that re-tinted itself when `--primary` was retuned would be
 * the bug. Every icon the product renders paints with `currentColor`, so the
 * `color` check below already covers it. The uncovered case is therefore a
 * hardcoded fill on a non-brand SVG that ignores `currentColor`; there is no
 * such surface today, and it stays on review.
 */

const TOKEN_NAMES = declaredTokenNames();
const STORY_IDS = builtStoryIds();

const test = base.extend<{ scanPage: Page }>({
  scanPage: async ({ page }, use) => {
    await latchStoryRendered(page);
    await use(page);
  },
});

/** `rgb()`/`rgba()` reduced to its channels, which is the identity a token has. */
function paletteKey(computed: string): string | null {
  const match = computed.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return match ? `${match[1]},${match[2]},${match[3]}` : null;
}

for (const id of STORY_IDS) {
  test(`${id} paints only colours the token palette defines`, async ({ scanPage }) => {
    await scanPage.goto(storyUrl(id));
    await waitForStory(scanPage);

    // The palette is read from the SAME page that is about to be scanned, so a
    // build that shipped different tokens cannot be compared against the ones
    // this checkout happens to have on disk. A token that stopped resolving
    // drops out of the allowed set rather than widening it — the fail-safe
    // direction.
    const raw = await rawTokenValues(scanPage, TOKEN_NAMES);
    const painted = await paintTokens(scanPage, colorTokenNames(raw, TOKEN_NAMES));
    const allowed = Object.values(painted)
      .map(paletteKey)
      .filter((key): key is string => key !== null);
    expect(
      allowed.length,
      "no colour token resolved, so every rendered colour would be reported off-palette",
    ).toBeGreaterThan(0);

    const offPalette = await scanPage.evaluate((allowed) => {
      const palette = new Set(allowed);
      const key = (value: string) => {
        const match = value.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (!match) return null;
        // Fully transparent paints nothing, whatever channels it names.
        if (match[4] !== undefined && Number(match[4]) === 0) return null;
        return `${match[1]},${match[2]},${match[3]}`;
      };
      const drawn = (width: string, style: string) =>
        style !== "none" && style !== "hidden" && parseFloat(width) > 0;

      const findings: string[] = [];
      for (const element of document.querySelectorAll("body *")) {
        // Nothing laid out paints nothing — `display: none`, and the inert
        // halves of an overlay primitive.
        if (!element.getClientRects().length) continue;
        const style = getComputedStyle(element);

        // Only properties that actually put ink on this element: an unset
        // border still reports a colour (it defaults to `currentColor`), and
        // reporting it would flag elements that draw no border at all.
        const painting: [string, string][] = [["color", style.color]];
        painting.push(["background-color", style.backgroundColor]);
        for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
          const width = style[`border${side}Width` as const];
          const lineStyle = style[`border${side}Style` as const];
          if (drawn(width, lineStyle)) {
            painting.push([`border-${side.toLowerCase()}-color`, style[`border${side}Color`]]);
          }
        }
        if (drawn(style.outlineWidth, style.outlineStyle)) {
          painting.push(["outline-color", style.outlineColor]);
        }

        for (const [property, value] of painting) {
          const channels = key(value);
          if (channels === null || palette.has(channels)) continue;
          const className = String((element as HTMLElement).className ?? "").slice(0, 60);
          findings.push(
            `${property}: ${value}  on  <${element.tagName.toLowerCase()}${className ? ` class="${className}"` : ""}>`,
          );
        }
      }
      // Deduplicated: one hardcoded colour on a repeated row would otherwise
      // bury the finding under its own repetitions.
      return [...new Set(findings)].sort();
    }, allowed);

    expect(
      offPalette,
      `${id} paints colours that no Loom token defines. Every colour must come from tokens.css (core-ui CLAUDE.md: "never hardcode colors"), or the surface stops following the token when it is retuned:\n${offPalette.join("\n")}`,
    ).toEqual([]);
  });
}
