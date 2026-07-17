// E2E: layout invariants that must hold across every project viewport (desktop, mobile, webkit). The
// clipped-command bug was viewport-driven, so these guard the broader class: nothing overflows the page
// horizontally, and the primary surface renders. Runs once per project, so mobile-chrome covers small screens.
import { test, expect, type Page } from "@playwright/test";

async function dismissOnboarding(page: Page) {
  const skip = page.locator(".ob-skip");
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await dismissOnboarding(page);
});

test("no horizontal overflow at the project viewport", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Connect to your machine" })).toBeVisible();
  const overflowPx = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflowPx, "page scrolls horizontally at this viewport").toBeLessThanOrEqual(1);
});

test("gate heading and CTA render", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Connect to your machine" })).toBeVisible();
  await expect(page.getByRole("button", { name: /connect to your machine/i })).toBeVisible();
});
