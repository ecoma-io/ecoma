/**
 * The WCAG scope Loom holds itself to: assistive-tech / keyboard-impact rules
 * only, not axe's SEO/document-structure best-practice set (root CLAUDE.md —
 * UX-valuable a11y only).
 *
 * Single source for every axe run against this package, and it has two of them
 * in different processes: the design-system app's live a11y panel
 * (`.storybook/preview.ts`, `parameters.a11y.options.runOnly`) and the
 * `design-system-e2e` gate that scans the built Storybook with
 * `@axe-core/playwright`. Both import this — the list must never be restated,
 * or the interactive panel and the blocking gate drift into disagreeing about
 * what counts as a violation.
 */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
