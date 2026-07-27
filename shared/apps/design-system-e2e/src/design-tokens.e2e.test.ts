import { expect, test as base, type Page } from "playwright/test";

import {
  UNRESOLVED,
  contrastRatio,
  channels,
  declaredTokenNames,
  luminance,
  paint,
  paintTokens,
  rawTokenValues,
  splitTopLevel,
} from "./token-probe";

/**
 * The design-token contract, asserted against the BUILT Storybook.
 *
 * `tokens.css` states its laws in prose — the elevation rhythm, the focus ring
 * being the Human force, the seam running steel to copper — and nothing holds
 * them. Several are held together by literals that RESTATE another token's
 * value instead of referencing it (`--seam` and `--halo` both spell out
 * `--primary`'s channels), so retuning one token leaves the others silently
 * pointing at the old colour. These tests are what make that duplication safe:
 * the day a force is retuned, they fail naming the tokens that did not follow.
 *
 * They belong in this project rather than in `core-ui`'s `test` target because
 * every assertion below is about a COMPUTED value, and jsdom resolves neither
 * `var()` nor `hsl()` — the unit tier would be asserting on strings it copied
 * from the same file it is meant to be checking.
 */

const TOKEN_NAMES = declaredTokenNames();

const test = base.extend<{ tokenPage: Page }>({
  tokenPage: async ({ page }, use) => {
    // Deliberately the BARE preview, with no story id. The tokens live on
    // `:root` via core-ui's global.css, which the preview bundle imports at
    // module scope, so no component has to render for them to resolve. Loading
    // no story is the stronger test: it pins the stylesheet as the build ships
    // it, with nothing in the way to make a green run depend on one story's
    // markup. `goto` resolves on `load`, which is after the linked stylesheet a
    // production Storybook build emits.
    await page.goto("/iframe.html");
    await use(page);
  },
});

/**
 * Note what this can and cannot see. The names come from the file, so a token
 * DELETED from the file leaves the checked set with it — deletion is caught by
 * the consumers that break, not here. What this catches is the gap between
 * declaring a token and the built artifact resolving it: a declaration scoped
 * out of `:root`, a token the CSS pipeline drops, or the stylesheet never
 * reaching the build at all. None of those change a single source file, which
 * is why no test that reads source can see them.
 */
test("every token tokens.css declares resolves in the built Storybook", async ({ tokenPage }) => {
  const raw = await rawTokenValues(tokenPage, TOKEN_NAMES);
  const unresolved = TOKEN_NAMES.filter((name) => raw[name] === "");

  expect(
    unresolved,
    unresolved.length === TOKEN_NAMES.length
      ? "NO token resolved — tokens.css did not reach the built Storybook at all. Every colour, radius and duration in the product is falling back, which no per-component test can see."
      : `tokens.css declares these tokens, but the built Storybook does not resolve them — they are declared outside \`:root\`, or the CSS pipeline dropped them:\n${unresolved.join("\n")}`,
  ).toEqual([]);
});

/**
 * The three surfaces of the elevation rhythm, in the order tokens.css requires:
 * "sunken < background < card, so work surfaces read as lifted and navigation
 * recedes". This list is the law itself, not a restatement of a value — there
 * is no other source to derive the participants from.
 */
const ELEVATION_RHYTHM = ["--sunken", "--background", "--card"];

test("the elevation rhythm keeps navigation sunken and work surfaces lifted", async ({
  tokenPage,
}) => {
  const painted = await paintTokens(tokenPage, ELEVATION_RHYTHM);

  const missing = ELEVATION_RHYTHM.filter((name) => painted[name] === UNRESOLVED);
  expect(
    missing,
    `the elevation rhythm names tokens that no longer resolve to a colour: ${missing.join(", ")}`,
  ).toEqual([]);

  // Strictly increasing, not merely ordered: two surfaces of equal lightness
  // read as one plane, which is the rhythm collapsing rather than inverting.
  const steps = ELEVATION_RHYTHM.map((name) => ({ name, level: luminance(painted[name]) }));
  const inverted = steps.filter((step, index) => index > 0 && step.level <= steps[index - 1].level);

  expect(
    inverted.map((step) => step.name),
    `the elevation rhythm no longer rises from ${ELEVATION_RHYTHM.join(" to ")}:\n${steps
      .map((step) => `  ${step.name} luminance ${step.level.toFixed(4)}`)
      .join("\n")}`,
  ).toEqual([]);
});

/**
 * Every `--X-foreground` whose `--X` also exists — derived, so a new semantic
 * colour is covered the moment it is authored with its own foreground.
 */
const FOREGROUND_PAIRS = TOKEN_NAMES.filter((name) => name.endsWith("-foreground"))
  .map((foreground) => ({
    foreground,
    surface: foreground.slice(0, -"-foreground".length),
  }))
  .filter((pair) => TOKEN_NAMES.includes(pair.surface));

// WCAG 2.1 SC 1.4.3 (Contrast Minimum), level AA, normal text. A fixed external
// contract rather than a workspace decision, used in exactly one place — the
// one shape Rule 14 allows a literal to keep.
const WCAG_AA_NORMAL_TEXT = 4.5;

