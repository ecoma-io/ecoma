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

test("every locale carries its own meta description", async ({ page }) => {
  await page.goto("/");
  const description = page.locator('head meta[name="description"]');
  await expect(description).toHaveAttribute("content", /labor operating system/);

  await page.goto("/vi/");
  await expect(description).toHaveAttribute("content", /hệ điều hành lao động/);

  await page.goto("/zh/");
  await expect(description).toHaveAttribute("content", /劳动操作系统/);
});

test("the social surface names title, description and site", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "ecoma.io");
  await expect(page.locator('meta[property="og:description"]')).not.toHaveAttribute("content", "");
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "website");
  await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute("content", "Ecoma");
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary");
});

test("the shell ships a favicon", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon.svg");
  const response = await page.request.get("/favicon.svg");
  expect(response.ok()).toBe(true);
});

test("llms.txt names the locale homes", async ({ page }) => {
  const response = await page.request.get("/llms.txt");
  expect(response.ok()).toBe(true);
  const text = await response.text();
  for (const url of ["https://ecoma.io", "https://ecoma.io/vi", "https://ecoma.io/zh"]) {
    expect(text).toContain(url);
  }
});

test("the language switcher links to each locale home", async ({ page }) => {
  await page.goto("/vi/");
  // Scoped by data-testid, not by role: the charter's real navigation will
  // add more nav elements, and the switcher must keep its own pin.
  const switcher = page.getByTestId("locale-switcher");
  const links = switcher.locator("a");
  await expect(links).toHaveCount(3);
  const hrefs = await links.evaluateAll((anchors) =>
    anchors.map((a) => (a as HTMLAnchorElement).getAttribute("href")),
  );
  expect(hrefs).toEqual(["/", "/vi", "/zh"]);
  await expect(switcher.locator('a[aria-current="page"]')).toHaveAttribute("href", "/vi");
});

test("the not-found page renders its copy and a working switcher", async ({ page }) => {
  // In this SSG build 404.html is a client-rendered shell (site/CLAUDE.md);
  // the host serves it for unknown routes, which the e2e server does not —
  // so the gate reads the file directly.
  await page.goto("/404.html");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Nothing is served here yet.");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByTestId("locale-switcher").locator("a")).toHaveCount(3);
});

test("robots.txt allows crawling", async ({ page }) => {
  const response = await page.request.get("/robots.txt");
  expect(response.ok()).toBe(true);
  await expect.poll(() => response.text()).toContain("Allow: /");
});

test("a default build carries no robots meta", async ({ page }) => {
  // Pins the false half of the preview-noindex contract: a production build
  // must not be noindexed. The true half (NUXT_PUBLIC_PREVIEW=true adds the
  // meta in every prerendered page) is gated by the site app's
  // verify-preview-noindex target — see site/CLAUDE.md.
  await page.goto("/");
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
});
