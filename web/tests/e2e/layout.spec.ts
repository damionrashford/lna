// E2E: layout invariants that must hold across every project viewport (desktop, mobile, webkit). The
// clipped-command bug was viewport-driven, so these guard the broader class: nothing overflows the page
// horizontally, and the primary surface renders. Runs once per project, so mobile-chrome covers small screens.
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // skip the first-run overlay deterministically (mark the profile onboarded before any app script runs)
  await page.addInitScript(() => localStorage.setItem("automo.profile", JSON.stringify({ onboarded: true })));
  await page.goto("/");
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

test("gate fits the viewport with no vertical scroll (desktop)", async ({ page }, testInfo) => {
  // on desktop the connect card — including the hardware recommendation block — must fit without scrolling.
  // Narrow phones wrap the copy to many more lines, where scrolling a connect screen is normal UX.
  test.skip(testInfo.project.name === "mobile-chrome", "narrow mobile viewports scroll — expected");
  await expect(page.getByRole("heading", { name: "Connect to your machine" })).toBeVisible();
  // the hardware block renders async and adds height — wait for it (best-effort) so we measure the worst case
  await page.locator(".gate .machine").waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  await expect
    .poll(() => page.evaluate(() => { const m = document.querySelector("main"); return m ? m.scrollHeight - m.clientHeight : 0; }),
      { message: "the connect gate overflows the viewport (scrolls vertically)" })
    .toBeLessThanOrEqual(1);
});
