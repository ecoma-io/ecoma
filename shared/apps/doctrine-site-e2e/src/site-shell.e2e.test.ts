import { expect, test } from "playwright/test";

import { headingOf } from "./doctrine-tree";

// What this tier is for here: the site is assembled by a generator from
// Markdown, so nothing in the unit tier can tell you the assembly produced a
// page a browser can actually open at the mounted path. These pin the shell —
// that the mount answers, and that the two facts every document carries are
// rendered by the site rather than repeated inside the documents.
//
// That the pages come from the doctrine tree and from no copy is a different
// claim, and it has its own file.

test("answers at the mounted base path and leads to the tree's front door", async ({ page }) => {
  const response = await page.goto("./");
  expect(response?.status()).toBe(200);
  await expect(page).toHaveURL(/\/doctrine\/overview\/$/);
  await expect(page.locator("h1")).toContainText(headingOf("overview/index.md"));
});

test("states from the document's own status that these are design end-state, not shipped software", async ({
  page,
}) => {
  await page.goto("./spec/role");
  await expect(page.getByText("Design end-state, pre-implementation")).toBeVisible();
});

test("names the licence of the documents and links it, so a reader never has to assume", async ({
  page,
}) => {
  await page.goto("./spec/role");
  const licence = page.getByRole("link", { name: /CC BY-SA 4\.0/ });
  await expect(licence).toHaveAttribute("href", /creativecommons\.org\/licenses\/by-sa\/4\.0/);
});

test("reaches a sectioned document through the sidebar, proving the nav is wired and not decorative", async ({
  page,
}) => {
  await page.goto("./");
  await page
    .getByRole("link", { name: headingOf("charter/deploy.md") })
    .first()
    .click();
  await expect(page).toHaveURL(/\/doctrine\/charter\/deploy/);
  await expect(page.locator("h1")).toContainText(headingOf("charter/deploy.md"));
});
