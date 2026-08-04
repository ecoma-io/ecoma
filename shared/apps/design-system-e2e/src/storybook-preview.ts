import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Page } from "playwright/test";

/**
 * Mechanics for driving the BUILT Storybook preview, shared by every suite in
 * this project. It lives here rather than in whichever test file needed it
 * first because a second copy of the story derivation would let two gates
 * disagree about which stories exist — the sweep that reports green having
 * looked at nothing is exactly the failure these suites exist to prevent
 * (Rule 14).
 *
 * Not a test file: the name matches no Playwright `testMatch` pattern, so
 * collection ignores it.
 */

/** A story entry in Storybook's generated index (`type: "docs"` pages excluded). */
export interface StoryEntry {
  id: string;
  title: string;
  name: string;
  type?: string;
}

const STORYBOOK_INDEX = new URL("../../design-system/storybook-static/index.json", import.meta.url);

/**
 * Every story the built Storybook actually ships, read from the artifact's own
 * generated index rather than a list maintained here — a new primitive is
 * covered the moment its story exists, and a removed one drops out on its own
 * (Rule 14: derive, never restate).
 *
 * Read from disk, not fetched over HTTP, because this list decides how many
 * tests exist: each story gets its own `test()` so the sweep can spread across
 * workers, and Playwright fixes the test list at collection time — before any
 * server is up to answer a fetch. That is why the Storybook build is a
 * `dependsOn` of the Nx `e2e` target instead of a step inside `webServer`:
 * the artifact must exist before this file is even loaded.
 */
export function builtStoryIds(): string[] {
  let raw: string;
  try {
    raw = readFileSync(STORYBOOK_INDEX, "utf8");
  } catch {
    throw new Error(
      `Storybook is not built — ${fileURLToPath(STORYBOOK_INDEX)} is missing. ` +
        "Run `pnpm nx run design-system-e2e:e2e`, which builds it first; invoking Playwright directly does not.",
    );
  }
  const index = JSON.parse(raw) as { entries: Record<string, StoryEntry> };
  const ids = Object.values(index.entries)
    .filter((entry) => entry.type !== "docs")
    .map((entry) => entry.id)
    .sort();
  if (ids.length === 0) {
    throw new Error(
      `${fileURLToPath(STORYBOOK_INDEX)} names no stories — a suite that generates zero scans would pass having looked at nothing.`,
    );
  }
  return ids;
}

/**
 * The preview URL for one story. Both URL flags are load-bearing:
 *
 *  - `loomBare=1` renders the story without the viewport-picker surface
 *    (.storybook/PreviewSurface.vue): that surface nests a second `iframe.html`
 *    of the SAME story, so a scan without it sees every element twice and
 *    attributes half of them to chrome this project does not own.
 *  - `globals=a11y.manual:!true` stops @storybook/addon-a11y from running ITS
 *    bundled axe when the story mounts. Two axe instances in one page is not a
 *    slow test, it is a hard failure — "Axe is already running" — and the addon
 *    gates exactly on this global (`a11yGlobals?.manual !== true`). The panel
 *    stays useful in the dev Storybook; only these scans opt out, so the axe
 *    that reports here is the one the a11y suite configures.
 */
export function storyUrl(id: string): string {
  return `/iframe.html?id=${encodeURIComponent(id)}&loomBare=1&globals=a11y.manual:!true`;
}

/** The preview iframe's globals, narrowed to what the render wait below needs. */
interface PreviewWindow extends Window {
  __storyRendered?: boolean;
  __STORYBOOK_ADDONS_CHANNEL__?: { once(event: string, listener: () => void): void };
}

/**
 * Latches Storybook's `storyRendered` for the wait below. It runs before any
 * page script on every navigation, which is the only way to subscribe to an
 * event the preview may emit before a test could attach a listener.
 */
export async function latchStoryRendered(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const preview = window as PreviewWindow;
    preview.__storyRendered = false;
    const attach = () => {
      const channel = preview.__STORYBOOK_ADDONS_CHANNEL__;
      if (!channel) return void setTimeout(attach, 0);
      channel.once("storyRendered", () => {
        preview.__storyRendered = true;
      });
    };
    attach();
  });
}

/**
 * Blocks until the story is actually on screen.
 *
 * The obvious wait — `#storybook-root` being attached — waits for nothing:
 * that div is static markup in `iframe.html`, so it is present at parse time
 * and a scan could run against an empty shell. Measured: 10 of 60 samples had
 * the root still childless at that point, and every colour-contrast flake in
 * the a11y sweep coincided with one. Scanning an unmounted story is the worse
 * half of that bug — it reports green having looked at nothing.
 *
 * `storyRendered` is Storybook's own completion signal, emitted in its
 * `completed` phase — after render, after any play function.
 */
export async function waitForStory(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as PreviewWindow).__storyRendered === true);
}
