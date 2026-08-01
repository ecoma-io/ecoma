import { expect, test } from "playwright/test";

/**
 * The SEO contract of the built site, pinned at the artifact level: the
 * `html lang`, hreflang alternates, canonical and robots surface that a
 * future content build must not regress silently (site CLAUDE.md).
 */

function alternateLinks(page: import("playwright/test").Page, hreflang: string) {
  return page.locator(`head link[rel="alternate"][hreflang="${hreflang}"]`);
}

test("the default locale serves at the root with html lang en", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("ecoma.io");
});

test("prefixed locales serve their own language and copy", async ({ page }) => {
  await page.goto("/vi/");
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("ecoma.io");

  await page.goto("/zh/");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("ecoma.io");
});

test("every locale page names the other languages in hreflang alternates", async ({ page }) => {
  await page.goto("/");
  for (const href of ["en", "vi", "zh", "x-default"]) {
    await expect(alternateLinks(page, href)).not.toHaveCount(0);
  }
});

test("canonical links name the production origin", async ({ page }) => {
  await page.goto("/");
  const canonical = page.locator('head link[rel="canonical"]');
  await expect(canonical).toHaveCount(1);
  await expect(canonical).toHaveAttribute("href", "https://ecoma.io");

  await page.goto("/vi/");
  await expect(canonical).toHaveAttribute("href", "https://ecoma.io/vi");
});

test("the language switcher links to each locale home", async ({ page }) => {
  await page.goto("/vi/");
  const switcher = page.getByRole("navigation");
  const links = switcher.locator("a");
  await expect(links).toHaveCount(3);
  const hrefs = await links.evaluateAll((anchors) =>
    anchors.map((a) => (a as HTMLAnchorElement).getAttribute("href")),
  );
  expect(hrefs).toEqual(["/", "/vi", "/zh"]);
  await expect(switcher.locator('a[aria-current="page"]')).toHaveAttribute("href", "/vi");
});

test("robots.txt allows crawling", async ({ page }) => {
  const response = await page.request.get("/robots.txt");
  expect(response.ok()).toBe(true);
  await expect.poll(() => response.text()).toContain("Allow: /");
});

test("a default build carries no robots meta", async ({ page }) => {
  // Pins the false half of the preview-noindex plugin: a production build
  // must not be noindexed. The true half (NUXT_PUBLIC_PREVIEW=true adds the
  // meta) is checked by hand on a preview build — see site/CLAUDE.md.
  await page.goto("/");
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
});
