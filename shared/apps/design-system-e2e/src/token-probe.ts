import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Page } from "playwright/test";

/**
 * Reads Alloy's design tokens as the BUILT Storybook actually resolves them.
 *
 * The division of labour is deliberate and holds throughout: token NAMES come
 * from the stylesheet, token VALUES come from the browser. Converting
 * `211 37% 32%` to rgb here would be a second implementation of the thing under
 * test, and it would agree with itself while disagreeing with what users see.
 */

const TOKENS_CSS = new URL("../../../libs/core-ui/src/styles/tokens.css", import.meta.url);

/**
 * Every custom property `tokens.css` declares, deduplicated — a second theme
 * block (the dark theme is a reserved seam) would repeat every name, and each
 * token still only needs checking once.
 */
export function declaredTokenNames(): string[] {
  const css = readFileSync(TOKENS_CSS, "utf8");
  const names = [...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((match) => match[1]);
  if (names.length === 0) {
    throw new Error(
      `${fileURLToPath(TOKENS_CSS)} declares no custom properties — a suite that derives its subject from this file would pass having checked nothing.`,
    );
  }
  return [...new Set(names)].sort();
}

/**
 * The colour the probes below inherit when an expression does NOT resolve.
 *
 * `color` is an inherited property, so an expression that is invalid at
 * computed-value time — `hsl(var(--deleted))`, or a token whose channels stopped
 * being a colour — falls back to the parent's colour rather than to anything
 * that announces the failure. Painting the parent an unmistakable value turns
 * that silent fallback into a reading a test can assert on. No Alloy token
 * resolves to this, which is what makes it unambiguous.
 */
export const UNRESOLVED = "rgb(1, 2, 3)";

/**
 * Computes each CSS colour expression in the live page, returning `UNRESOLVED`
 * for any that does not resolve.
 *
 * Because it reports non-resolution rather than throwing, this doubles as a
 * colour DETECTOR: feeding it the parts of a gradient or box-shadow separates
 * the colour stops from the lengths and keywords without parsing CSS by hand.
 */
export async function paint(page: Page, expressions: string[]): Promise<string[]> {
  return page.evaluate(
    ({ expressions, sentinel }) => {
      const holder = document.createElement("div");
      holder.style.color = sentinel;
      document.body.appendChild(holder);
      try {
        return expressions.map((expression) => {
          // A FRESH element per expression, never a reused one. Chromium caches
          // the computed `color` of an element whose value contains `var()`:
          // assigning a DIFFERENT var() reference to the same element does not
          // recompute, so every expression after the first reports the first
          // one's colour. Setting `""` in between and going through an indirect
          // custom property were both tried and both still report the first
          // colour. This is not a micro-optimisation to undo — reusing one
          // element makes every assertion below pass for the wrong reason.
          const probe = document.createElement("div");
          probe.style.color = expression;
          holder.appendChild(probe);
          const painted = getComputedStyle(probe).color;
          probe.remove();
          return painted;
        });
      } finally {
        holder.remove();
      }
    },
    { expressions, sentinel: UNRESOLVED },
  );
}

/** Resolves named tokens as colours, keyed by token name. */
export async function paintTokens(page: Page, names: string[]): Promise<Record<string, string>> {
  const painted = await paint(
    page,
    names.map((name) => `hsl(var(${name}))`),
  );
  return Object.fromEntries(names.map((name, index) => [name, painted[index]]));
}

/** The raw, unconverted value of each token as `:root` computes it. */
export async function rawTokenValues(page: Page, names: string[]): Promise<Record<string, string>> {
  return page.evaluate((names) => {
    const root = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((name) => [name, root.getPropertyValue(name).trim()]));
  }, names);
}

/**
 * The space-separated HSL channel triple Alloy authors colours as
 * (`211 37% 32%` — the shadcn convention `tokens.css` documents), which is what
 * separates a colour token from `--radius`, `--dur-fast` or `--font-sans`
 * without a hand-maintained list of which is which.
 */
const HSL_CHANNELS = /^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%$/;

/** The subset of `names` whose raw value is an HSL channel triple. */
export function colorTokenNames(raw: Record<string, string>, names: string[]): string[] {
  return names.filter((name) => HSL_CHANNELS.test(raw[name] ?? ""));
}

/** The `{ r, g, b }` of a computed `rgb()`/`rgba()` string, alpha discarded. */
export function channels(computed: string): { r: number; g: number; b: number } {
  const match = computed.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) throw new Error(`not a computed colour: ${computed}`);
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
}

/** WCAG relative luminance (WCAG 2.1, definition of *relative luminance*). */
export function luminance(computed: string): number {
  const { r, g, b } = channels(computed);
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio between two computed colours (WCAG 2.1 SC 1.4.3). */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Splits a CSS value on a top-level separator, leaving anything inside
 * parentheses intact — so `hsl(211 37% 32% / 0.15)` survives a space split and
 * `rgb(51, 81, 112)` survives a comma split. Used to break a gradient or a
 * shadow into parts that `paint()` can then sort into colours and non-colours.
 */
export function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (char === separator && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current.trim());
  return parts.filter((part) => part !== "");
}
