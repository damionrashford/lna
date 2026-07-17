// E2E: the "Connect to your machine" onboarding gate — the app's first screen before any model
// connection, and the main surface a headless runner can exercise (no local Ollama in CI). Includes a
// regression for the step-1 command that used to clip its tail (`ollama serve`) under the copy button.
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // skip the first-run overlay deterministically (mark the profile onboarded before any app script runs)
  await page.addInitScript(() => localStorage.setItem("automo.profile", JSON.stringify({ onboarded: true })));
  await page.goto("/");
});

test("renders the gate with all three steps", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Connect to your machine" })).toBeVisible();
  await expect(page.getByText("Start Ollama, allowing this page")).toBeVisible();
  await expect(page.getByText("Pull a model (once)")).toBeVisible();
  await expect(page.getByText(/Connect .* grant the prompt/)).toBeVisible();
});

test("step 1 command is complete and not clipped", async ({ page }) => {
  const pre = page.locator(".step pre").first();
  // the whole command must be present as text — `ollama serve` is the tail that was being hidden
  await expect(pre).toContainText("OLLAMA_ORIGINS=");
  await expect(pre).toContainText("ollama serve");
  // regression guard: the command must wrap inside its box, never overflow under the copy button
  const overflowPx = await pre.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflowPx, "step-1 command overflows its container (clipped)").toBeLessThanOrEqual(1);
});

test("connect CTA is present and enabled", async ({ page }) => {
  const cta = page.getByRole("button", { name: /connect to your machine/i });
  await expect(cta).toBeVisible();
  await expect(cta).toBeEnabled();
});

test("copy button writes the full command to the clipboard", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard read/write is Chromium-only");
  const step1 = page.locator(".step").filter({ hasText: "Start Ollama" });
  await step1.getByRole("button", { name: "copy" }).click();
  // assert the real behavior (clipboard contents), not the ephemeral "copied" label which a re-render can wipe
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain("OLLAMA_ORIGINS=");
  expect(clip).toContain("ollama serve");
});
