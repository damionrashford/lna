// E2E: the first-run welcome overlay. It's non-blocking and skippable (Skip / Esc / backdrop / finish),
// and personalizes the local profile. A fresh Playwright context has empty localStorage, so it appears
// every test. No network needed — pure UI.
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // the overlay mounts after boot() resolves the profile — wait for it before interacting (also arms the
  // window keydown listener that handles Escape)
  await expect(page.locator(".ob")).toBeVisible();
});

test("shows the welcome on first run", async ({ page }) => {
  await expect(page.getByText(/private AI that runs in your browser/i)).toBeVisible();
});

test("Skip dismisses it", async ({ page }) => {
  await page.locator(".ob-skip").click();
  await expect(page.locator(".ob")).toBeHidden();
});

test("Escape dismisses it", async ({ page }) => {
  await page.keyboard.press("Escape");
  await expect(page.locator(".ob")).toBeHidden();
});

test("completing the flow personalizes the greeting", async ({ page }) => {
  // scope to the overlay — Settings (off-canvas) also has a "your name" field, so page-wide would be ambiguous
  const ob = page.locator(".ob");
  // step 1: name
  await ob.getByPlaceholder("your name").fill("Damion");
  await ob.getByRole("button", { name: "Continue" }).click();
  // step 2: focus — pick the first chip
  await ob.locator(".ob-chip").first().click();
  await ob.getByRole("button", { name: "Continue" }).click();
  // step 3: tone — pick the first, then finish
  await ob.locator(".ob-tone").first().click();
  await ob.getByRole("button", { name: "Get started" }).click();
  await expect(ob).toBeHidden();
  // the gate greeting reflects the saved name
  await expect(page.locator(".gate-hi")).toContainText("Damion");
});