test("every foreground token clears WCAG AA against the surface it names", async ({
  tokenPage,
}) => {
  expect(
    FOREGROUND_PAIRS.length,
    "tokens.css declares no --X/--X-foreground pair, so this test would pass having compared nothing",
  ).toBeGreaterThan(0);

  const involved = [
    ...new Set(FOREGROUND_PAIRS.flatMap((pair) => [pair.surface, pair.foreground])),
  ];
  const painted = await paintTokens(tokenPage, involved);

  const missing = involved.filter((name) => painted[name] === UNRESOLVED);
  expect(
    missing,
    `a token in a --X/--X-foreground pair no longer resolves to a colour, so its contrast cannot be judged: ${missing.join(", ")}`,
  ).toEqual([]);

  const ratios = FOREGROUND_PAIRS.map((pair) => ({
    ...pair,
    ratio: contrastRatio(painted[pair.surface], painted[pair.foreground]),
  }));
  const failing = ratios.filter((pair) => pair.ratio < WCAG_AA_NORMAL_TEXT);

  // At the PALETTE level, which is what the axe sweep cannot reach: axe judges
  // the combinations stories happen to render, so a pair no story uses today
  // ships unchecked and fails the first product that reaches for it.
  expect(
    failing.map((pair) => `${pair.surface} / ${pair.foreground} at ${pair.ratio.toFixed(2)}:1`),
    `these token pairs fall below WCAG AA ${WCAG_AA_NORMAL_TEXT}:1, so any surface using them as authored is inaccessible:\n${ratios
      .sort((a, b) => a.ratio - b.ratio)
      .map((pair) => `  ${pair.ratio.toFixed(2)}:1  ${pair.surface} / ${pair.foreground}`)
      .join("\n")}`,
  ).toEqual([]);
});

test("the focus ring is the Human force", async ({ tokenPage }) => {
  const painted = await paintTokens(tokenPage, ["--ring", "--primary"]);

  // Asserted before the comparison: two tokens that both stopped resolving are
  // equal to each other, so equality alone would pass on a deleted palette.
  expect(painted["--primary"], "--primary no longer resolves to a colour").not.toBe(UNRESOLVED);

  expect(
    painted["--ring"],
    'tokens.css states "focus ring = Human steel: keyboard focus is a person acting", but --ring restates a colour --primary no longer has. --ring is authored as a literal copy of --primary\'s channels, so retuning one does not carry to the other.',
  ).toBe(painted["--primary"]);
});

test("the seam runs from the Human force to the Agent force", async ({ tokenPage }) => {
  const raw = await rawTokenValues(tokenPage, ["--seam"]);
  const inner = raw["--seam"].match(/^[a-z-]*gradient\((.*)\)$/is)?.[1];
  expect(
    inner,
    `--seam must be a gradient, but resolves to: ${raw["--seam"] || "(nothing)"}`,
  ).toBeDefined();

  // The gradient's own parts, sorted into colours and non-colours by whether
  // they paint — so the angle and the `in oklch` interpolation drop out without
  // a hand-written parser that would need updating every time the syntax grows.
  const stops = (await paint(tokenPage, splitTopLevel(inner!, ","))).filter(
    (part) => part !== UNRESOLVED,
  );
  const forces = await paintTokens(tokenPage, ["--primary", "--agent"]);
  expect(forces["--primary"], "--primary no longer resolves to a colour").not.toBe(UNRESOLVED);
  expect(forces["--agent"], "--agent no longer resolves to a colour").not.toBe(UNRESOLVED);

  // Exactly two: the seam is where the two forces meet (Design System ›
  // Signature). A third stop is a different object that happens to be a
  // gradient, and the endpoint check below would not notice it.
  expect(
    stops,
    `--seam must have exactly the two force endpoints, but resolves to: ${raw["--seam"]}`,
  ).toHaveLength(2);

  expect(
    [stops[0], stops[1]],
    `--seam spells its endpoints out as literals rather than referencing --primary and --agent, and they have drifted: the seam runs ${stops[0]} to ${stops[1]} while the forces are now ${forces["--primary"]} (Human) and ${forces["--agent"]} (Agent).`,
  ).toEqual([forces["--primary"], forces["--agent"]]);
});

test("the focus halo is the Human force", async ({ tokenPage }) => {
  const raw = await rawTokenValues(tokenPage, ["--halo"]);
  expect(raw["--halo"], "--halo no longer resolves").not.toBe("");

  // Same sort-by-painting as the seam: the offsets and the spread radius do not
  // paint, so whatever is left is the halo's colour.
  const colors = (await paint(tokenPage, splitTopLevel(raw["--halo"], " "))).filter(
    (part) => part !== UNRESOLVED,
  );
  expect(
    colors,
    `--halo must name exactly one colour, but resolves to: ${raw["--halo"]}`,
  ).toHaveLength(1);

  const forces = await paintTokens(tokenPage, ["--primary"]);
  expect(forces["--primary"], "--primary no longer resolves to a colour").not.toBe(UNRESOLVED);

  // Channels only: the halo is deliberately the force at low alpha ("a steel
  // haze"), so its opacity is its own business and only the hue must follow.
  expect(
    channels(colors[0]),
    `tokens.css states the focus halo is "a steel haze" around the ring, but --halo spells --primary's channels out as a literal and they have drifted: the halo is ${colors[0]} while the Human force is now ${forces["--primary"]}.`,
  ).toEqual(channels(forces["--primary"]));
});
