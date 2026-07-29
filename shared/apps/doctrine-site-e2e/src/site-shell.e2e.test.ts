import { expect, test } from "playwright/test";

// What this tier is for here: the site is assembled by a generator from
// Markdown, so nothing in the unit tier can tell you the assembly produced a
// page a browser can actually open at the mounted path. These pin the shell
// itself, before any ceiling document depends on it.

test("serves the entry page under the mounted base path rather than at the domain root", async ({
  page,
}) => {
  const response = await page.goto("./");
  expect(response?.status()).toBe(200);
  await expect(page.locator("h1")).toContainText("Ecoma Doctrine");
});

test("states that the documents are design end-state rather than shipped software", async ({
  page,
}) => {
  await page.goto("./");
  await expect(page.getByText("design end-state, pre-implementation")).toBeVisible();
});

test("names the licence of the documents and links it, so a reader never has to assume", async ({
  page,
}) => {
  await page.goto("./");
  const licence = page.getByRole("link", { name: /CC BY-SA 4\.0/ });
  await expect(licence).toHaveAttribute("href", /creativecommons\.org\/licenses\/by-sa\/4\.0/);
});

test("reaches a sectioned document through the sidebar, proving the nav is wired and not decorative", async ({
  page,
}) => {
  await page.goto("./");
  await page.getByRole("link", { name: "Reading order" }).first().click();
  await expect(page).toHaveURL(/\/doctrine\/overview\/reading-order/);
  await expect(page.locator("h1")).toContainText("Reading order");
});
