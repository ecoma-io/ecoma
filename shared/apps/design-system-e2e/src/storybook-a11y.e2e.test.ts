import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type Page } from "playwright/test";
import { WCAG_TAGS } from "@ecoma-io/ui/a11y";

import {
  builtStoryIds,
  latchStoryRendered,
  storyUrl,
  waitForStory,
  type StoryEntry,
} from "./storybook-preview";

const STORY_IDS = builtStoryIds();

/**
 * The scan page: Playwright's own `page`, with the render latch installed
 * before any navigation. A fixture rather than a line in each test, so the
 * latch cannot be forgotten — `addInitScript` has to be in place before the
 * first `goto` or the wait it feeds never resolves.
 *
 * A worker-scoped page shared across the stories one worker handles was tried
 * and REJECTED, and it is worth knowing why before someone tries it again. It
 * is genuinely faster: the shared HTTP cache spares every story a re-download
 * of the Storybook runtime (541ms per story against 935ms; 18.5s against 27.4s
 * over the full 99). But a hand-made `browser.newContext()` is a lifecycle
 * Playwright does not own, so nothing recreates it — one transient browser
 * death took out every remaining story on that worker, 16 at a time, all
 * reporting "Target page, context or browser has been closed". Measured on one
 * machine: the shared page failed 2 of 3 runs at load 23, this fixture passed
 * 3 of 3 at load 32. A gate that fails when the machine is busy is not a gate,
 * so the ~30% is the price of the browser lifecycle staying with Playwright.
 */
const test = base.extend<{ scanPage: Page }>({
  scanPage: async ({ page }, use) => {
    await latchStoryRendered(page);
    await use(page);
  },
});

/**
 * Findings axe reports correctly by its own rule text, but which belong to a
 * focus pattern it cannot model: axe reads one DOM snapshot and cannot see that
 * focus is trapped elsewhere. Both are reka-ui's, read from the installed dist
 * (2.10.1), not inferred:
 *
 *  - `Toast` renders `VisuallyHidden feature="focusable"` sentinels
 *    (`dist/Toast/FocusProxy.js`) — `tabindex="0"` with `aria-hidden="true"` by
 *    construction. They exist to catch focus arriving from outside the viewport;
 *    a user never lands on one as a destination.
 *  - `DropdownMenu` marks the rest of the page `aria-hidden` while open
 *    (`dist/shared/useHideOthers.js` → `hideOthers()`), so the still-focusable
 *    trigger sits inside that region. Focus is held in the portaled menu, which
 *    is why a real user cannot reach it.
 *
 * Narrow on purpose — a rule pinned to ONE story, never a blanket
 * `disableRules`. A different story hitting the same rule still fails, which is
 * what keeps this from becoming a hole in the gate.
 *
 * And it cannot rot, from either end: the story's own scan asserts the rule was
 * actually reported, so the day reka-ui fixes one the gate fails asking for the
 * entry to be deleted; and the test below asserts every entry still names a
 * live story, which is the case no per-story scan would ever reach.
 */
const UPSTREAM_FOCUS_PATTERNS = [
  { story: "components-primitives-toast--open", rule: "aria-hidden-focus" },
  { story: "components-primitives-dropdownmenu--open", rule: "aria-hidden-focus" },
];

test("the served Storybook index names exactly the stories this suite scans", async ({
  baseURL,
}) => {
  const response = await fetch(new URL("index.json", baseURL!));
  expect(response.ok, `the built Storybook must serve index.json (got ${response.status})`).toBe(
    true,
  );
  const index = (await response.json()) as { entries: Record<string, StoryEntry> };
  const served = Object.values(index.entries)
    .filter((entry) => entry.type !== "docs")
    .map((entry) => entry.id)
    .sort();

  // The test list came off disk at collection time; this is the one assertion
  // that ties it to what the server actually hands out, so a stale artifact
  // cannot leave stories unscanned while the run still reports green.
  expect(served).toEqual(STORY_IDS);
});

test("every upstream-focus allowance names a story that still exists", () => {
  const unknown = UPSTREAM_FOCUS_PATTERNS.filter((entry) => !STORY_IDS.includes(entry.story)).map(
    (entry) => entry.story,
  );
  expect(
    unknown,
    `UPSTREAM_FOCUS_PATTERNS names stories the built Storybook no longer ships — they were renamed or removed, and their allowance is now dead:\n${unknown.join("\n")}`,
  ).toEqual([]);
});

// Losing `reducedMotion` would not fail loudly — it would come back as contrast
// violations on whichever stories happened to be caught mid-animation, on
// whichever run. Measured without it: 3 full sweeps of 4 red. Pinning the
// setting itself is what keeps that failure mode from being intermittent.
test("the scan page really is under reduced motion", async ({ scanPage }) => {
  const reduced = await scanPage.evaluate(
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  expect(
    reduced,
    'the scan page lost `reducedMotion: "reduce"` — axe reads computed colour, so stories caught mid-animation report contrast violations they do not have. Check that playwright.config.ts still declares it under `use.contextOptions`.',
  ).toBe(true);
});

/**
 * The blocking a11y gate: one test per story in the BUILT artifact — the thing
 * an operator actually opens — so a violation introduced by the build (a
 * dropped stylesheet, an asset that 404s and collapses contrast) is caught,
 * which a scan against source cannot see.
 *
 * One test per story, rather than one sweep that accumulates: an a11y
 * regression usually lands across several stories at once, and seeing only the
 * first hides the shape of it. Playwright runs every test and reports every
 * failure, so the whole shape still arrives — now with each violation attached
 * to the story that has it, and with the stories spread across workers.
 *
 * `storyUrl` carries two flags that are load-bearing for this scan in
 * particular — see its doc comment in `storybook-preview.ts`.
 */
for (const id of STORY_IDS) {
  const allowedRules = UPSTREAM_FOCUS_PATTERNS.filter((entry) => entry.story === id).map(
    (entry) => entry.rule,
  );

  test(`${id} is free of WCAG A/AA violations`, async ({ scanPage }) => {
    await scanPage.goto(storyUrl(id));
    await waitForStory(scanPage);

    // Whole document, NOT `#storybook-root`. Bare mode renders the story alone —
    // there is no Storybook chrome to exclude — and an overlay primitive
    // (DropdownMenu, Dialog, Tooltip, Toast) portals its content to
    // `document.body`, OUTSIDE that root. Scoping to the root would silently
    // skip exactly the surfaces whose a11y is hardest to get right, while the
    // story that opened them still counted as scanned.
    const { violations } = await new AxeBuilder({ page: scanPage }).withTags(WCAG_TAGS).analyze();

    const failures = violations
      .filter((violation) => !allowedRules.includes(violation.id))
      .map(
        (violation) =>
          `${violation.id} (${violation.impact}): ${violation.nodes
            .map((node) => node.target.join(" "))
            .join(", ")}`,
      );
    expect(failures, `axe found WCAG violations in ${id}:\n${failures.join("\n")}`).toEqual([]);

    const reported = new Set(violations.map((violation) => violation.id));
    const stale = allowedRules.filter((rule) => !reported.has(rule));
    expect(
      stale,
      `${id} no longer trips ${stale.join(", ")} — reka-ui fixed it, so delete that UPSTREAM_FOCUS_PATTERNS entry rather than carry an allowance for a violation that is gone.`,
    ).toEqual([]);
  });
}
