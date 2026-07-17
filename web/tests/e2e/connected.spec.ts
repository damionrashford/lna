// E2E: the CONNECTED app — the part a headless runner can't reach for real (no local Ollama over LNA),
// unlocked by mocking the model discovery endpoint. connect() → refreshModels() fetches `/api/tags`; we
// fulfill it with a fake model list, so clicking "Connect" flips the app into its chat shell. This is how
// the composer, header, and settings surfaces become testable without a backend.
import { test, expect, type Page } from "@playwright/test";

// Fake a reachable Ollama with one chat model, then connect through the gate.
async function connect(page: Page) {
  await page.route("**/api/tags", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [{ name: "llama3.2" }] }) }));
  await page.getByRole("button", { name: /connect to your machine/i }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // skip the first-run overlay so it can't race the connect button
    localStorage.setItem("automo.profile", JSON.stringify({ onboarded: true }));
    // point the model URL at the test's OWN origin so /api/tags is same-origin — avoids the cross-address
    // Local-Network-Access preflight that a headless CI browser blocks (and that page.route can't fulfill)
    localStorage.setItem("automo.url", location.origin);
  });
  await page.goto("/");
});

test("connecting reveals the chat composer and hides the gate", async ({ page }) => {
  await connect(page);
  // the composer only renders once connected
  await expect(page.getByPlaceholder("Ask anything…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  // the connect gate is gone
  await expect(page.getByRole("heading", { name: "Connect to your machine" })).toBeHidden();
});

test("the composer accepts input", async ({ page }) => {
  await connect(page);
  const box = page.getByPlaceholder("Ask anything…");
  await box.fill("hello automo");
  await expect(box).toHaveValue("hello automo");
});

test("settings drawer opens from the header", async ({ page }) => {
  await connect(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".drawer, .settings, [class*='drawer']").first()).toBeVisible();
});
